// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import {
  queryP_readOnly as pgQueryP_readOnly,
  stream_queryP_readOnly as stream_pgQueryP_readOnly,
} from "../db/pg-query";
import { getZinvite, getZidForRid } from "../utils/zinvite";
import { getPca } from "../utils/pca";
import fail from "../utils/fail";
import logger from "../utils/logger";

type Formatters<T> = Record<string, (row: T) => string>;
const sep = "\n";

function formatCSVHeaders<T>(colFns: Formatters<T>) {
  return Object.keys(colFns).join(",");
}

function formatCSVRow<T>(row: T, colFns: Formatters<T>) {
  const fns = Object.values(colFns);
  let csv = "";
  for (let ii = 0; ii < fns.length; ii += 1) {
    if (ii > 0) csv += ",";
    csv += fns[ii](row);
  }
  return csv;
}

function formatCSV<T>(colFns: Formatters<T>, rows: T[]): string {
  let csv = formatCSVHeaders(colFns) + sep;
  if (rows.length > 0) {
    for (const row of rows) {
      csv += formatCSVRow(row, colFns);
      csv += sep;
    }
  }
  return csv;
}

async function loadConversationSummary(zid: number, siteUrl: string) {
  const [zinvite, convoRows, commentersRow, pca] = await Promise.all([
    getZinvite(zid),
    pgQueryP_readOnly(
      `SELECT topic, description FROM conversations WHERE zid = $1`,
      [zid]
    ),
    pgQueryP_readOnly(
      `SELECT COUNT(DISTINCT pid) FROM comments WHERE zid = $1`,
      [zid]
    ),
    getPca(zid),
  ]);
  if (!zinvite || !convoRows || !commentersRow || !pca) {
    throw new Error("polis_error_data_unknown_report");
  }

  const convo = (convoRows as { topic: string; description: string }[])[0];
  const commenters = (commentersRow as { count: number }[])[0].count;

  type PcaData = {
    "in-conv": number[];
    "user-vote-counts": Record<number, number>;
    "group-clusters": Record<number, object>;
    "n-cmts": number;
  };
  const data = pca.asPOJO as PcaData;

  const escapeQuotes = (s: string) => s.replace(/"/g, '""');
  return [
    ["topic", `"${escapeQuotes(convo.topic)}"`],
    ["url", `${siteUrl}/${zinvite}`],
    ["voters", Object.keys(data["user-vote-counts"]).length],
    ["voters-in-conv", data["in-conv"].length],
    ["commenters", commenters],
    ["comments", data["n-cmts"]],
    ["groups", Object.keys(data["group-clusters"]).length],
    ["conversation-description", `"${escapeQuotes(convo.description)}"`],
  ].map((row) => row.join(","));
}

const formatDatetime = (timestamp: string) =>
  new Date(parseInt(timestamp)).toString();

type Response = {
  setHeader: (key: string, value: string) => void;
  send: (data: string) => void;
  write: (data: string) => void;
  end: () => void;
};

async function sendConversationSummary(
  zid: number,
  siteUrl: string,
  res: Response
) {
  const rows = await loadConversationSummary(zid, siteUrl);
  res.setHeader("content-type", "text/csv");
  res.send(rows.join(sep));
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
};

async function sendCommentSummary(zid: number, res: Response) {
  const comments = new Map<number, CommentRow>();

  try {
    // First query: Load comments metadata
    const commentRows = (await pgQueryP_readOnly(
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
    stream_pgQueryP_readOnly(
      "SELECT tid, vote FROM votes WHERE zid = ($1) ORDER BY tid",
      [zid],
      (row) => {
        const comment = comments.get(row.tid);
        if (comment) {
          if (row.vote === 1) comment.agrees += 1;
          else if (row.vote === -1) comment.disagrees += 1;
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
              "comment-body": (row) => String(row.txt),
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
    fail(res, 500, "polis_err_data_export", err);
  }
}

async function sendVotesSummary(zid: number, res: Response) {
  const formatters: Formatters<any> = {
    timestamp: (row) => String(Math.floor(row.timestamp / 1000)),
    datetime: (row) => formatDatetime(row.timestamp),
    "comment-id": (row) => String(row.tid),
    "voter-id": (row) => String(row.pid),
    vote: (row) => String(row.vote),
  };
  res.setHeader("Content-Type", "text/csv");
  res.write(formatCSVHeaders(formatters) + sep);

  stream_pgQueryP_readOnly(
    "SELECT created as timestamp, tid, pid, vote FROM votes WHERE zid = $1 ORDER BY tid, pid",
    [zid],
    (row) => res.write(formatCSVRow(row, formatters) + sep),
    () => res.end(),
    (error) => {
      // Handle any errors
      logger.error("polis_err_report_votes_csv", error);
      fail(res, 500, "polis_err_data_export", error);
    }
  );
}

async function sendParticipantVotesSummary(zid: number, res: Response) {
  // Load up the comment ids
  const commentRows = (await pgQueryP_readOnly(
    "SELECT tid, pid FROM comments WHERE zid = ($1) ORDER BY tid ASC, created ASC", // TODO: filter only active comments?
    [zid]
  )) as { tid: number; pid: number }[];
  const commentIds = commentRows.map((row) => row.tid);
  const participantCommentCounts = new Map<number, number>();
  for (const row of commentRows) {
    const count = participantCommentCounts.get(row.pid) || 0;
    participantCommentCounts.set(row.pid, count + 1);
  }

  const pca = await getPca(zid);
  const groupClusters: { id: number; members: number[] }[] | undefined =
    pca?.asPOJO["group-clusters"];
  function getGroupId(pid: number) {
    if (groupClusters) {
      for (const group of groupClusters) {
        if (group.members.includes(pid)) {
          return group.id;
        }
      }
    }
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
      getGroupId(currentParticipantId),
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

  stream_pgQueryP_readOnly(
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

      const tid: number = row.tid;
      const vote: number = row.vote;
      currentParticipantVotes.set(tid, vote);
    },
    () => {
      if (currentParticipantId != -1) {
        sendCurrentParticipantRow();
      }
      res.end();
    },
    (error) => {
      logger.error("polis_err_report_participant_votes", error);
      fail(res, 500, "polis_err_data_export", error);
    }
  );
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
      fail(res, 404, "polis_error_data_unknown_report");
      return;
    }

    switch (report_type) {
      case "summary.csv":
        const siteUrl = `${req.headers["x-forwarded-proto"]}://${req.headers.host}`;
        await sendConversationSummary(zid, siteUrl, res);
        break;

      case "comments.csv":
        await sendCommentSummary(zid, res);
        break;

      case "votes.csv":
        await sendVotesSummary(zid, res);
        break;

      case "participant-votes.csv":
        await sendParticipantVotesSummary(zid, res);
        break;

      default:
        fail(res, 404, "polis_error_data_unknown_report");
        break;
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_data_export";
    fail(res, 500, msg, err);
  }
}
