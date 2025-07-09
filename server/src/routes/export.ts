// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import pg from "../db/pg-query";
import { getZinvite, getZidForRid, getZidForUuid } from "../utils/zinvite";
import { getXids } from "./math";
import { getPca } from "../utils/pca";
import { failJson } from "../utils/fail";
import logger from "../utils/logger";

type Formatters<T> = Record<string, (row: T) => string>;

type Response = {
  setHeader: (key: string, value: string) => void;
  send: (data: string) => void;
  write: (data: string) => void;
  end: () => void;
};

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
type PcaData = {
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

export const formatEscapedText = (s: string) => `"${s.replace(/"/g, '""')}"`;

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

  type PcaData = {
    "in-conv": number[];
    "user-vote-counts": Record<number, number>;
    "group-clusters":
      | Array<{ id: number; center: number[]; members: number[] }>
      | Record<number, object>;
    "n-cmts": number;
    [key: string]: any;
  };

  const data = pca.asPOJO as PcaData;

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
  res: Response
) {
  const rows = await loadConversationSummary(zid, siteUrl);
  res.setHeader("content-type", "text/csv");
  res.send(rows.join(sep));
}

export async function sendCommentSummary(zid: number, res: Response) {
  const comments = new Map<number, CommentRow>();

  try {
    // First query: Load comments metadata
    const commentRows = (await pg.queryP_readOnly(
      "SELECT tid, pid, created, txt, mod, velocity, active FROM comments WHERE zid = ($1)",
      [zid]
    )) as CommentRow[];
    for (const comment of commentRows) {
      comment.agrees = 0;
      comment.disagrees = 0;
      comment.pass = 0;
      comments.set(comment.tid, comment);
    }

    // Second query: Count votes in a single pass
    pg.stream_queryP_readOnly(
      "SELECT tid, vote FROM votes WHERE zid = ($1) ORDER BY tid",
      [zid],
      (row) => {
        const comment = comments.get(row.tid);
        if (comment) {
          // note that -1 means agree and 1 means disagree
          if (row.vote === -1) comment.agrees += 1;
          else if (row.vote === 1) comment.disagrees += 1;
          else if (row.vote === 0) comment.pass += 1;
        } else {
          logger.warn(`Comment row not found for [zid=${zid}, tid=${row.tid}]`);
        }
      },
      () => {
        commentRows.sort((a, b) => {
          return b.velocity - a.velocity;
        });

        res.setHeader("content-type", "text/csv");
        res.send(
          formatCSV(
            {
              timestamp: (row) =>
                String(Math.floor(parseInt(row.created) / 1000)),
              datetime: (row) => formatDatetime(row.created),
              "comment-id": (row) => String(row.tid),
              "author-id": (row) => String(row.pid),
              agrees: (row) => String(row.agrees),
              disagrees: (row) => String(row.disagrees),
              moderated: (row) => String(row.mod),
              "comment-body": (row) => formatEscapedText(row.txt),
            },
            commentRows
          )
        );
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

export async function sendVotesSummary(zid: number, res: Response) {
  const formatters: Formatters<any> = {
    timestamp: (row) => String(Math.floor(row.timestamp / 1000)),
    datetime: (row) => formatDatetime(row.timestamp),
    "comment-id": (row) => String(row.tid),
    "voter-id": (row) => String(row.pid),
    vote: (row) => String(-row.vote), // have to flip -1 to 1 and vice versa
  };
  res.setHeader("Content-Type", "text/csv");
  res.write(formatCSVHeaders(formatters) + sep);

  pg.stream_queryP_readOnly(
    "SELECT created as timestamp, tid, pid, vote FROM votes WHERE zid = $1 ORDER BY tid, pid",
    [zid],
    (row) => res.write(formatCSVRow(row, formatters) + sep),
    () => res.end(),
    (error) => {
      // Handle any errors
      logger.error("polis_err_report_votes_csv", error);
      failJson(res, 500, "polis_err_data_export", error);
    }
  );
}

export async function sendParticipantVotesSummary(zid: number, res: Response) {
  // Load up the comment ids
  const commentRows = (await pg.queryP_readOnly(
    "SELECT tid, pid FROM comments WHERE zid = ($1) ORDER BY tid ASC, created ASC", // TODO: filter only active comments?
    [zid]
  )) as { tid: number; pid: number }[];
  const commentIds = commentRows.map((row) => row.tid);
  const participantCommentCounts = new Map<number, number>();
  for (const row of commentRows) {
    const count = participantCommentCounts.get(row.pid) || 0;
    participantCommentCounts.set(row.pid, count + 1);
  }

  // const pca = await getPca(zid, -1);
  const pca = await getPca(zid);

  // Define the getGroupId function
  function getGroupId(
    pca: { asPOJO: PcaData } | undefined,
    pid: number
  ): number | undefined {
    if (!pca || !pca.asPOJO) {
      return undefined;
    }

    const pcaData = pca.asPOJO;

    // Check if participant is in the conversation
    const inConv = pcaData["in-conv"];
    if (!inConv || !Array.isArray(inConv) || !inConv.includes(pid)) {
      // Participant not in PCA, so legitimately has no group
      return undefined;
    }

    // Get the base clusters and group clusters
    const baseClusters = pcaData["base-clusters"];
    const groupClusters = pcaData["group-clusters"];

    if (
      !baseClusters ||
      !baseClusters.members ||
      !Array.isArray(baseClusters.members) ||
      !baseClusters.id ||
      !Array.isArray(baseClusters.id)
    ) {
      logger.warn(
        `Incomplete base-clusters data in PCA for zid while processing pid ${pid}.`
      );
      return undefined;
    }

    if (
      !groupClusters ||
      !Array.isArray(groupClusters) ||
      groupClusters.length === 0
    ) {
      logger.warn(
        `No group-clusters array found or empty in PCA data for zid while processing pid ${pid}.`
      );
      return undefined;
    }

    // Step 1: Find which base cluster (by index) contains the participant
    let baseClusterIndex = -1;
    for (let i = 0; i < baseClusters.members.length; i++) {
      const membersInBaseCluster = baseClusters.members[i];
      if (
        Array.isArray(membersInBaseCluster) &&
        membersInBaseCluster.includes(pid)
      ) {
        baseClusterIndex = i;
        break;
      }
    }

    if (baseClusterIndex === -1) {
      // Participant is "in-conv" but not found in any base cluster's member list.
      logger.info(
        `Participant ${pid} (in-conv) not found in any base-cluster's members list.`
      );
      return undefined;
    }

    // Retrieve the actual ID of the found base cluster
    if (baseClusterIndex >= baseClusters.id.length) {
      logger.warn(
        `Base cluster index ${baseClusterIndex} is out of bounds for baseClusters.id array (length ${baseClusters.id.length}) for pid ${pid}.`
      );
      return undefined;
    }
    const baseClusterId = baseClusters.id[baseClusterIndex];

    // Step 2: Find which group cluster contains this baseClusterId
    for (const groupCluster of groupClusters) {
      if (
        groupCluster.members &&
        Array.isArray(groupCluster.members) &&
        groupCluster.members.includes(baseClusterId)
      ) {
        return groupCluster.id;
      }
    }

    // Participant was in a base cluster, but that base cluster ID was not found in any group cluster's members list.
    logger.info(
      `Participant ${pid} in base_cluster_id ${baseClusterId}, but this base_cluster_id was not found in any group_cluster.members list.`
    );
    return undefined;
  }

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

  function sendCurrentParticipantRow() {
    let agrees = 0;
    let disagrees = 0;
    for (const vote of currentParticipantVotes.values()) {
      if (vote === 1) agrees += 1;
      else if (vote === -1) disagrees += 1;
    }
    const values = [
      currentParticipantId,
      getGroupId(pca, currentParticipantId),
      participantCommentCounts.get(currentParticipantId) || 0,
      currentParticipantVotes.size,
      agrees,
      disagrees,
      ...commentIds.map((tid) => currentParticipantVotes.get(tid)),
    ];
    res.write(
      values
        .map((value) => (value === undefined ? "" : String(value)))
        .join(",") + sep
    );
  }

  pg.stream_queryP_readOnly(
    "SELECT pid, tid, vote FROM votes WHERE zid = ($1) ORDER BY pid",
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

export async function sendCommentGroupsSummary(
  zid: number,
  res?: Response,
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

export async function sendParticipantXidsSummary(zid: number, res: Response) {
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

    // Sort xids by pid
    xids.sort((a, b) => a.pid - b.pid);

    // Define formatters for the CSV columns
    const formatters: Formatters<{ pid: number; xid: string }> = {
      participant: (row) => String(row.pid),
      xid: (row) => formatEscapedText(row.xid),
    };

    // Generate and send the CSV
    res.setHeader("content-type", "text/csv");
    res.send(formatCSV(formatters, xids));
  } catch (err) {
    logger.error("polis_err_report_participant_xids", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}

export async function handle_GET_reportExport(
  req: {
    p: { rid: string; report_type: string };
    headers: { host: string; "x-forwarded-proto": string };
  },
  res: Response
) {
  const { rid, report_type } = req.p;
  try {
    const zid = await getZidForRid(rid);
    if (!zid) {
      failJson(res, 404, "polis_error_data_unknown_report");
      return;
    }

    switch (report_type) {
      case "summary.csv": {
        const siteUrl = `${req.headers["x-forwarded-proto"]}://${req.headers.host}`;
        await sendConversationSummary(zid, siteUrl, res);
        break;
      }

      case "comments.csv":
        await sendCommentSummary(zid, res);
        break;

      case "votes.csv":
        await sendVotesSummary(zid, res);
        break;

      case "participant-votes.csv":
        await sendParticipantVotesSummary(zid, res);
        break;

      case "comment-groups.csv":
        await sendCommentGroupsSummary(zid, res);
        break;

      default:
        failJson(res, 404, "polis_error_data_unknown_report");
        break;
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_data_export";
    failJson(res, 500, msg, err);
  }
}

export async function handle_GET_xidReport(
  req: {
    p: { xid_report: string };
  },
  res: Response
) {
  const { xid_report } = req.p;
  // example xid_report: "51295d48-9422-4a58-90dd-8a6e32cd1b52-xid.csv"
  try {
    const uuid = xid_report.split("-xid.csv")[0];
    const zid = await getZidForUuid(uuid);
    if (zid != null) {
      await sendParticipantXidsSummary(zid, res);
    } else {
      failJson(res, 404, "polis_error_data_unknown_report");
    }
  } catch (err) {
    logger.error("polis_err_report_xid", err);
    failJson(res, 500, "polis_err_data_export", err);
  }
}
