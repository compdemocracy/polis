import pg from "./db/pg-query";
import { getZinvite } from "./utils/zinvite";
import { getXids } from "./routes/xids";
import { getPca } from "./utils/pca";
import { failJson } from "./utils/fail";
import logger from "./utils/logger";
import { getCommentsWithClusters } from "./utils/commentClusters";
import type { XidRecord } from "./d";

type Formatters<T> = Record<string, (row: T) => string>;

interface ResponseLike {
  setHeader: (key: string, value: string) => void;
  send: (data: string) => void;
  write: (data: string) => void;
  end: () => void;
}

type CommentRow = {
  tid: number;
  pid: number;
  created: string;
  txt: string;
  mod: number;
  velocity: number;
  active: boolean;
  agrees: number;
  disagrees: number;
  pass: number;
  importance?: number;
};

type CommentGroupStats = {
  tid: number;
  txt: string;
  total_votes: number;
  total_agrees: number;
  total_disagrees: number;
  total_passes: number;
  group_stats: Record<
    number,
    {
      votes: number;
      agrees: number;
      disagrees: number;
      passes: number;
    }
  >;
};

type GroupVoteStats = {
  votes: Record<
    number,
    {
      A: number; // agrees
      D: number; // disagrees
      S: number; // sum of all votes (agrees + disagrees + passes)
    }
  >;
};

// Updated PcaData type to better reflect the actual structure
type PcaBaseData = {
  "in-conv": number[];
  "user-vote-counts": Record<string, number>;
  "group-clusters": Array<{
    id: number;
    center: number[];
    members: number[]; // These are base cluster IDs, not participant IDs
  }>;
  "base-clusters": {
    x: number[];
    y: number[];
    id: number[];
    count: number[];
    members: number[][]; // Array of arrays, each inner array contains participant IDs
  };
  "n-cmts": number;
  pca: {
    comps: number[][];
    center: number[];
    "comment-extremity": number[];
    "comment-projection": any;
  };
  [key: string]: any;
};

const sep = "\n";

const formatEscapedText = (s: string) => `"${s.replace(/"/g, '""')}"`;

type ParticipantExportContext = {
  commentIds: number[];
  commentIdSet: Set<number>;
  participantCommentCounts: Map<number, number>;
  getGroupId: (pid: number) => number | undefined;
};

function createGroupIdResolver(
  pcaData: PcaBaseData | undefined,
  zid: number
): (pid: number) => number | undefined {
  if (!pcaData) {
    return () => undefined;
  }

  const inConv = Array.isArray(pcaData["in-conv"]) ? pcaData["in-conv"] : [];

  const baseClusters = pcaData["base-clusters"];
  const groupClusters = pcaData["group-clusters"];

  if (
    !baseClusters ||
    !Array.isArray(baseClusters.members) ||
    !Array.isArray(baseClusters.id)
  ) {
    logger.warn(`Incomplete base-clusters data in PCA for zid ${zid}.`);
    return () => undefined;
  }

  const membersByIndex = baseClusters.members;
  const baseClusterIds = baseClusters.id;
  const groupClustersArray = Array.isArray(groupClusters) ? groupClusters : [];

  if (groupClustersArray.length === 0) {
    logger.warn(
      `No group-clusters array found or empty in PCA data for zid ${zid}.`
    );
    return () => undefined;
  }

  return (pid: number) => {
    if (!inConv.includes(pid)) {
      return undefined;
    }

    let baseClusterIndex = -1;
    for (let i = 0; i < membersByIndex.length; i += 1) {
      const members = membersByIndex[i];
      if (Array.isArray(members) && members.includes(pid)) {
        baseClusterIndex = i;
        break;
      }
    }

    if (baseClusterIndex === -1) {
      logger.info(
        `Participant ${pid} (in-conv) not found in any base-cluster's members list for zid ${zid}.`
      );
      return undefined;
    }

    if (baseClusterIndex >= baseClusterIds.length) {
      logger.warn(
        `Base cluster index ${baseClusterIndex} is out of bounds for baseClusters.id array (length ${baseClusterIds.length}) for pid ${pid} (zid ${zid}).`
      );
      return undefined;
    }

    const baseClusterId = baseClusterIds[baseClusterIndex];
    for (const groupCluster of groupClustersArray) {
      if (
        groupCluster?.members &&
        Array.isArray(groupCluster.members) &&
        groupCluster.members.includes(baseClusterId)
      ) {
        return groupCluster.id;
      }
    }

    logger.info(
      `Participant ${pid} in base_cluster_id ${baseClusterId}, but this base_cluster_id was not found in any group_cluster.members list for zid ${zid}.`
    );
    return undefined;
  };
}

