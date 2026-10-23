import _ from "underscore";
import LruCache from "lru-cache";
import { resultClient } from "./utils/delphiResults";
import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { GetCommentsParams } from "./d";
import {
  CommentPriorities,
  commentPrioritiesGeneration,
  getLatestCommentPriorities,
} from "./utils/pca";
import Config from "./config";
import logger from "./utils/logger";
import pg from "./db/pg-query";
import {
  CommentRow,
  CommentTranslationRow,
  countEligibleComments,
  getComments,
  getNumberOfCommentsRemaining,
  translateAndStoreComment,
} from "./comment";
import { getCommentIdsForClusters } from "./utils/commentClusters";

// DynamoDB client for topic agenda lookups
const dynamoDBConfig: DynamoDBClientConfig = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  // Local/test DynamoDB
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - endpoint is allowed on the client config at runtime
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
}
if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  dynamoDBConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}

const dynamoDocClient = resultClient(() => DynamoDBDocumentClient.from(new DynamoDBClient(dynamoDBConfig), {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
}));
const DELPHI_TOPIC_NAMES_TABLE = "Delphi_CommentClustersLLMTopicNames";

// The priority lottery's window: the first 999 eligible statements by
// creation, which is `_getCommentsList`'s default LIMIT (comment.ts).
const LOTTERY_WINDOW = 999;

/** Which way getNextComment chose the statement it served. */
type ServeBranch =
  | "epsilon"
  | "priority"
  | "topical"
  | "priority_after_topical_fallback"
  | "priority_after_topical_error"
  | "priority_after_epsilon_miss"
  | "initial";

/**
 * What one next-statement choice used, for its comment_serve_log row
 * (PROPENSITY-LOGGING-DESIGN.md section 5). Filled in by the path that chose.
 */
type ServeRecord = {
  branch: ServeBranch;
  priorities?: CommentPriorities;
  poolSize: number; // lottery window size (<= 999)
  eligibleCount: number | null; // uncapped m; null when unknown
  weight: number | null; // served tid's lottery weight; null outside the window
  weightSum: number | null;
  randomN: number | null; // the lottery draw, priority branches only
  topicalPoolSize: number | null;
};

type Routing = {
  epsilon: number | null; // ROUTING_EPSILON in force; null when off
  uniform: boolean; // this request takes the ε branch
  serve: ServeRecord;
};

function newServeRecord(branch: ServeBranch): ServeRecord {
  return {
    branch,
    poolSize: 0,
    eligibleCount: null,
    weight: null,
    weightSum: null,
    randomN: null,
    topicalPoolSize: null,
  };
}

// ROUTING_EPSILON, through an optional reader: a Config without it (the
// routing characterization harness's stand-in) leaves the arm off.
function routingEpsilon(): number | null {
  const read = (Config as { getValidRoutingEpsilon?: () => number | null })
    .getValidRoutingEpsilon;
  return typeof read === "function" ? read() : null;
}

/**
 * The probability that this request serves a given statement
 * (PROPENSITY-LOGGING-DESIGN.md section 4):
 *
 *   π = ε · 1/m + (1 − ε) · (1 − r) · [tid ∈ window] · w_tid / Σ_window w
 *
 * with ε the ε-arm probability (null = 0), r the probability that this
 * participant's request leaves the lottery for a topical serve (null = 0),
 * m the eligible count, and w the lottery weights over the 999-statement
 * window. `null` when it cannot be computed: ε > 0 without m, or a lottery
 * share with no positive weight sum.
 *
 * r is not TOPICAL_COMMENT_RATIO: when the topical path falls back (no agenda,
 * or its pool exhausted) both coins end in the lottery and r is 0. The serve
 * log therefore passes r = 0 and leaves π NULL wherever r is unknown (see
 * servePropensity).
 */
