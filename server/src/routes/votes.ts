import _ from "underscore";
import { addParticipantAndMetadata } from "../participant";
import { failJson } from "../utils/fail";
import { getPid, getPidPromise } from "../user";
import { getZinvite } from "../utils/zinvite";
import { isDuplicateKey, polisTypes } from "../utils/common";
import { PidReadyResult, Vote, ConversationInfo } from "../d";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import SQL from "../db/sql";
import {
  createAnonUser,
  issueAnonymousJWT,
  issueStandardUserJWT,
  issueXidJWT,
} from "../auth";
import { checkLegacyCookieAndIssueJWT } from "../auth/legacyCookies";
import {
  isXidWhitelisted,
  getConversationInfo,
  getXidRecord,
  createXidRecordByZid,
} from "../conversation";
import {
  addNoMoreCommentsRecord,
  addStar,
  doFamousQuery,
  finishArray,
  finishOne,
  getNextComment,
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
interface VoteRequest {
  p: Vote & {
    anonymous_participant?: boolean;
    oidc_sub?: string;
    oidcUser?: any;
    jwt_conversation_id?: string;
    jwt_conversation_mismatch?: boolean;
    jwt_xid?: string;
    requested_conversation_id?: string;
    standard_user_participant?: boolean;
    xid_participant?: boolean;
  };
  headers?: { [x: string]: any };
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
  xid?: string,
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

  if (conv.use_xid_whitelist) {
    const is_whitelisted = await isXidWhitelisted(conv.owner!, xid!);
    if (!is_whitelisted) {
      throw "polis_err_xid_not_whitelisted";
    }
  }

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
 * Handle user identification and creation for votes
 * Returns the final UID to use for the participant
 */
async function handleUserIdentification(req: VoteRequest): Promise<number> {
  const uid = req.p.uid;

  if (uid !== undefined) {
    return uid;
  }

  if (req.p.xid) {
    // Handle XID users - look up or create their UID
    const existingXidRecords = await getXidRecord(req.p.xid, req.p.zid);

    if (existingXidRecords && existingXidRecords.length > 0) {
      // XID user already exists
      return existingXidRecords[0].uid;
    }

    // XID user doesn't exist, need to create one
    const conv = await getConversationInfo(req.p.zid);
    if (conv.use_xid_whitelist) {
      const isWhitelisted = await isXidWhitelisted(conv.owner, req.p.xid);
      if (!isWhitelisted) {
        throw new Error("polis_err_xid_not_whitelisted");
      }
    }

    // Create new anonymous user for this XID
    const newUid = await createAnonUser();

    // Create XID record linking the XID to the new user
    await createXidRecordByZid(
      req.p.zid,
      newUid,
      req.p.xid,
      undefined,
      undefined,
      undefined
    );

    return newUid;
  }

  // Create anonymous user
  const newUid = await createAnonUser();
  req.p.uid = newUid; // Set uid in request for subsequent middleware
  return newUid;
}

/**
 * Get or create participant for the given user and conversation
 * Returns the participant ID and whether it was newly created
 */
async function getOrCreateParticipant(
  zid: number,
  uid: number,
  existingPid: number | undefined,
  req: VoteRequest
): Promise<{ pid: number; isNewlyCreated: boolean }> {
  if (existingPid !== undefined) {
    return { pid: existingPid, isNewlyCreated: false };
  }

  // Check if participant already exists
  const foundPid = await getPidPromise(zid, uid);

  if (foundPid !== -1) {
    return { pid: foundPid, isNewlyCreated: false };
  }

  // Create new participant with constraint violation protection
  try {
    const rows = await addParticipantAndMetadata(zid, uid, req);
    return { pid: rows[0].pid, isNewlyCreated: true };
  } catch (createError) {
    // Handle race condition where another request created the participant
    if (isDuplicateKey(createError)) {
      const retryPid = await getPidPromise(zid, uid);
      if (retryPid !== -1) {
        return { pid: retryPid, isNewlyCreated: false };
      }
    }
    throw createError;
  }
}

/**
 * Issue JWT token for the participant if needed
 */
async function issueJWTIfNeeded(
  req: VoteRequest,
  uid: number,
  pid: number,
  zid: number,
  isNewlyCreated: boolean
): Promise<any> {
  logger.debug("issueJWTIfNeeded called", {
    uid,
    pid,
    zid,
    isNewlyCreated,
    hasAuthHeader: !!req.headers?.authorization,
    xid: req.p.xid,
    oidc_sub: req.p.oidc_sub,
    standard_user_participant: req.p.standard_user_participant,
  });

  // Skip JWT issuance only if participant already has a valid JWT
  if (req.headers?.authorization) {
    logger.debug("Skipping JWT issuance - participant already has auth header");
    return {}; // Already has JWT
  }

  // Issue JWT for:
  // 1. Newly created participants
  // 2. Existing participants who don't have a JWT yet (no auth header)
  logger.debug("Proceeding with JWT issuance - participant needs JWT", {
    isNewlyCreated,
    hasAuthHeader: !!req.headers?.authorization,
  });

  try {
    const conversationId = (await getZinvite(zid)) as string;

    if (!conversationId) {
      throw new Error(`Could not find conversation_id for zid ${zid}`);
    }

    logger.debug("Got conversation ID for JWT", { conversationId, zid });

    // Determine which type of JWT to issue
    let token;
    let tokenType;

    if (req.p.oidc_sub) {
      // Standard user with OIDC authentication
      token = issueStandardUserJWT(req.p.oidc_sub, conversationId, uid, pid);
      tokenType = "StandardUser";
    } else if (req.p.xid) {
      // XID participant
      token = issueXidJWT(req.p.xid, conversationId, uid, pid);
      tokenType = "XID";
    } else {
      // Anonymous participant
      token = issueAnonymousJWT(conversationId, uid, pid);
      tokenType = "Anonymous";
    }

    logger.debug("JWT issued successfully", {
      tokenType,
      uid,
      pid,
      conversationId,
      oidc_sub: req.p.oidc_sub,
    });

    return {
      auth: {
        token: token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year in seconds
      },
    };
  } catch (error) {
    logger.error("Failed to issue JWT on vote:", error);
    return {}; // Continue without JWT - maintains backward compatibility
  }
}

async function handle_POST_votes(req: VoteRequest, res: any) {
  const zid = req.p.zid;
  let pid = req.p.pid;

  try {
    // Handle JWT conversation mismatches
    if (req.p.jwt_conversation_mismatch) {
      if (req.p.anonymous_participant) {
        // Anonymous participant with JWT for different conversation - treat as new
        logger.debug(
          "Anonymous participant voting with JWT for different conversation - treating as new"
        );
        req.p.uid = undefined;
        req.p.pid = undefined;
      } else if (req.p.xid_participant && req.p.xid) {
        // XID participant - apply the same 4-case logic as participationInit
        const jwtXid = req.p.jwt_xid;
        const requestXid = req.p.xid;
        const xidMatches = jwtXid === requestXid;

        // Check if XID exists for current conversation
        let xidForCurrentConversation = false;
        try {
          const xidRecords = await getXidRecord(requestXid, zid);
          if (xidRecords && xidRecords.length > 0) {
            xidForCurrentConversation = true;
          }
        } catch (err) {
          // XID not found for this conversation
        }

        if (xidMatches) {
          // Case 2: Token and XID align but are for different conversation
          logger.debug(
            "Case 2: XID participant voting with matching JWT/XID for different conversation - treating as anonymous"
          );
          req.p.xid = undefined; // Clear XID to treat as anonymous
          req.p.uid = undefined;
          req.p.pid = undefined;
        } else if (!xidMatches && xidForCurrentConversation) {
          // Case 3: Token for different conversation, but XID is for current
          logger.debug(
            "Case 3: XID participant voting with mismatched JWT but XID for current conversation - maintaining XID"
          );
          req.p.uid = undefined;
          req.p.pid = undefined;
          // XID will be resolved below
        } else {
          // Case 4: Token for current conversation, but XID for different
          logger.debug(
            "Case 4: XID participant voting with JWT for current conversation but XID for different - treating as anonymous"
          );
          req.p.xid = undefined; // Clear XID
          // Keep uid/pid from JWT
        }
      }
    }

    // Check for legacy cookie before creating new user
    let legacyCookieToken: string | undefined;
    let isLegacyCookieUser = false;
    if (req.p.uid === undefined && !req.p.jwt_conversation_mismatch) {
      // Get conversation_id for the legacy cookie check
      const conversationId = await getZinvite(zid);
      if (conversationId) {
        const legacyResult = await checkLegacyCookieAndIssueJWT(
          req,
          zid,
          conversationId as string,
          req.p.xid
        );
        if (legacyResult.uid !== undefined && legacyResult.pid !== undefined) {
          req.p.uid = legacyResult.uid;
          req.p.pid = legacyResult.pid;
          pid = legacyResult.pid;
          legacyCookieToken = legacyResult.token;
          isLegacyCookieUser = true;
          logger.info("Using existing participant from legacy cookie", {
            uid: legacyResult.uid,
            pid: legacyResult.pid,
          });
        }
      }
    }

    // 1. Handle user identification and creation
    const finalUid = await handleUserIdentification(req);

    // 2. Get or create participant
    const { pid: participantId, isNewlyCreated } = await getOrCreateParticipant(
      zid,
      finalUid,
      req.p.pid,
      req
    );
    pid = participantId;

    // 3. Submit the vote
    const voteResult = await votesPost(
      finalUid,
      pid,
      zid,
      req.p.tid,
      req.p.xid,
      req.p.vote,
      req.p.weight,
      req.p.high_priority
    );

    const vote = voteResult.vote;
    const createdTimeMillis = safeTimestampToMillis(vote.created);

    // 4. Async updates (don't wait for them)
    setTimeout(() => {
      updateConversationModifiedTime(zid, createdTimeMillis);
      updateLastInteractionTimeForConversation(zid, finalUid);
      updateVoteCount(zid, pid);
    }, 100);

    // 5. Handle star if present
    if (!_.isUndefined(req.p.starred)) {
      await addStar(zid, req.p.tid, pid, req.p.starred, createdTimeMillis);
    }

    // 6. Get next comment
    const nextComment = await getNextComment(zid, pid, [], true, req.p.lang);

    // 7. Build result
    const result: PidReadyResult = {};
    if (nextComment) {
      result.nextComment = nextComment;
    } else {
      // no need to wait for this to finish
      addNoMoreCommentsRecord(zid, pid);
    }

    // PID_FLOW This may be the first time the client gets the pid.
    result.currentPid = pid;

    // 8. Handle moderation options
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

    // 9. Issue JWT if needed
    let authResult;
    if (isLegacyCookieUser && legacyCookieToken) {
      // Use the JWT token from legacy cookie lookup
      authResult = {
        auth: {
          token: legacyCookieToken,
          token_type: "Bearer",
          expires_in: 365 * 24 * 60 * 60, // 1 year
        },
      };
      logger.debug("Using JWT from legacy cookie lookup");
    } else {
      // Issue new JWT if needed
      authResult = await issueJWTIfNeeded(
        req,
        finalUid,
        pid,
        zid,
        isNewlyCreated
      );
    }
    Object.assign(result, authResult);

    finishOne(res, result);
  } catch (err) {
    logger.error("Error in handle_POST_votes:", err);

    if (err === "polis_err_vote_duplicate") {
      failJson(res, 406, "polis_err_vote_duplicate", err);
    } else if (err === "polis_err_conversation_is_closed") {
      failJson(res, 403, "polis_err_conversation_is_closed", err);
    } else if (err === "polis_err_post_votes_social_needed") {
      failJson(res, 403, "polis_err_post_votes_social_needed", err);
    } else if (err === "polis_err_xid_not_whitelisted") {
      failJson(res, 403, "polis_err_xid_not_whitelisted", err);
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
  votesPost,
  handle_GET_votes_famous,
  handle_GET_votes_me,
  handle_GET_votes,
  handle_POST_votes,
};