async function loadParticipantExportContext(
  zid: number
): Promise<ParticipantExportContext> {
  const [commentRowsRaw, pca] = await Promise.all([
    pg.queryP_readOnly(
      "SELECT tid, pid FROM comments WHERE zid = ($1) ORDER BY tid ASC, created ASC",
      [zid]
    ),
    getPca(zid),
  ]);

  const commentRows = (commentRowsRaw as { tid: number; pid: number }[]) || [];

  const commentIds = commentRows.map((row) => row.tid);
  const commentIdSet = new Set(commentIds);
  const participantCommentCounts = new Map<number, number>();
  for (const row of commentRows) {
    const count = participantCommentCounts.get(row.pid) || 0;
    participantCommentCounts.set(row.pid, count + 1);
  }

  const pcaData = (pca as { asPOJO: PcaBaseData } | undefined)?.asPOJO;

  return {
    commentIds,
    commentIdSet,
    participantCommentCounts,
    getGroupId: createGroupIdResolver(pcaData, zid),
  };
}

export function formatCSVHeaders<T>(colFns: Formatters<T>) {
  return Object.keys(colFns).join(",");
}

export function formatCSVRow<T>(row: T, colFns: Formatters<T>) {
  const fns = Object.values(colFns);
  let csv = "";
  for (let ii = 0; ii < fns.length; ii += 1) {
    if (ii > 0) csv += ",";
    csv += fns[ii](row);
  }
  return csv;
}

export function formatCSV<T>(colFns: Formatters<T>, rows: T[]): string {
  let csv = formatCSVHeaders(colFns) + sep;
  if (rows.length > 0) {
    for (const row of rows) {
      csv += formatCSVRow(row, colFns);
      csv += sep;
    }
  }
  return csv;
}

export async function loadConversationSummary(zid: number, siteUrl: string) {
  const [zinvite, convoRows, commentersRow, pca] = await Promise.all([
    getZinvite(zid),
    pg.queryP_readOnly(
      `SELECT topic, description FROM conversations WHERE zid = $1`,
      [zid]
    ),
    pg.queryP_readOnly(
      `SELECT COUNT(DISTINCT pid) FROM comments WHERE zid = $1`,
      [zid]
    ),
    getPca(zid),
    // getPca(zid, -1),
  ]);
  if (!zinvite || !convoRows || !commentersRow || !pca) {
    throw new Error("polis_error_data_unknown_report");
  }

  const convo = (convoRows as { topic: string; description: string }[])[0];
  const commenters = (commentersRow as { count: number }[])[0].count;

  const data = pca.asPOJO as PcaBaseData;

  // Handle incomplete PCA data gracefully
  const userVoteCounts = data["user-vote-counts"] || {};
  const inConv = data["in-conv"] || [];
  const nCmts = data["n-cmts"] || 0;
  const groupClusters = data["group-clusters"] || [];

  return [
    ["topic", formatEscapedText(convo.topic)],
    ["url", `${siteUrl}/${zinvite}`],
    ["voters", Object.keys(userVoteCounts).length],
    ["voters-in-conv", inConv.length],
    ["commenters", commenters],
    ["comments", nCmts],
    [
      "groups",
      Array.isArray(groupClusters)
        ? groupClusters.length
        : Object.keys(groupClusters).length,
    ],
    ["conversation-description", formatEscapedText(convo.description)],
  ].map((row) => row.join(","));
}

export const formatDatetime = (timestamp: string) =>
  new Date(parseInt(timestamp)).toString();