export function routingPropensity(o: {
  epsilon: number | null;
  topicalRatio: number | null;
  m: number | null;
  inWindow: boolean;
  weight: number | null;
  weightSum: number | null;
}): number | null {
  const epsilon = o.epsilon ?? 0;
  const ratio = o.topicalRatio ?? 0;
  let uniformShare = 0;
  if (epsilon > 0) {
    if (o.m === null || !(o.m > 0)) return null;
    uniformShare = epsilon / o.m;
  }
  let lotteryShare = 0;
  if (epsilon < 1 && o.inWindow) {
    if (o.weight === null || o.weightSum === null || !(o.weightSum > 0)) {
      return null;
    }
    lotteryShare = (1 - epsilon) * (1 - ratio) * (o.weight / o.weightSum);
  }
  return uniformShare + lotteryShare;
}

// This very much follows the outline of the random selection above, but factors out the probabilistic logic
// to the selectProbabilistically fn above.
async function getNextPrioritizedComment(
  zid: number,
  pid: number,
  withoutTids?: Array<number | string>,
  routing?: Routing
): Promise<GetCommentsParams | null> {
  const params: Partial<GetCommentsParams> = {
    zid,
    not_voted_by_pid: pid,
  };
  if (Array.isArray(withoutTids) && withoutTids.length > 0) {
    params.withoutTids = withoutTids;
  }
  // With the ε-arm on, m (the size of the whole eligible set) is counted with
  // the window query's own WHERE clause. The window query itself, LIMIT 999,
  // runs unchanged on every branch.
  const counted =
    routing !== undefined && routing.epsilon !== null && routing.epsilon > 0;

  logger.debug("polis_info_getNextPrioritizedComment", {
    zid,
    pid,
    withoutTids,
  });

  const [comments, latestPriorities, remainingRows, eligibleCount] =
    (await Promise.all([
      getComments(params as GetCommentsParams),
      // The latest committed generation's priorities, NOT `getPca(zid, 0)`. A
      // literal 0 asks for something strictly newer than generation 0, and
      // generation 0 is a conversation's real first generation, so the old call
      // silently threw away its `comment-priorities` and fell back to
      // unprioritized routing for the whole first-generation window.
      //
      // Only the map is read: never the whole math result, which a new
      // generation would otherwise make this request read, normalize and
      // compress. No math row still costs a single query and gives undefined.
      getLatestCommentPriorities(zid),
      getNumberOfCommentsRemaining(zid, pid),
      counted ? countEligibleComments(params as GetCommentsParams) : null,
    ])) as [
      CommentRow[],
      CommentPriorities | undefined,
      Array<{ total: number; remaining: number }>,
      number | null
    ];

  const serve = routing?.serve;
  if (serve) {
    // A later attempt (the topical fallback) replaces an earlier one's draw.
    Object.assign(serve, {
      priorities: latestPriorities,
      poolSize: 0,
      // Uncounted, a full window hides how many more are eligible.
      eligibleCount: counted
        ? eligibleCount
        : !comments || comments.length < LOTTERY_WINDOW
        ? comments?.length ?? 0
        : null,
      weight: null,
      weightSum: null,
      randomN: null,
    });
  }

  if (!comments || comments.length === 0) {
    return null;
  }
  if (!remainingRows || remainingRows.length === 0) {
    throw new Error(`polis_err_getNumberOfCommentsRemaining_${zid}_${pid}`);
  }

  const commentPriorities = latestPriorities || {};

  const totalCount = Number(remainingRows[0].total);
  const remainingCount = Number(remainingRows[0].remaining);

  const lottery = lotteryOf(comments, commentPriorities);
  const drawn = routing?.uniform
    ? await drawUniformEligible(params as GetCommentsParams, eligibleCount)
    : undefined;
  if (routing?.uniform && !drawn && serve) {
    // The row at the drawn position was gone (moderated or voted between the
    // count and the read): served by the lottery, labelled so it can be dropped.
    serve.branch = "priority_after_epsilon_miss";
  }
  const selectedRow = (drawn ??
    selectProbabilistically(lottery)) as unknown as GetCommentsParams;
  selectedRow.remaining = remainingCount;
  selectedRow.total = totalCount;
  if (serve) {
    serve.poolSize = lottery.lookup.length;
    serve.weightSum = lottery.lastCount;
    // null when the served statement is not in the window.
    serve.weight = lotteryWeight(lottery, selectedRow.tid);
    serve.randomN = drawn
      ? null
      : (selectedRow as { randomN?: number }).randomN ?? null;
  }
  return selectedRow;
}

