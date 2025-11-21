import _ from "underscore";
import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { GetCommentsParams } from "./d";
import { getPca } from "./utils/pca";
import Config from "./config";
import logger from "./utils/logger";
import pg from "./db/pg-query";
import {
  CommentRow,
  CommentTranslationRow,
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
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  dynamoDBConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}

const dynamoClient = new DynamoDBClient(dynamoDBConfig);
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});
const DELPHI_TOPIC_NAMES_TABLE = "Delphi_CommentClustersLLMTopicNames";

// This very much follows the outline of the random selection above, but factors out the probabilistic logic
// to the selectProbabilistically fn above.
async function getNextPrioritizedComment(
  zid: number,
  pid: number,
  withoutTids?: Array<number | string>
): Promise<GetCommentsParams | null> {
  const params: Partial<GetCommentsParams> = {
    zid,
    not_voted_by_pid: pid,
  };
  if (Array.isArray(withoutTids) && withoutTids.length > 0) {
    params.withoutTids = withoutTids;
  }

  logger.debug("polis_info_getNextPrioritizedComment", {
    zid,
    pid,
    withoutTids,
  });

  const [comments, mathRaw, remainingRows] = (await Promise.all([
    getComments(params as GetCommentsParams),
    getPca(zid, 0),
    getNumberOfCommentsRemaining(zid, pid),
  ])) as [
    CommentRow[],
    { asPOJO?: Record<string, unknown> } | null,
    Array<{ total: number; remaining: number }>
  ];

  if (!comments || comments.length === 0) {
    return null;
  }
  if (!remainingRows || remainingRows.length === 0) {
    throw new Error(`polis_err_getNumberOfCommentsRemaining_${zid}_${pid}`);
  }

  const math = mathRaw || { asPOJO: {} };
  const commentPriorities =
    (math.asPOJO &&
      (math.asPOJO["comment-priorities"] as Record<string | number, number>)) ||
    {};

  const totalCount = Number(remainingRows[0].total);
  const remainingCount = Number(remainingRows[0].remaining);

  const selectedRow = selectProbabilistically(
    comments,
    commentPriorities
  ) as unknown as GetCommentsParams;
  selectedRow.remaining = remainingCount;
  selectedRow.total = totalCount;
  return selectedRow;
}

function selectProbabilistically(
  comments: CommentRow[],
  priorities: Record<string | number, number>
): CommentRow {
  // Here we go through all of the comments we might select for the user and add their priority values
  const lookup = _.reduce(
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
  withoutTids?: Array<number | string>
): Promise<GetCommentsParams | null> {
  try {
    const tids = await getTidsForParticipantTopicAgenda(zid, pid);
    if (!tids || tids.length === 0) {
      // No topical pool → fallback to traditional behavior
      logger.debug("polis_debug_next_topical_comment_no_tids", { pid, zid });
      return getNextPrioritizedComment(zid, pid, withoutTids);
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
      return getNextPrioritizedComment(zid, pid, withoutTids);
    }

    const comment: GetCommentsParams = {
      zid,
      tid: r.tid,
      txt: r.txt,
    };

    return comment;
  } catch (err) {
    logger.error("polis_err_next_topical_comment", err);
    // Defensive: on any failure, fallback to traditional behavior
    return getNextPrioritizedComment(zid, pid, withoutTids);
  }
}

function getCommentTranslations(
  zid: number,
  tid: number
): Promise<CommentTranslationRow[]> {
  return pg.queryP(
    "select * from comment_translations where zid = ($1) and tid = ($2);",
    [zid, tid]
  ) as Promise<CommentTranslationRow[]>;
}

export async function getNextComment(
  zid?: number,
  pid?: number,
  withoutTids?: Array<number | string>,
  lang?: string
) {
  const ratio = Config.getValidTopicalRatio();
  const shouldUseTopical =
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
  });

  let next: GetCommentsParams | null = null;
  if (shouldUseTopical) {
    next = await getNextTopicalComment(zid!, pid!, withoutTids);
  } else {
    next = await getNextPrioritizedComment(zid!, pid!, withoutTids);
  }

  // If topical path yielded nothing, try prioritized as a fallback
  if (!next && shouldUseTopical) {
    logger.debug("polis_debug_next_topical_comment_no_rows_fallback", {
      pid,
      zid,
    });
    next = await getNextPrioritizedComment(zid!, pid!, withoutTids);
  }

  if (!next) return next;

  await ensureTranslations(zid!, next, lang);

  return next;
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

  const firstTwo = lang.slice(0, 2);
  const translations = await getCommentTranslations(zid, next.tid!);
  next.translations = translations;

  const hasMatch = translations.some((t) => t.lang.startsWith(firstTwo));
  if (!hasMatch) {
    const translation = await translateAndStoreComment(
      zid,
      next.tid as number,
      next.txt,
      lang
    );
    if (translation) {
      next.translations.push(translation);
    }
  }
}