export async function sendConversationSummary(
  zid: number,
  siteUrl: string,
  res: ResponseLike
) {
  const rows = await loadConversationSummary(zid, siteUrl);
  res.setHeader("content-type", "text/csv");
  res.send(rows.join(sep));
}

export async function sendCommentSummary(zid: number, res: ResponseLike) {
  const comments = new Map<number, CommentRow>();

  try {
    // Check if importance is enabled for this conversation
    const convRows = (await pg.queryP_readOnly(
      "SELECT importance_enabled FROM conversations WHERE zid = ($1)",
      [zid]
    )) as { importance_enabled: boolean }[];
    const importanceEnabled =
      convRows.length > 0 ? convRows[0].importance_enabled : false;

    // First query: Load comments metadata
    const commentRows = (await pg.queryP_readOnly(
      "SELECT tid, pid, created, txt, mod, velocity, active FROM comments WHERE zid = ($1)",
      [zid]
    )) as CommentRow[];
    for (const comment of commentRows) {
      comment.agrees = 0;
      comment.disagrees = 0;
      comment.pass = 0;
      if (importanceEnabled) {
        comment.importance = 0;
      }
      comments.set(comment.tid, comment);
    }

    // Second query: Count votes in a single pass
    pg.stream_queryP_readOnly(
      "SELECT tid, vote, high_priority FROM votes WHERE zid = ($1) ORDER BY tid",
      [zid],
      (row) => {
        const comment = comments.get(row.tid);
        if (comment) {
          // note that -1 means agree and 1 means disagree
          if (row.vote === -1) comment.agrees += 1;
          else if (row.vote === 1) comment.disagrees += 1;
          else if (row.vote === 0) comment.pass += 1;

          // Count high priority votes if enabled
          if (importanceEnabled && row.high_priority) {
            comment.importance = (comment.importance || 0) + 1;
          }
        } else {
          logger.warn(`Comment row not found for [zid=${zid}, tid=${row.tid}]`);
        }
      },
      () => {
        commentRows.sort((a, b) => {
          return b.velocity - a.velocity;
        });

        // Build formatters conditionally based on importance_enabled
        const formatters: Formatters<CommentRow> = {
          timestamp: (row) => String(Math.floor(parseInt(row.created) / 1000)),
          datetime: (row) => formatDatetime(row.created),
          "comment-id": (row) => String(row.tid),
          "author-id": (row) => String(row.pid),
          agrees: (row) => String(row.agrees),
          disagrees: (row) => String(row.disagrees),
          moderated: (row) => String(row.mod),
        };

        // Add importance column if enabled
        if (importanceEnabled) {
          formatters.importance = (row) => String(row.importance || 0);
        }

        // Add comment-body last
        formatters["comment-body"] = (row) => formatEscapedText(row.txt);

        res.setHeader("content-type", "text/csv");
        res.send(formatCSV(formatters, commentRows));
      },
      (error) => {
        logger.error("polis_err_report_comments", error);
      }
    );
  } catch (err) {
    logger.error("polis_err_report_comments", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}

export async function sendVotesSummary(zid: number, res: ResponseLike) {
  try {
    // Check if importance is enabled for this conversation
    const convRows = (await pg.queryP_readOnly(
      "SELECT importance_enabled FROM conversations WHERE zid = ($1)",
      [zid]
    )) as { importance_enabled: boolean }[];
    const importanceEnabled =
      convRows.length > 0 ? convRows[0].importance_enabled : false;

    // Build formatters conditionally based on importance_enabled
    const formatters: Formatters<any> = {
      timestamp: (row) => String(Math.floor(row.timestamp / 1000)),
      datetime: (row) => formatDatetime(row.timestamp),
      "comment-id": (row) => String(row.tid),
      "voter-id": (row) => String(row.pid),
      vote: (row) => String(-row.vote), // have to flip -1 to 1 and vice versa
    };

    // Add important column if enabled
    if (importanceEnabled) {
      formatters.important = (row) => String(row.high_priority ? 1 : 0);
    }

    res.setHeader("Content-Type", "text/csv");
    res.write(formatCSVHeaders(formatters) + sep);

    // Select high_priority field if importance is enabled
    const selectClause = importanceEnabled
      ? "SELECT created as timestamp, tid, pid, vote, high_priority FROM votes WHERE zid = $1 ORDER BY tid, pid"
      : "SELECT created as timestamp, tid, pid, vote FROM votes WHERE zid = $1 ORDER BY tid, pid";

    pg.stream_queryP_readOnly(
      selectClause,
      [zid],
      (row) => res.write(formatCSVRow(row, formatters) + sep),
      () => res.end(),
      (error) => {
        // Handle any errors
        logger.error("polis_err_report_votes_csv", error);
        failJson(res, 500, "polis_err_data_export", error);
      }
    );
  } catch (err) {
    logger.error("polis_err_report_votes", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}

export async function sendParticipantVotesSummary(
  zid: number,
  res: ResponseLike
) {
  const { commentIds, participantCommentCounts, getGroupId } =
    await loadParticipantExportContext(zid);

  res.setHeader("content-type", "text/csv");
  res.write(
    [
      "participant",
      "group-id",
      "n-comments",
      "n-votes",
      "n-agree",
      "n-disagree",
      ...commentIds,
    ].join(",") + sep
  );

  // Query the votes in participant order so that we can summarize them in a streaming pass
  let currentParticipantId = -1;
  const currentParticipantVotes = new Map<number, number>();

  const sendCurrentParticipantRow = () => {
    const totalVotes = currentParticipantVotes.size;
    let agrees = 0;
    let disagrees = 0;
    for (const vote of currentParticipantVotes.values()) {
      if (vote === 1) agrees += 1;
      else if (vote === -1) disagrees += 1;
    }
    const values = [
      currentParticipantId,
      getGroupId(currentParticipantId),
      participantCommentCounts.get(currentParticipantId) || 0,
      totalVotes,
      agrees,
      disagrees,
      ...commentIds.map((tid) => currentParticipantVotes.get(tid)),
    ];
    res.write(
      values
        .map((value) => (value === undefined ? "" : String(value)))
        .join(",") + sep
    );
  };

  pg.stream_queryP_readOnly(
    "SELECT pid, tid, vote FROM votes WHERE zid = ($1) ORDER BY pid, tid",
    [zid],
    (row) => {
      const pid: number = row.pid;
      if (pid != currentParticipantId) {
        if (currentParticipantId != -1) {
          sendCurrentParticipantRow();
        }
        currentParticipantId = pid;
        currentParticipantVotes.clear();
      }
      // have to flip vote from -1 to 1 and vice versa
      currentParticipantVotes.set(row.tid, -row.vote);
    },
    () => {
      if (currentParticipantId != -1) {
        sendCurrentParticipantRow();
      }
      res.end();
    },
    (error) => {
      logger.error("polis_err_report_participant_votes", error);
      failJson(res, 500, "polis_err_data_export", error);
    }
  );
}

export async function sendParticipantImportance(
  zid: number,
  res: ResponseLike
) {
  // Export participant importance data as CSV matrix
  // Columns: participant, group-id, n-comments, n-votes, n-important, [comment-id...]
  // Values in comment columns:
  //   "1" - participant voted on this comment with high_priority = true
  //   "0" - participant voted on this comment with high_priority = false
  //   "" (empty) - participant did not vote on this comment
  const { commentIds, commentIdSet, participantCommentCounts, getGroupId } =
    await loadParticipantExportContext(zid);

  res.setHeader("content-type", "text/csv");
  res.write(
    [
      "participant",
      "group-id",
      "n-comments",
      "n-votes",
      "n-important",
      ...commentIds,
    ].join(",") + sep
  );

  // Query the votes in participant order so that we can summarize them in a streaming pass
  let currentParticipantId = -1;
  const currentParticipantVotes = new Map<number, number>();
  const currentParticipantImportance = new Map<number, boolean>();
  const currentParticipantVotedComments = new Set<number>();

  const sendCurrentParticipantRow = () => {
    const totalVotes = currentParticipantVotes.size;
    let importantVotes = 0;
    for (const tid of currentParticipantVotedComments) {
      if (currentParticipantImportance.get(tid)) {
        importantVotes += 1;
      }
    }
    const values = [
      currentParticipantId,
      getGroupId(currentParticipantId),
      participantCommentCounts.get(currentParticipantId) || 0,
      totalVotes,
      importantVotes,
      ...commentIds.map((tid) => {
        if (currentParticipantVotedComments.has(tid)) {
          // Voted on this comment - show 1 if high priority, 0 if not
          return currentParticipantImportance.get(tid) ? "1" : "0";
        } else {
          // Did not vote on this comment - show blank
          return "";
        }
      }),
    ];
    res.write(
      values
        .map((value) => (value === undefined ? "" : String(value)))
        .join(",") + sep
    );
  };

  pg.stream_queryP_readOnly(
    "SELECT pid, tid, vote, high_priority FROM votes WHERE zid = ($1) ORDER BY pid, tid",
    [zid],
    (row) => {
      const pid: number = row.pid;
      if (pid != currentParticipantId) {
        if (currentParticipantId != -1) {
          sendCurrentParticipantRow();
        }
        currentParticipantId = pid;
        currentParticipantVotes.clear();
        currentParticipantImportance.clear();
        currentParticipantVotedComments.clear();
      }
      if (!commentIdSet.has(row.tid)) {
        return;
      }
      currentParticipantVotes.set(row.tid, -row.vote);
      currentParticipantImportance.set(row.tid, row.high_priority || false);
      currentParticipantVotedComments.add(row.tid);
    },
    () => {
      if (currentParticipantId != -1) {
        sendCurrentParticipantRow();
      }
      res.end();
    },
    (error) => {
      logger.error("polis_err_report_participant_importance", error);
      failJson(res, 500, "polis_err_data_export", error);
    }
  );
}

export async function sendCommentGroupsSummary(
  zid: number,
  res?: ResponseLike,
  http = true,
  filterFN?: (inp: {
    votes: number;
    agrees: number;
    disagrees: number;
    passes: number;
    group_aware_consensus?: number;
    comment_extremity?: number;
    comment_id: number;
    num_groups: number;
  }) => boolean
) {
  const csvText = [];
  // Get PCA data to identify groups and get groupVotes
  // const pca = await getPca(zid, -1);
  const pca = await getPca(zid);
  if (!pca?.asPOJO) {
    throw new Error("polis_error_no_pca_data");
  }

  const groupClusters = pca.asPOJO["group-clusters"];
  const groupIds = Array.isArray(groupClusters)
    ? groupClusters.map((g) => g.id)
    : Object.keys(groupClusters as Record<string, any>).map(Number);
  const numGroups = groupIds.length;
  const groupVotes = pca.asPOJO["group-votes"] as Record<
    number,
    GroupVoteStats
  >;
  const groupAwareConsensus = pca.asPOJO["group-aware-consensus"] as Record<
    number,
    number
  >;

  const commentExtremity =
    (pca.asPOJO["pca"]?.["comment-extremity"] as Array<number>) || [];

  // Load comment texts
  const commentRows = (await pg.queryP_readOnly(
    "SELECT tid, txt FROM comments WHERE zid = ($1)",
    [zid]
  )) as { tid: number; txt: string }[];
  const commentTexts = new Map(commentRows.map((row) => [row.tid, row.txt]));

  // Initialize stats map
  const commentStats = new Map<number, CommentGroupStats>();

  // Create a mapping of tid to extremity index using math tids array
  const tidToExtremityIndex = new Map();
  const mathTids = pca.asPOJO.tids || []; // Array of tids in same order as extremity values
  commentExtremity.forEach((extremity, index) => {
    const tid = mathTids[index];
    if (tid !== undefined) {
      tidToExtremityIndex.set(tid, index);
    }
  });

  // Process each group's votes
  for (const groupId of groupIds) {
    const groupVoteStats = groupVotes[groupId];
    if (!groupVoteStats?.votes) continue;

    // Process each comment's votes for this group
    for (const [tidStr, votes] of Object.entries(groupVoteStats.votes)) {
      const tid = parseInt(tidStr);

      // Initialize stats for this comment if we haven't seen it before
      if (!commentStats.has(tid)) {
        const groupStats: Record<
          number,
          { votes: number; agrees: number; disagrees: number; passes: number }
        > = {};
        for (const gid of groupIds) {
          groupStats[gid] = { votes: 0, agrees: 0, disagrees: 0, passes: 0 };
        }

        commentStats.set(tid, {
          tid: tid,
          txt: commentTexts.get(tid) || "",
          total_votes: 0,
          total_agrees: 0,
          total_disagrees: 0,
          total_passes: 0,
          group_stats: groupStats,
        });
      }

      // Get the stats object for this comment
      const stats = commentStats.get(tid);
      if (!stats) {
        logger.warn(`Comment stats not found for tid ${tid}`);
        continue;
      }
      const groupStats = stats.group_stats[groupId];

      // Update group stats
      groupStats.agrees = votes.A;
      groupStats.disagrees = votes.D;
      groupStats.votes = votes.S; // S is the total number of votes
      groupStats.passes = votes.S - (votes.A + votes.D); // Calculate passes from the sum
    }
  }

  // Calculate totals for each comment
  for (const stats of commentStats.values()) {
    stats.total_agrees = Object.values(stats.group_stats).reduce(
      (sum, g) => sum + g.agrees,
      0
    );
    stats.total_disagrees = Object.values(stats.group_stats).reduce(
      (sum, g) => sum + g.disagrees,
      0
    );
    stats.total_passes = Object.values(stats.group_stats).reduce(
      (sum, g) => sum + g.passes,
      0
    );
    stats.total_votes = Object.values(stats.group_stats).reduce(
      (sum, g) => sum + g.votes,
      0
    );
  }

  // Format and send CSV
  if (res && http) {
    res.setHeader("content-type", "text/csv");
  }

  // Create headers
  const headers = [
    "comment-id",
    "comment",
    "total-votes",
    "total-agrees",
    "total-disagrees",
    "total-passes",
  ];

  for (const groupId of groupIds) {
    const groupLetter = String.fromCharCode(97 + groupId); // 97 is 'a' in ASCII
    headers.push(
      `group-${groupLetter}-votes`,
      `group-${groupLetter}-agrees`,
      `group-${groupLetter}-disagrees`,
      `group-${groupLetter}-passes`
    );
  }
  if (http && res) {
    res.write(headers.join(",") + sep);
  } else {
    csvText.push(headers.join(",") + sep);
  }

  // Write data rows
  for (const stats of commentStats.values()) {
    const row = [
      stats.tid,
      formatEscapedText(stats.txt),
      stats.total_votes,
      stats.total_agrees,
      stats.total_disagrees,
      stats.total_passes,
    ];
    for (const groupId of groupIds) {
      const groupStats = stats.group_stats[groupId];
      row.push(
        groupStats.votes,
        groupStats.agrees,
        groupStats.disagrees,
        groupStats.passes
      );
    }
    const shouldIncludeRow =
      filterFN === undefined ||
      filterFN({
        votes: stats.total_votes,
        agrees: stats.total_agrees,
        disagrees: stats.total_disagrees,
        passes: stats.total_passes,
        group_aware_consensus: groupAwareConsensus[stats.tid],
        comment_extremity: commentExtremity[tidToExtremityIndex.get(stats.tid)],
        comment_id: stats.tid,
        num_groups: numGroups,
      }) === true;

    const rowString = row.join(",") + sep;

    if (shouldIncludeRow) {
      if (http && res) {
        res.write(rowString);
      } else {
        csvText.push(rowString);
      }
    }
  }

  if (http && res) {
    res.end();
  } else {
    return csvText.join("");
  }
}

export async function sendCommentClustersSummary(
  zid: number,
  res: ResponseLike
) {
  try {
    logger.info(`Generating comment-clusters export for zid ${zid}`);

    // Get comments with cluster assignments
    const comments = await getCommentsWithClusters(zid);

    if (comments.length === 0) {
      logger.warn(`No comments found for zid ${zid}`);
      res.setHeader("content-type", "text/csv");
      res.send("No comments found for this conversation");
      return;
    }

    // Dynamically determine which layers exist by scanning all comments
    // Note: We look at the KEYS (layer IDs like "0", "1", "2") not the VALUES
    // (cluster IDs which can be -1 for outliers, or 0+ for normal clusters)
    const layersFound = new Set<string>();
    for (const comment of comments) {
      Object.keys(comment.cluster_assignments).forEach((layerId) =>
        layersFound.add(layerId)
      );
      Object.keys(comment.distances).forEach((layerId) =>
        layersFound.add(layerId)
      );
      Object.keys(comment.confidences).forEach((layerId) =>
        layersFound.add(layerId)
      );
    }

    // Sort layers numerically
    const sortedLayers = Array.from(layersFound)
      .map(Number)
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b)
      .map(String);

    logger.info(
      `Found ${sortedLayers.length} layers: ${sortedLayers.join(", ")}`
    );

    // Build dynamic CSV headers
    const headers = ["comment-id", "moderated", "active"];

    // Add cluster ID columns for each layer
    sortedLayers.forEach((layer) => {
      headers.push(`layer${layer}-cluster-id`);
    });

    // Add distance columns for each layer
    sortedLayers.forEach((layer) => {
      headers.push(`layer${layer}-distance`);
    });

    // Add confidence columns for each layer
    sortedLayers.forEach((layer) => {
      headers.push(`layer${layer}-confidence`);
    });

    // Add comment body last
    headers.push("comment-body");

    res.setHeader("content-type", "text/csv");
    res.write(headers.join(",") + sep);

    // Write data rows
    for (const comment of comments) {
      const row: string[] = [
        String(comment.tid),
        String(comment.mod),
        String(comment.active ? 1 : 0),
      ];

      // Add cluster IDs for each layer
      // Note: cluster_id can be -1 (outlier), 0+, or missing (empty string)
      sortedLayers.forEach((layer) => {
        const clusterId = comment.cluster_assignments[layer];
        row.push(clusterId !== undefined ? String(clusterId) : "");
      });

      // Add distances for each layer
      sortedLayers.forEach((layer) => {
        const distance = comment.distances[layer];
        row.push(distance !== undefined ? distance.toFixed(4) : "");
      });

      // Add confidences for each layer
      sortedLayers.forEach((layer) => {
        const confidence = comment.confidences[layer];
        row.push(confidence !== undefined ? confidence.toFixed(4) : "");
      });

      // Add comment body
      row.push(formatEscapedText(comment.txt));

      res.write(row.join(",") + sep);
    }

    res.end();

    logger.info(
      `Successfully generated comment-clusters export for zid ${zid} with ${comments.length} comments and ${sortedLayers.length} layers`
    );
  } catch (err) {
    logger.error("polis_err_report_comment_clusters", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}

export async function sendParticipantXidsSummary(
  zid: number,
  res: ResponseLike
) {
  try {
    // const pca = await getPca(zid, -1);
    const pca = await getPca(zid);
    if (!pca?.asPOJO) {
      throw new Error("polis_error_no_pca_data");
    }

    const xids = await getXids(zid);
    if (!xids) {
      throw new Error("polis_error_no_xid_response");
    }

    // Filter to only records with pid (should always be present for participants)
    // and sort by pid
    const xidsWithPid = xids
      .filter((x): x is XidRecord & { pid: number } => x.pid !== undefined)
      .sort((a, b) => a.pid - b.pid);

    // Define formatters for the CSV columns
    const formatters: Formatters<{ pid: number; xid: string }> = {
      participant: (row) => String(row.pid),
      xid: (row) => formatEscapedText(row.xid),
    };

    // Generate and send the CSV
    res.setHeader("content-type", "text/csv");
    res.send(formatCSV(formatters, xidsWithPid));
  } catch (err) {
    logger.error("polis_err_report_participant_xids", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}