/**
 * The ε branch: the statement at position k = floor(r * m) of the eligible
 * set, read with the window query's own filters and order (LIMIT 1 OFFSET k).
 * Uniform over the m statements whatever the order, so ties on `created` do
 * not matter. undefined when there is nothing to draw from or the row at k is
 * gone.
 */
async function drawUniformEligible(
  params: GetCommentsParams,
  m: number | null
): Promise<CommentRow | undefined> {
  if (m === null || !(m > 0)) return undefined;
  const k = Math.floor(Math.random() * m);
  const rows = await getComments({ ...params, limit: 1, offset: k });
  return rows && rows.length ? rows[0] : undefined;
}

// A preferred tid is never trusted for visibility or vote eligibility. A newer
// math generation must not displace an eligible statement already being read.
export async function checkInitialComment(
  zid: number,
  pid: number,
  tid: number,
  lang?: string,
  uid?: number
) {
  const voted =
    pid >= 0
      ? ((await pg.queryP(
          "select 1 from votes_latest_unique where zid = ($1) and pid = ($2) and tid = ($3) limit 1;",
          [zid, pid, tid]
        )) as unknown[])
      : [];
  if (voted.length) {
    return {
      status: "voted" as const,
      comment: await getNextComment(zid, pid, [], lang, uid),
    };
  }
  const rows = await getComments({ zid, tids: [tid], not_voted_by_pid: pid });
  const row = rows.find((row) => row.tid === tid);
  if (!row) return { status: "unavailable" as const, comment: null };
  const counts = await getNumberOfCommentsRemaining(zid, pid);
  if (!counts?.length) throw new Error("polis_err_initial_comment_counts");
  const comment = {
    ...row,
    remaining: Number(counts[0].remaining),
    total: Number(counts[0].total),
  } as GetCommentsParams;
  logInitialServe(zid, pid, uid, comment);
  await ensureTranslations(zid, comment, lang);
  return { status: "eligible" as const, comment };
}

type Lottery = { lastCount: number; lookup: Array<[number, CommentRow]> };

function lotteryOf(
  comments: CommentRow[],
  priorities: Record<string | number, number>
): Lottery {
  // Here we go through all of the comments we might select for the user and add their priority values
  return _.reduce(
    comments,
    (
      o: { lastCount: number; lookup: Array<[number, CommentRow]> },
      comment: CommentRow
    ) => {
      // If we like, we can use nTotal and nRemaining here to figure out how much we should emphasize the
      // priority, potentially. Maybe we end up with different classes of priorities lists for this purpose?
      // scaling this value in some way may also be helpful.
      const lookup_val = o.lastCount + (priorities[comment.tid] || 1);
      o.lookup.push([lookup_val, comment]);
      o.lastCount = lookup_val;
      return o;
    },
    { lastCount: 0, lookup: [] }
  );
}

// A statement's weight in the lottery, recovered from its cumulative bounds;
// null when it is not in the window.
function lotteryWeight(lottery: Lottery, tid: unknown): number | null {
  let previous = 0;
  for (const [cumulative, row] of lottery.lookup) {
    if (row.tid === tid) return cumulative - previous;
    previous = cumulative;
  }
  return null;
}

