import _ from "underscore";

import { ConversationInfo, PidReadyResult, RequestWithP } from "../d";
import { failJson } from "../utils/fail";
import { getNextComment } from "../nextComment";
import { getPid } from "../user";
import { isDuplicateKey, polisTypes } from "../utils/common";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import SQL from "../db/sql";
import {
  addNoMoreCommentsRecord,
  addStar,
  doFamousQuery,
  finishArray,
  finishOne,
  safeTimestampToMillis,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
  updateVoteCount,
} from "../server-helpers";

const sql_votes_latest_unique = SQL.sql_votes_latest_unique;

interface VoteResult {
  conv: ConversationInfo;
  vote: any;
}

interface VoteGetRequest {
  p: {
    pid?: number;
    tid?: number;
    uid?: number;
    zid: number;
  };
}

async function doVotesPost(
  uid?: number,
  pid?: number,
  conv?: ConversationInfo,
  tid?: number,
  voteType?: number,
  weight?: number,
  high_priority?: boolean
): Promise<VoteResult> {
  const zid = conv?.zid;
  weight = weight || 0;
  const weight_x_32767 = Math.trunc(weight * 32767); // weight is stored as a SMALLINT, so convert from a [-1,1] float to [-32767,32767] int

  return new Promise((resolve, reject) => {
    const query =
      "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, high_priority, created) VALUES ($1, $2, $3, $4, $5, $6, default) RETURNING *;";
    const params = [pid, zid, tid, voteType, weight_x_32767, high_priority];

    pg.query(query, params, function (err: any, result: { rows: any[] }) {
      if (err) {
        if (isDuplicateKey(err)) {
          reject("polis_err_vote_duplicate");
        } else {
          logger.error("polis_err_vote_other", err);
          reject("polis_err_vote_other");
        }
        return;
      }

      const vote = result.rows[0];
      resolve({
        conv: conv!,
        vote: vote,
      });
    });
  });
}

async function votesPost(
  uid?: number,
  pid?: number,
  zid?: number,
  tid?: number,
  voteType?: number,
  weight?: number,
  high_priority?: boolean
): Promise<VoteResult> {
  const rows = (await pg.queryP_readOnly(
    "select * from conversations where zid = ($1);",
    [zid]
  )) as ConversationInfo[];

  if (!rows || !rows.length) {
    throw "polis_err_unknown_conversation";
  }

  const conv = rows[0];
  if (!conv.is_active) {
    throw "polis_err_conversation_is_closed";
  }

  // Note: XID validation is handled by ensureParticipant middleware before this function is called

  return doVotesPost(uid, pid, conv, tid, voteType, weight, high_priority);
}

async function getVotesForSingleParticipant(p: {
  pid?: number;
  zid?: number;
  tid?: number;
}): Promise<any[]> {
  if (_.isUndefined(p.pid)) {
    return [];
  }
  return votesGet(p);
}

async function votesGet(p: {
  zid?: number;
  pid?: number;
  tid?: number;
}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    let q = sql_votes_latest_unique
      .select(sql_votes_latest_unique.star())
      .where(sql_votes_latest_unique.zid.equals(p.zid));

    if (!_.isUndefined(p.pid)) {
      q = q.where(sql_votes_latest_unique.pid.equals(p.pid));
    }
    if (!_.isUndefined(p.tid)) {
      q = q.where(sql_votes_latest_unique.tid.equals(p.tid));
    }

    pg.query_readOnly(
      q.toString(),
      function (err: any, results: { rows: any[] }) {
        if (err) {
          reject(err);
        } else {
          resolve(results.rows);
        }
      }
    );
  });
}

function handle_GET_votes_me(
  req: { p: { zid: number; uid?: number; pid: number } },
  res: any
) {
  getPid(req.p.zid, req.p.uid, function (err: any, pid: number) {
    if (err || pid < 0) {
      failJson(res, 500, "polis_err_getting_pid", err);
      return;
    }
    pg.query_readOnly(
      "SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);",
      [req.p.zid, req.p.pid],
      function (err: any, docs: { rows: any[] }) {
        if (err) {
          failJson(res, 500, "polis_err_get_votes_by_me", err);
          return;
        }
        for (let i = 0; i < docs.rows.length; i++) {
          docs.rows[i].weight = docs.rows[i].weight / 32767;
        }
        finishArray(res, docs.rows);
      }
    );
  });
}