function selectProbabilistically(lookup: Lottery): CommentRow {
  // We arrange a random number that should fall somewhere in the range of the lookup_vals
  const randomN = Math.random() * lookup.lastCount;
  // Return the first one that has a greater lookup; could eventually replace this with something smarter
  // that does a bisectional lookup if performance becomes an issue. But I want to keep the implementation
  // simple to reason about all other things being equal.
  const result = _.find(
    lookup.lookup,
    (x: [number, CommentRow]) => x[0] > randomN
  );
  const c = result?.[1] as CommentRow;
  if (c) {
    c.randomN = randomN;
  }
  return c;
}

/**
 * Fetch the set of tids (comment ids) for a participant's current topic agenda.
 * - Reads the most recent topic agenda selections from PostgreSQL for the pid+zid pair
 * - Extracts unique topic_keys from the stored selections
 * - For each topic_key, queries DynamoDB table "Delphi_CommentClustersLLMTopicNames" to get layer_id and cluster_id
 * - Then queries "Delphi_CommentHierarchicalClusterAssignments" using the appropriate layerX_cluster_id column
 * - Returns a de-duplicated array of tids
 *
 * If there is no record or selections are empty, returns an empty array.
 * If all Dynamo lookups fail, throws an error.
 */
export async function getTidsForParticipantTopicAgenda(
  zid: number,
  pid: number
): Promise<number[]> {
  // Single row per (zid, pid) due to composite primary key
  const rows = (await pg.queryP(
    "SELECT archetypal_selections, delphi_job_id FROM topic_agenda_selections WHERE zid = ($1) AND pid = ($2) LIMIT 1;",
    [zid, pid]
  )) as Array<{
    archetypal_selections: unknown;
    delphi_job_id?: string | null;
  }>;

  if (!Array.isArray(rows) || rows.length === 0) {
    logger.debug("polis_debug_getTidsForParticipantTopicAgenda_no_rows", {
      pid,
      zid,
    });
    return [];
  }

  const record = rows[0];
  const selections =
    (record?.archetypal_selections as Array<{ topic_key?: string }>) || [];
  if (!Array.isArray(selections) || selections.length === 0) {
    logger.debug("polis_debug_getTidsForParticipantTopicAgenda_no_selections", {
      pid,
      zid,
    });
    return [];
  }

  const uniqueTopicKeys: string[] = Array.from(
    new Set(
      selections
        .map((s: { topic_key?: string }) => s?.topic_key)
        .filter(
          (k: unknown): k is string => typeof k === "string" && k.length > 0
        )
    )
  );

  if (uniqueTopicKeys.length === 0) {
    logger.warn(
      "polis_warn_getTidsForParticipantTopicAgenda_no_unique_topic_keys",
      { pid, zid }
    );
    return [];
  }

  const conversationZid = String(zid);

  // Step 1: Query Delphi_CommentClustersLLMTopicNames to get layer_id and cluster_id for each topic_key
  const topicQueries = uniqueTopicKeys.map((topicKey) =>
    dynamoDocClient.send(
      new QueryCommand({
        TableName: DELPHI_TOPIC_NAMES_TABLE,
        KeyConditionExpression: "conversation_id = :cid AND topic_key = :tk",
        ExpressionAttributeValues: {
          ":cid": conversationZid,
          ":tk": topicKey,
        },
      })
    )
  );

  const topicResults = await Promise.allSettled(topicQueries);

  // Collect layer_id/cluster_id pairs from topic lookup
  type ClusterInfo = {
    layer_id: number;
    cluster_id: number;
    topic_key: string;
  };
  const clusterInfos: ClusterInfo[] = [];

  topicResults.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      const items = result.value?.Items || [];
      for (const item of items) {
        // layer_id and cluster_id are stored as strings in DynamoDB
        const layer_id = Number(item?.layer_id);
        const cluster_id = Number(item?.cluster_id);
        if (!Number.isNaN(layer_id) && !Number.isNaN(cluster_id)) {
          clusterInfos.push({
            layer_id,
            cluster_id,
            topic_key: uniqueTopicKeys[idx],
          });
        }
      }
    } else {
      logger.error("polis_err_topic_names_dynamo_query_failed", {
        topicKey: uniqueTopicKeys[idx],
        error: result.reason,
      });
    }
  });

  if (clusterInfos.length === 0) {
    logger.warn("polis_warn_no_cluster_info_found", { zid, pid });
    return [];
  }

  // Step 2: Get comment IDs for all cluster specs using centralized utility
  // Use cache for better performance - stale data is acceptable for nextComment
  const tids = await getCommentIdsForClusters(
    zid,
    clusterInfos.map((info) => ({
      layerId: info.layer_id,
      clusterId: info.cluster_id,
    })),
    true // useCache = true for high-frequency nextComment requests
  );

  logger.debug("polis_info_getTidsForParticipantTopicAgenda_results", {
    zid,
    pid,
    tids,
    total_tids: tids.length,
  });

  return tids;
}

/**
 * Alternate next-comment pathway that respects a participant's topic agenda selections.
 * - Builds the pool of tids via getTidsForParticipantTopicAgenda
 * - Filters out comments the participant already voted on and moderated-out comments
 * - Picks one at random
 * - If no suitable comment is found, falls back to the traditional getNextComment
 */
export async function getNextTopicalComment(
  zid: number,
  pid: number,
  withoutTids?: Array<number | string>,
  routing?: Routing
): Promise<GetCommentsParams | null> {
  const fallback = (
    branch: ServeBranch = "priority_after_topical_fallback"
  ) => {
    if (routing) routing.serve.branch = branch;
    return getNextPrioritizedComment(zid, pid, withoutTids, routing);
  };
  try {
    const tids = await getTidsForParticipantTopicAgenda(zid, pid);
    if (routing) routing.serve.topicalPoolSize = tids ? tids.length : 0;
    if (!tids || tids.length === 0) {
      // No topical pool → fallback to traditional behavior
      logger.debug("polis_debug_next_topical_comment_no_tids", { pid, zid });
      return fallback();
    }

    // Use the shared comments query to apply moderation and not_voted_by_pid filters.
    const rows = await getComments({
      zid,
      not_voted_by_pid: pid,
      tids,
      withoutTids,
      random: true,
      limit: 1,
    } as unknown as GetCommentsParams);

    const r = rows && rows[0];
    if (!r) {
      // Pool exhausted or filtered out → fallback
      logger.debug("polis_debug_next_topical_comment_no_rows", { pid, zid });
      return fallback();
    }

    const comment: GetCommentsParams = {
      zid,
      tid: r.tid,
      txt: r.txt,
    };

    // Source language is internal metadata; preserve the topical response shape.
    Object.defineProperty(comment, "lang", { value: r.lang });
    if (routing) routing.serve.branch = "topical";
    return comment;
  } catch (err) {
    logger.error("polis_err_next_topical_comment", err);
    // Defensive: on any failure, fallback to traditional behavior
    return fallback("priority_after_topical_error");
  }
}

function getCommentTranslations(
  zid: number,
  tid: number
): Promise<CommentTranslationRow[]> {
  logger.debug("polis_debug_getCommentTranslations", { zid, tid });
  return pg.queryP(
    "select * from comment_translations where zid = ($1) and tid = ($2);",
    [zid, tid]
  ) as Promise<CommentTranslationRow[]>;
}