async function handle_GET_votes(req: VoteGetRequest, res: any) {
  try {
    const votes = await getVotesForSingleParticipant(req.p);
    finishArray(res, votes);
  } catch (err) {
    failJson(res, 500, "polis_err_votes_get", err);
  }
}

/**
 * Simplified vote handler - all participant management is handled by middleware
 */
async function handle_POST_votes(req: RequestWithP, res: any) {
  const { zid, pid, uid, tid, vote, weight, high_priority, starred, lang } =
    req.p;

  try {
    // 1. Submit the vote - that's all we need to do now!
    const voteResult = await votesPost(
      uid,
      pid,
      zid,
      tid,
      vote,
      weight,
      high_priority
    );

    const voteRecord = voteResult.vote;
    const createdTimeMillis = safeTimestampToMillis(voteRecord.created);

    // 2. Async updates (don't wait for them)
    setTimeout(() => {
      updateConversationModifiedTime(zid, createdTimeMillis);
      updateLastInteractionTimeForConversation(zid, uid);
      updateVoteCount(zid, pid);
    }, 100);

    // 3. Handle star if present
    if (!_.isUndefined(starred)) {
      await addStar(zid, tid, pid, starred, createdTimeMillis);
    }

    // 4. Get next comment
    const nextComment = await getNextComment(zid, pid, [], lang);

    // 5. Build result
    const result: PidReadyResult = {};
    if (nextComment) {
      result.nextComment = nextComment;
    } else {
      // no need to wait for this to finish
      addNoMoreCommentsRecord(zid, pid);
    }

    result.currentPid = pid;

    // 6. Handle moderation options
    if (result.shouldMod) {
      result.modOptions = {};
      if (req.p.vote === polisTypes.reactions.pull) {
        result.modOptions.as_important = true;
        result.modOptions.as_factual = true;
        result.modOptions.as_feeling = true;
      } else if (req.p.vote === polisTypes.reactions.push) {
        result.modOptions.as_notmyfeeling = true;
        result.modOptions.as_notgoodidea = true;
        result.modOptions.as_abusive = true;
      } else if (req.p.vote === polisTypes.reactions.pass) {
        result.modOptions.as_unsure = true;
        result.modOptions.as_spam = true;
        result.modOptions.as_abusive = true;
      }
    }

    // 7. Auth token will be automatically included by attachAuthToken middleware

    finishOne(res, result);
  } catch (err) {
    logger.error("Error in handle_POST_votes:", err);

    if (err === "polis_err_vote_duplicate") {
      failJson(res, 406, "polis_err_vote_duplicate", err);
    } else if (err === "polis_err_conversation_is_closed") {
      failJson(res, 403, "polis_err_conversation_is_closed", err);
    } else if (err === "polis_err_post_votes_social_needed") {
      failJson(res, 403, "polis_err_post_votes_social_needed", err);
    } else if (err === "polis_err_xid_not_allowed") {
      failJson(res, 403, "polis_err_xid_not_allowed", err);
    } else if (err === "polis_err_vote_anonymous_user_creation") {
      failJson(res, 500, "polis_err_vote_anonymous_user_creation", err);
    } else {
      failJson(res, 500, "polis_err_vote", err);
    }
  }
}

async function handle_GET_votes_famous(req: { p: any }, res: any) {
  try {
    const data = await doFamousQuery(req.p);
    res.status(200).json(data);
  } catch (err) {
    failJson(res, 500, "polis_err_famous_proj_get", err);
  }
}

export {
  getVotesForSingleParticipant,
  handle_GET_votes_famous,
  handle_GET_votes_me,
  handle_GET_votes,
  handle_POST_votes,
  votesPost,
};