export async function getNextComment(
  zid?: number,
  pid?: number,
  withoutTids?: Array<number | string>,
  lang?: string,
  uid?: number
) {
  logger.debug("polis_debug_getNextComment", { zid, pid, withoutTids, lang });
  // The ε coin is drawn first, so the ε-slice is a uniform sample whatever
  // topical routing does. With the arm off (unset or 0) nothing is drawn.
  const epsilon = routingEpsilon();
  const useEpsilonArm =
    epsilon !== null && epsilon > 0 && Math.random() < epsilon;
  const ratio = Config.getValidTopicalRatio();
  const shouldUseTopical =
    !useEpsilonArm &&
    typeof ratio === "number" &&
    ratio > 0 &&
    Math.random() < ratio &&
    pid !== -1;

  logger.info("polis_info_getNextComment", {
    zid,
    pid,
    withoutTids,
    lang,
    shouldUseTopical,
    useEpsilonArm,
  });

  const routing: Routing = {
    epsilon,
    uniform: useEpsilonArm,
    serve: newServeRecord(
      useEpsilonArm ? "epsilon" : shouldUseTopical ? "topical" : "priority"
    ),
  };

  let next: GetCommentsParams | null = null;
  if (shouldUseTopical) {
    next = await getNextTopicalComment(zid!, pid!, withoutTids, routing);
  } else {
    next = await getNextPrioritizedComment(zid!, pid!, withoutTids, routing);
  }

  // If topical path yielded nothing, try prioritized as a fallback
  if (!next && shouldUseTopical) {
    logger.debug("polis_debug_next_topical_comment_no_rows_fallback", {
      pid,
      zid,
    });
    routing.serve.branch = "priority_after_topical_fallback";
    next = await getNextPrioritizedComment(zid!, pid!, withoutTids, routing);
  }

  logServe(zid!, pid!, uid, next, routing, ratio);

  if (!next) return next;

  await ensureTranslations(zid!, next, lang);

  return next;
}

const SERVE_LOG_INSERT =
  "insert into comment_serve_log (zid, pid, uid, tid, branch, epsilon, topical_ratio, math_env, math_tick, pool_size, eligible_count, weight, weight_sum, propensity, random_n, topical_pool_size) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);";

/**
 * The served statement's propensity for its serve-log row, or null where it is
 * not known at serve time:
 * - topical, topical-error and initial serves (no computable draw);
 * - the ε and priority branches while topical routing is on for this pid: the
 *   topical coin was not followed, so whether this participant has an agenda,
 *   and hence where that coin leads, is unknown.
 * A topical fallback (no agenda, or no row left in it) is deterministic given
 * the state: both coins end in the lottery, so r is 0. pid -1 is never routed
 * topically, so r is 0 for it too.
 */
function servePropensity(
  routing: Routing,
  pid: number,
  topicalRatio: number | null,
  tid: number | null
): number | null {
  const serve = routing.serve;
  if (tid === null) return null;
  switch (serve.branch) {
    case "topical":
    case "priority_after_topical_error":
    case "initial":
      return null;
    case "priority_after_topical_fallback":
      break;
    default:
      if (pid !== -1 && typeof topicalRatio === "number" && topicalRatio > 0) {
        return null;
      }
  }
  return routingPropensity({
    epsilon: routing.epsilon,
    topicalRatio: 0,
    m: serve.eligibleCount,
    inWindow: serve.weight !== null,
    weight: serve.weight,
    weightSum: serve.weightSum,
  });
}

/** The serve-log row for an eligible initial_tid (checkInitialComment). */
function logInitialServe(
  zid: number,
  pid: number,
  uid: number | undefined,
  comment: GetCommentsParams
): void {
  if (!Config.routingServeLog) return;
  try {
    logServe(
      zid,
      pid,
      uid,
      comment,
      {
        epsilon: routingEpsilon(),
        uniform: false,
        serve: newServeRecord("initial"),
      },
      Config.getValidTopicalRatio()
    );
  } catch (err) {
    logger.error("polis_err_comment_serve_log", err);
  }
}

/**
 * One comment_serve_log row for this choice, when ROUTING_SERVE_LOG is on.
 * Fire-and-forget: the insert is not awaited and its failure is only logged,
 * so it never delays or fails the response.
 */
function logServe(
  zid: number,
  pid: number,
  uid: number | undefined,
  next: GetCommentsParams | null,
  routing: Routing,
  topicalRatio: number | null
): void {
  if (!Config.routingServeLog) return;
  try {
    const serve = routing.serve;
    const tid = next ? next.tid ?? null : null;
    const generation = commentPrioritiesGeneration(serve.priorities);
    const propensity = servePropensity(routing, pid, topicalRatio, tid);
    // pid is NOT NULL in the log: an absent pid is recorded as anonymous.
    const loggedPid = Number.isFinite(Number(pid)) ? Number(pid) : -1;
    const loggedUid =
      typeof uid === "number" && Number.isFinite(uid) ? uid : null;
    pg.queryP(SERVE_LOG_INSERT, [
      zid,
      loggedPid,
      loggedUid,
      tid,
      serve.branch,
      routing.epsilon ?? 0,
      topicalRatio,
      generation ? generation.mathEnv : null,
      generation ? generation.mathTick : null,
      serve.poolSize,
      serve.eligibleCount,
      serve.weight,
      serve.weightSum,
      propensity,
      serve.randomN,
      serve.topicalPoolSize,
    ]).catch((err: unknown) => {
      logger.error("polis_err_comment_serve_log", err);
    });
  } catch (err) {
    logger.error("polis_err_comment_serve_log", err);
  }
}

// Best-effort translation must not hold either nextComment or participationInit.
// These bounded, process-local caches coalesce concurrent requests and suppress
// failures for ten minutes. Restart/eviction permits an earlier retry.
const translationFailures = new LruCache<string, boolean>({
  max: 10000,
  maxAge: 10 * 60 * 1000,
});
const translationsInFlight = new LruCache<
  string,
  Promise<CommentTranslationRow | null>
>({ max: 10000 });

function translateForNextComment(
  zid: number,
  next: GetCommentsParams,
  lang: string
): Promise<CommentTranslationRow | null> {
  const key = JSON.stringify([zid, next.tid, lang]);
  if (translationFailures.get(key)) return Promise.resolve(null);
  const pending = translationsInFlight.get(key);
  if (pending) return pending;

  const work = Promise.resolve()
    .then(() => translateAndStoreComment(zid, next.tid!, next.txt, lang))
    .catch(() => {
      // Translation/storage is optional; do not log provider payloads or text.
      logger.warn("polis_warn_next_comment_translation_failed");
      return null;
    })
    .then((translation) => {
      if (!translation) translationFailures.set(key, true);
      translationsInFlight.del(key);
      return translation;
    });
  translationsInFlight.set(key, work);
  return work;
}

async function ensureTranslations(
  zid: number,
  next: GetCommentsParams & { translations?: CommentTranslationRow[] },
  lang?: string
): Promise<void> {
  if (!lang) {
    if (typeof next.translations === "undefined") {
      next.translations = [];
    }
    return;
  }

  const firstTwo = lang.slice(0, 2).toLowerCase();
  let available: CommentTranslationRow[] = [];
  const work = (async () => {
    available = await getCommentTranslations(zid, next.tid!);
    const sameLanguage =
      (next as GetCommentsParams & { lang?: string }).lang
        ?.slice(0, 2)
        .toLowerCase() === firstTwo;
    const hasMatch = available.some((t) =>
      t.lang.toLowerCase().startsWith(firstTwo)
    );
    if (!sameLanguage && !hasMatch) {
      const translation = await translateForNextComment(zid, next, lang);
      if (translation) return [...available, translation];
    }
    return available;
  })().catch(() => {
    logger.warn("polis_warn_next_comment_translations_unavailable");
    return available;
  });

  let timer: ReturnType<typeof setTimeout>;
  try {
    next.translations = await Promise.race([
      work,
      new Promise<CommentTranslationRow[]>((resolve) => {
        timer = setTimeout(() => resolve(available), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // work keeps running and stores successful translations for the next request.
  // It never mutates the returned comment after this response budget expires.
}
