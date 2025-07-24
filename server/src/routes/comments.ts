import _ from "underscore";
import { google } from "googleapis";
import { parse } from "csv-parse/sync";
import badwords from "badwords/object";

import { addParticipant } from "../participant";
import { CommentOptions, CommentType } from "../d";
import { createAnonUser, issueAnonymousJWT, issueXidJWT } from "../auth";
import { checkLegacyCookieAndIssueJWT } from "../auth/legacyCookies";
import { detectLanguage, getComment, getComments } from "../comment";
import { failJson } from "../utils/fail";
import { getPidPromise, getXidStuff } from "../user";
import { getZinvite } from "../utils/zinvite";
import { MPromise } from "../utils/metered";
import { translateAndStoreComment } from "../comment";
import { votesPost } from "./votes";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  createXidRecordByZid,
  getConversationInfo,
  getXidRecord,
} from "../conversation";
import {
  finishArray,
  finishOne,
  getNextComment,
  safeTimestampToMillis,
  sendEmailByUid,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
  updateVoteCount,
} from "../server-helpers";
import {
  isModerator,
  isSpam,
  polisTypes,
  isDuplicateKey,
} from "../utils/common";

/* this is a concept and can be generalized to other handlers */
interface PolisRequestParams {
  zid?: number;
  xid?: string;
  uid?: number;
  txt?: string;
  pid?: number;
  vote?: number;
  is_seed?: boolean;
  rid?: any;
  tid?: number;
  lang?: string;
  not_voted_by_pid?: any;
  without?: any;
  include_social?: any;
  conversation_id?: string;
  jwt_conversation_mismatch?: boolean;
  jwt_conversation_id?: string;
  requested_conversation_id?: string;
  jwt_xid?: string;
  anonymous_participant?: boolean;
  xid_participant?: boolean;
}

interface PolisRequest {
  p: PolisRequestParams;
  connection?: {
    remoteAddress?: string;
    socket?: {
      remoteAddress?: string;
    };
  };
  socket?: {
    remoteAddress?: string;
  };
  headers: {
    [key: string]: string | string[] | undefined;
    "x-forwarded-for"?: string;
    "user-agent"?: string;
    referer?: string;
  };
  timedout?: any;
}

const GOOGLE_DISCOVERY_URL =
  "https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1";

async function analyzeComment(txt: string) {
  try {
    const client: any = await google.discoverAPI(GOOGLE_DISCOVERY_URL);

    const analyzeRequest = {
      comment: {
        text: txt,
      },
      requestedAttributes: {
        TOXICITY: {},
      },
    };

    const response = await client.comments.analyze({
      key: Config.googleJigsawPerspectiveApiKey,
      resource: analyzeRequest,
    });

    return response.data;
  } catch (err) {
    logger.error("analyzeComment error", err);
  }
}

function hasBadWords(txt: string) {
  txt = txt.toLowerCase();
  const tokens = txt.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    if (badwords[tokens[i]]) {
      return true;
    }
  }
  return false;
}

function commentExists(zid: number, txt: any) {
  return pg
    .queryP("select zid from comments where zid = ($1) and txt = ($2);", [
      zid,
      txt,
    ])
    .then(function (rows: string | any[]) {
      return rows && rows.length;
    });
}

function handle_GET_comments_translations(
  req: { p: { zid: number; tid: number; lang: string } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  }
): void {
  const zid = req.p.zid;
  const tid = req.p.tid;
  const firstTwoCharsOfLang = req.p.lang.substr(0, 2);

  getComment(zid, tid)
    .then((comment: { txt?: any } | null) => {
      if (!comment || !comment.txt) {
        res.status(404).json({ error: "Comment not found" });
        return;
      }
      return pg
        .queryP(
          "select * from comment_translations where zid = ($1) and tid = ($2) and lang LIKE '$3%';",
          [zid, tid, firstTwoCharsOfLang]
        )
        .then((existingTranslations: any) => {
          if (existingTranslations) {
            return existingTranslations;
          }
          return translateAndStoreComment(zid, tid, comment.txt, req.p.lang);
        })
        .then((rows: any) => {
          res.status(200).json(rows || []);
        });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_get_comments_translations", err);
    });
}

function handle_GET_comments(
  req: {
    headers?: Headers;
    p: { rid: any; zid: number; uid?: number };
  },
  res: any
): void {
  // The function is designed to work with partial parameters, where most fields are optional
  getComments(req.p as CommentType)
    .then(function (comments: any[]) {
      if (req.p.rid) {
        return pg
          .queryP(
            "select tid, selection from report_comment_selections where rid = ($1);",
            [req.p.rid]
          )
          .then((selections: any) => {
            const tidToSelection = _.indexBy(selections, "tid");
            comments = comments.map(
              (c: { includeInReport: any; tid: number }) => {
                c.includeInReport =
                  tidToSelection[c.tid] && tidToSelection[c.tid].selection > 0;
                return c;
              }
            );
            return comments;
          });
      } else {
        return comments;
      }
    })
    .then(function (comments: any[]) {
      finishArray(res, comments);
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_get_comments", err);
    });
}

function addNotificationTask(zid: number): Promise<any> {
  return pg.queryP(
    "insert into notification_tasks (zid) values ($1) on conflict (zid) do update set modified = now_as_millis();",
    [zid]
  );
}

// Helper interfaces for handle_POST_comments
interface CommentValidationResult {
  isValid: boolean;
  errorCode?: string;
  statusCode?: number;
}

interface CommentModerationResult {
  active: boolean;
  mod: number;
  classifications: string[];
}

interface CommentCreationContext {
  zid: number;
  uid: number;
  pid: number;
  txt: string;
  xid?: string;
  conversation: any;
  is_moderator: boolean;
  is_seed?: boolean;
}

// Extract IP address from request
function getIpAddress(req: PolisRequest): string | undefined {
  return (req.headers["x-forwarded-for"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress) as string | undefined;
}

// Validate comment input parameters
function validateCommentInput(req: PolisRequest): CommentValidationResult {
  const { txt } = req.p;

  if (!txt || txt === "") {
    return {
      isValid: false,
      errorCode: "polis_err_param_missing_txt",
      statusCode: 400,
    };
  }

  return { isValid: true };
}

// Get or create participant ID for the comment
async function resolveParticipantId(
  zid: number,
  uid: number,
  xid?: string,
  initialPid?: number
): Promise<{
  pid: number;
  shouldCreateXidRecord: boolean;
  newlyCreated: boolean;
}> {
  let shouldCreateXidRecord = false;
  let newlyCreated = false;

  // Handle XID user lookup
  if (xid) {
    const xidUser = await getXidStuff(xid, zid);
    shouldCreateXidRecord =
      xidUser === "noXidRecord" ||
      (typeof xidUser === "object" && xidUser.pid === -1);

    if (typeof xidUser === "object" && !shouldCreateXidRecord) {
      return {
        pid: xidUser.pid,
        shouldCreateXidRecord: false,
        newlyCreated: false,
      };
    }
  }

  // Create XID record if needed
  if (shouldCreateXidRecord && xid) {
    await createXidRecordByZid(zid, uid, xid, null, null, null);
  }

  // Get or create participant
  if (_.isUndefined(initialPid) || Number(initialPid) === -1) {
    const existingPid = await getPidPromise(zid, uid, true);

    if (existingPid !== -1) {
      return {
        pid: existingPid,
        shouldCreateXidRecord,
        newlyCreated: false,
      };
    }

    // Create new participant with retry logic
    try {
      const rows = await addParticipant(zid, uid);
      logger.debug("addParticipant returned", {
        zid,
        uid,
        rows,
        rowsLength: rows?.length,
      });

      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Failed to create participant - empty result`);
      }

      const ptpt = rows[0];
      if (!ptpt || typeof ptpt.pid === "undefined" || ptpt.pid === null) {
        throw new Error(`Failed to create participant - invalid data`);
      }

      newlyCreated = true;
      return {
        pid: Number(ptpt.pid),
        shouldCreateXidRecord,
        newlyCreated,
      };
    } catch (createError: any) {
      if (isDuplicateKey(createError)) {
        const retryPid = await getPidPromise(zid, uid, true);
        if (retryPid !== -1) {
          return {
            pid: retryPid,
            shouldCreateXidRecord,
            newlyCreated: false,
          };
        }
      }
      throw createError;
    }
  }

  return {
    pid: Number(initialPid),
    shouldCreateXidRecord,
    newlyCreated: false,
  };
}

function moderateCommentQuery(
  zid: number,
  tid: number,
  active: any,
  mod: any,
  is_meta: any
) {
  return new Promise((resolve, reject) => {
    const query =
      "UPDATE comments SET active = $1, mod = $2, is_meta = $3 WHERE zid = $4 AND tid = $5";
    const params = [active, mod, is_meta, zid, tid];

    logger.debug("Executing query:", { query });
    logger.debug("With parameters:", { params });

    pg.query(query, params, (err: any, result: any) => {
      if (err) {
        logger.error("moderateComment pg.query error:", err);
        reject(err);
      } else {
        logger.debug("moderateComment pg.query executed successfully");
        resolve(result);
      }
    });
  });
}

// Perform content moderation checks
async function moderateComment(
  txt: string,
  conversation: any,
  is_moderator: boolean,
  is_seed?: boolean,
  req?: PolisRequest
): Promise<CommentModerationResult> {
  const jigsawToxicityThreshold = 0.8;
  let active = true;
  const classifications: string[] = [];
  let mod = 0;

  // Moderator seed comments always pass
  if (is_moderator && is_seed) {
    mod = polisTypes.mod.ok;
    return { active: true, mod, classifications };
  }

  // Run moderation checks in parallel
  const [spammy, jigsawResponse, bad] = await Promise.all([
    req
      ? isSpam({
          comment_content: txt,
          comment_author: req.p.uid!,
          // TODO: Use dynamic url domain
          permalink: `https://pol.is/${req.p.zid}`,
          user_ip: getIpAddress(req)!,
          user_agent: req.headers["user-agent"] as string,
          referrer: req.headers["referer"] as string,
        }).catch(() => false)
      : Promise.resolve(false),
    Config.googleJigsawPerspectiveApiKey
      ? analyzeComment(txt)
      : Promise.resolve(null),
    Promise.resolve(hasBadWords(txt)),
  ]);

  // Check toxicity
  const toxicityScore =
    jigsawResponse?.attributeScores?.TOXICITY?.summaryScore?.value;

  if (typeof toxicityScore === "number" && !isNaN(toxicityScore)) {
    logger.debug(
      `Jigsaw toxicity Score for comment "${txt}": ${toxicityScore}`
    );

    if (
      toxicityScore > jigsawToxicityThreshold &&
      conversation.profanity_filter
    ) {
      active = false;
      classifications.push("bad");
      logger.info(
        "active=false because (jigsawToxicity && conv.profanity_filter)"
      );
    }
  } else if (bad && conversation.profanity_filter) {
    active = false;
    classifications.push("bad");
    logger.info("active=false because (bad && conv.profanity_filter)");
  }

  // Check spam
  if (spammy && conversation.spam_filter) {
    active = false;
    classifications.push("spammy");
    logger.info("active=false because (spammy && conv.spam_filter)");
  }

  return { active, mod, classifications };
}

// Insert comment with retry logic
async function insertComment(
  context: CommentCreationContext,
  active: boolean,
  mod: number,
  lang: string,
  lang_confidence: number
): Promise<any> {
  const { zid, uid, pid, txt, is_seed } = context;
  const velocity = 1;
  let retryCount = 0;
  const maxRetries = 3;
  let currentPid = pid;

  while (retryCount < maxRetries) {
    try {
      // Validate participant exists before insert
      const participantExists = (await pg.queryP_readOnly(
        "SELECT 1 FROM participants WHERE zid = $1 AND pid = $2 LIMIT 1",
        [zid, currentPid]
      )) as any[];

      if (participantExists.length === 0) {
        logger.warn(
          `Participant ${currentPid} does not exist for conversation ${zid}, recreating`
        );
        const result = await resolveParticipantId(zid, uid);
        currentPid = result.pid;
      }

      const insertedComment = await pg.queryP(
        `INSERT INTO COMMENTS
        (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, $10, $11)
        RETURNING *;`,
        [
          currentPid,
          zid,
          txt,
          velocity,
          active,
          mod,
          uid,
          false, // anon is deprecated and not used anywhere
          is_seed || false,
          lang,
          lang_confidence,
        ]
      );

      return { comment: insertedComment[0], finalPid: currentPid };
    } catch (insertError: any) {
      retryCount++;

      if (
        insertError.code === "23503" &&
        insertError.constraint === "comments_zid_pid_fkey"
      ) {
        logger.warn(
          `Comment insertion failed due to missing participant, retry ${retryCount}/${maxRetries}`
        );

        if (retryCount >= maxRetries) {
          throw new Error(
            `Failed to insert comment after ${maxRetries} retries due to participant race condition`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
      } else {
        throw insertError;
      }
    }
  }

  throw new Error("Failed to insert comment after max retries");
}

// Handle voting on comment creation (seed comments default to pass)
async function handleCommentVote(
  req: PolisRequest,
  uid: number,
  pid: number,
  zid: number,
  tid: number,
  xid: string | undefined,
  vote: number | undefined
): Promise<number | undefined> {
  // Handle seed comment default vote
  const shouldDefaultVote =
    req.p.is_seed && _.isUndefined(vote) && Number(zid) <= 17037;
  const finalVote = shouldDefaultVote ? 0 : vote;

  // Cast vote if specified
  if (!_.isUndefined(finalVote)) {
    const voteResult = await votesPost(
      uid,
      pid,
      zid,
      tid,
      xid,
      finalVote,
      0,
      false
    );
    if (voteResult?.vote?.created) {
      return voteResult.vote.created;
    }
  }

  return undefined;
}

// Handle post-insertion tasks
async function handlePostInsertionTasks(
  zid: number,
  uid: number,
  pid: number,
  tid: number,
  xid: string | undefined,
  vote: number | undefined,
  conversation: any,
  req: PolisRequest,
  needsModeration: boolean
): Promise<void> {
  let createdTime = new Date();

  // Handle moderation notifications
  if (needsModeration || conversation.strict_moderation) {
    try {
      const n = await getNumberOfCommentsWithModerationStatus(
        zid,
        polisTypes.mod.unmoderated
      );
      if (n !== 0) {
        const users = (await pg.queryP_readOnly(
          "SELECT * FROM users WHERE site_id = (SELECT site_id FROM page_ids WHERE zid = $1) UNION SELECT * FROM users WHERE uid = $2;",
          [zid, conversation.owner]
        )) as any[];
        const uids = users.map((user: { uid: string }) => user.uid);
        uids.forEach((uid: string) =>
          sendCommentModerationEmail(req, Number(uid), zid, n)
        );
      }
    } catch (err) {
      logger.error("polis_err_getting_modstatus_comment_count", err);
    }
  } else {
    addNotificationTask(zid);
  }

  // Handle voting
  try {
    const voteCreatedTime = await handleCommentVote(
      req,
      uid,
      pid,
      zid,
      tid,
      xid,
      vote
    );
    if (voteCreatedTime) {
      const voteCreatedTimeMillis = safeTimestampToMillis(voteCreatedTime);
      createdTime = new Date(voteCreatedTimeMillis);
    }
  } catch (err) {
    throw new Error("polis_err_vote_on_create");
  }

  // Schedule async updates
  setTimeout(() => {
    updateConversationModifiedTime(zid, createdTime);
    updateLastInteractionTimeForConversation(zid, uid);
    if (
      !_.isUndefined(vote) ||
      (req.p.is_seed && _.isUndefined(vote) && Number(zid) <= 17037)
    ) {
      updateVoteCount(zid, pid);
    }
  }, 100);
}

// Build response with optional JWT
function buildCommentResponse(
  tid: number,
  currentPid: number,
  newlyCreatedParticipant: boolean,
  newlyCreatedUser: boolean,
  uid: number | undefined,
  finalPid: number,
  xid: string | undefined,
  conversation_id: string | undefined,
  needsNewJwt: boolean = false
): any {
  const response: any = {
    tid,
    currentPid,
  };

  // Issue JWT for new participants/users OR when conversation mismatch requires new JWT
  if (
    (newlyCreatedParticipant || newlyCreatedUser || needsNewJwt) &&
    uid !== undefined &&
    finalPid !== undefined &&
    conversation_id
  ) {
    try {
      const token = xid
        ? issueXidJWT(xid, conversation_id, Number(uid), finalPid)
        : issueAnonymousJWT(conversation_id, Number(uid), finalPid);

      response.auth = {
        token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year
      };

      logger.debug(
        `${
          xid ? "XID" : "Anonymous"
        } JWT issued successfully for comment author${
          needsNewJwt ? " (conversation mismatch)" : ""
        }`
      );
    } catch (error) {
      logger.error("Failed to issue JWT on comment creation:", error);
    }
  }

  return response;
}

async function handle_POST_comments(
  req: PolisRequest,
  res: Response & { json: (data: any) => void }
): Promise<void> {
  const { zid, xid, txt, pid: initialPid, is_seed, conversation_id } = req.p;
  let { uid, vote } = req.p;

  let pid = initialPid;
  let currentPid = pid;
  let finalPid = initialPid; // Declare at function level for error handling access
  let newlyCreatedParticipant = false;
  let newlyCreatedUser = false;
  let needsNewJwt = false; // Track if we need to issue a new JWT due to conversation mismatch

  const validationResult = validateCommentInput(req);
  if (!validationResult.isValid) {
    failJson(
      res,
      validationResult.statusCode || 500,
      validationResult.errorCode || "polis_err_post_comment_invalid_input"
    );
    return;
  }

  // Handle JWT conversation mismatches
  if (req.p.jwt_conversation_mismatch) {
    needsNewJwt = true;

    if (req.p.anonymous_participant) {
      // Anonymous participant with JWT for different conversation - treat as new
      logger.debug(
        "Anonymous participant commenting with JWT for different conversation - treating as new"
      );
      uid = undefined;
      pid = undefined;
    } else if (req.p.xid_participant && xid) {
      // XID participant - apply the same 4-case logic as participationInit and votes
      const jwtXid = req.p.jwt_xid;
      const requestXid = xid;
      const xidMatches = jwtXid === requestXid;

      // Check if XID exists for current conversation
      let xidForCurrentConversation = false;
      try {
        const xidRecords = await getXidRecord(requestXid, zid!);
        if (xidRecords && xidRecords.length > 0) {
          xidForCurrentConversation = true;
        }
      } catch (err) {
        // XID not found for this conversation
      }

      if (xidMatches) {
        // Case 2: Token and XID align but are for different conversation
        logger.debug(
          "Case 2: XID participant commenting with matching JWT/XID for different conversation - treating as anonymous"
        );
        req.p.xid = undefined; // Clear XID to treat as anonymous
        uid = undefined;
        pid = undefined;
      } else if (!xidMatches && xidForCurrentConversation) {
        // Case 3: Token for different conversation, but XID is for current
        logger.debug(
          "Case 3: XID participant commenting with mismatched JWT but XID for current conversation - maintaining XID"
        );
        uid = undefined;
        pid = undefined;
        // XID will be resolved below
      } else {
        // Case 4: Token for current conversation, but XID for different
        logger.debug(
          "Case 4: XID participant commenting with JWT for current conversation but XID for different - treating as anonymous"
        );
        req.p.xid = undefined; // Clear XID
        // Keep uid/pid from JWT
      }
    }
  }

  // Check for legacy cookie before creating new user
  let legacyCookieToken: string | undefined;
  if (uid === undefined && !req.p.jwt_conversation_mismatch) {
    const legacyResult = await checkLegacyCookieAndIssueJWT(
      req,
      zid!,
      conversation_id,
      xid
    );
    if (legacyResult.uid !== undefined && legacyResult.pid !== undefined) {
      uid = legacyResult.uid;
      pid = legacyResult.pid;
      currentPid = pid;
      needsNewJwt = legacyResult.needsNewJwt;
      legacyCookieToken = legacyResult.token;
      logger.info("Using existing participant from legacy cookie", {
        uid,
        pid,
      });
    }
  }

  // Create anonymous user if uid is not provided
  // This allows anonymous participants to submit comments as their first action
  if (uid === undefined && !xid) {
    try {
      uid = await createAnonUser();
      newlyCreatedUser = true;
    } catch (err) {
      logger.error("Failed to create anonymous user for comment", err);
      failJson(res, 500, "polis_err_comment_anonymous_user_creation");
      return;
    }
  }

  try {
    // Early participant ID resolution for XID users
    if (xid) {
      const xidUser = await getXidStuff(xid, zid!);
      const shouldCreateXidRecord =
        xidUser === "noXidRecord" ||
        (typeof xidUser === "object" && xidUser.pid === -1);

      if (typeof xidUser === "object" && !shouldCreateXidRecord) {
        uid = xidUser.uid;
        pid = xidUser.pid;
        currentPid = pid;
      } else {
        // Create anonymous user for XID if uid is not available
        if (uid === undefined) {
          uid = await createAnonUser();
          newlyCreatedUser = true;
        }
        if (shouldCreateXidRecord) {
          await createXidRecordByZid(zid!, uid!, xid, null, null, null);
        }
      }
    }

    // Resolve participant ID
    const participantResult = await resolveParticipantId(zid!, uid!, xid, pid);
    finalPid = participantResult.pid;
    currentPid = finalPid;
    newlyCreatedParticipant = participantResult.newlyCreated;

    // Run all validation checks in parallel
    const [conv, is_moderator, commentExistsAlready] = await Promise.all([
      getConversationInfo(zid!),
      isModerator(zid!, uid!),
      commentExists(zid!, txt),
    ]);

    const conversation = conv;

    if (finalPid && typeof finalPid === "number" && finalPid < 0) {
      failJson(res, 500, "polis_err_post_comment_bad_pid");
      return;
    }

    if (commentExistsAlready) {
      failJson(res, 409, "polis_err_post_comment_duplicate");
      return;
    }

    if (!conversation.is_active) {
      failJson(res, 403, "polis_err_conversation_is_closed");
      return;
    }

    const { active, mod, classifications } = await moderateComment(
      txt!,
      conversation,
      is_moderator,
      is_seed,
      req
    );

    const [detections] = await Promise.all([detectLanguage(txt!)]);

    const detection = Array.isArray(detections) ? detections[0] : detections;
    const lang = detection.language;
    const lang_confidence = detection.confidence;

    const insertResult = await insertComment(
      {
        zid: zid!,
        uid: uid!,
        pid: finalPid,
        txt: txt!,
        xid,
        conversation,
        is_moderator,
        is_seed,
      },
      active,
      mod,
      lang,
      lang_confidence
    );

    const comment = insertResult.comment;
    const tid = comment.tid;
    finalPid = insertResult.finalPid; // Update finalPid in case it changed during insert

    const needsModeration =
      classifications.length > 0 || conversation.strict_moderation;

    // Ensure finalPid is a valid number (it should be at this point)
    if (typeof finalPid !== "number" || finalPid < 0) {
      failJson(res, 500, "polis_err_post_comment_invalid_pid");
      return;
    }

    try {
      await handlePostInsertionTasks(
        zid!,
        uid!,
        finalPid,
        tid,
        xid,
        vote,
        conversation,
        req,
        needsModeration
      );
    } catch (err: any) {
      if (err.message === "polis_err_vote_on_create") {
        failJson(res, 500, "polis_err_vote_on_create", err);
        return;
      }
      // Log but don't fail for other post-insertion errors
      logger.error("Error in post-insertion tasks", err);
    }

    const response = buildCommentResponse(
      tid,
      currentPid,
      newlyCreatedParticipant,
      newlyCreatedUser,
      uid,
      finalPid,
      xid,
      conversation_id,
      needsNewJwt
    );

    // Override auth with legacy cookie token if available
    if (legacyCookieToken && needsNewJwt) {
      response.auth = {
        token: legacyCookieToken,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year
      };
      logger.debug("Using JWT from legacy cookie lookup for comment response");
    }

    res.json(response);
  } catch (err: any) {
    // Log all errors for debugging
    logger.error("Comment creation failed", {
      zid,
      uid,
      pid: finalPid || initialPid,
      error: err.message,
      code: err.code,
      constraint: err.constraint,
      stack: err.stack,
    });

    if (err.code === "23505" || err.code === 23505) {
      failJson(res, 409, "polis_err_post_comment_duplicate", err);
    } else if (
      err.code === "23503" &&
      err.constraint === "comments_zid_pid_fkey"
    ) {
      // Foreign key constraint violation - participant doesn't exist
      logger.error(
        "Comment insertion failed due to participant race condition",
        {
          zid,
          uid,
          pid: finalPid || initialPid,
          error: err.message,
          constraint: err.constraint,
        }
      );
      failJson(
        res,
        500,
        "polis_err_post_comment_participant_race_condition",
        err
      );
    } else if (
      err.message &&
      err.message.includes("participant race condition")
    ) {
      // Custom error from our retry logic
      logger.error("Comment insertion failed after retries", {
        zid,
        uid,
        pid: finalPid || initialPid,
        error: err.message,
      });
      failJson(
        res,
        500,
        "polis_err_post_comment_participant_race_condition",
        err
      );
    } else if (err.code === "23503") {
      // Other foreign key constraint violations
      logger.error("Foreign key constraint violation in comment creation", {
        zid,
        uid,
        pid: finalPid || initialPid,
        error: err.message,
        constraint: err.constraint,
      });
      failJson(res, 500, "polis_err_post_comment_constraint_violation", err);
    } else {
      // Generic error - ensure we don't crash the server
      logger.error("Unexpected error in comment creation", {
        zid,
        uid,
        pid: finalPid || initialPid,
        error: err.message,
        code: err.code,
        stack: err.stack,
      });
      failJson(res, 500, "polis_err_post_comment", err);
    }
  }
}

function handle_PUT_comments(
  req: {
    p: {
      uid?: number;
      zid: number;
      tid: number;
      active: any;
      mod: any;
      is_meta: any;
    };
  },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  const uid = req.p.uid;
  const zid = req.p.zid;
  const tid = req.p.tid;
  const active = req.p.active;
  const mod = req.p.mod;
  const is_meta = req.p.is_meta;

  logger.debug(
    `Attempting to update comment. zid: ${zid}, tid: ${tid}, uid: ${uid}`
  );

  isModerator(zid, uid)
    .then(function (isModerator: any) {
      logger.debug(`isModerator result: ${isModerator}`);
      if (isModerator) {
        moderateCommentQuery(zid, tid, active, mod, is_meta).then(
          function () {
            logger.debug("Comment moderated successfully");
            res.status(200).json({});
          },
          function (err: any) {
            logger.error("Error in moderateCommentQuery:", err);
            failJson(res, 500, "polis_err_update_comment", err);
          }
        );
      } else {
        logger.debug("User is not a moderator");
        failJson(res, 403, "polis_err_update_comment_auth");
      }
    })
    .catch(function (err: any) {
      logger.error("Error in isModerator:", err);
      failJson(res, 500, "polis_err_update_comment", err);
    });
}

function handle_GET_nextComment(
  req: PolisRequest,
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
): void {
  if (req.timedout) {
    return;
  }

  /*
  NOTE: I tried to speed up this query by adding db indexes, and by removing queries like
  getConversationInfo and finishOne. They didn't help much, at least under current load, which is
  negligible. pg:diagnose isn't complaining about indexes.
  I think the direction to go as far as optimizing this is to asyncronously build up a synced in-ram list
  of next comments for each participant, for currently active conversations.
  (this would probably be a math-poller-esque process on another hostclass)
  Along with this would be to cache in ram info about moderation status of each comment so we can filter
  before returning a comment.
  */

  getNextComment(
    req.p.zid,
    req.p.not_voted_by_pid,
    req.p.without,
    req.p.include_social,
    req.p.lang
  )
    .then(
      function (c: CommentType | null) {
        if (req.timedout) {
          return;
        }
        if (c) {
          if (!_.isUndefined(req.p.not_voted_by_pid)) {
            c.currentPid = req.p.not_voted_by_pid;
          }
          finishOne(res, c);
        } else {
          const o: CommentOptions = {};
          if (!_.isUndefined(req.p.not_voted_by_pid)) {
            o.currentPid = req.p.not_voted_by_pid;
          }
          res.status(200).json(o);
        }
      },
      function (err: any) {
        if (req.timedout) {
          return;
        }
        failJson(res, 500, "polis_err_get_next_comment2", err);
      }
    )
    .catch(function (err: any) {
      if (req.timedout) {
        return;
      }
      failJson(res, 500, "polis_err_get_next_comment", err);
    });
}

// TODO: Use dynamic url domain
function createProdModerationUrl(zinvite: string): string {
  return "https://pol.is/m/" + zinvite;
}

function getNumberOfCommentsWithModerationStatus(
  zid: number,
  mod: any
): Promise<number> {
  return MPromise(
    "getNumberOfCommentsWithModerationStatus",
    function (resolve: (arg0: number) => void, reject: (arg0: any) => void) {
      pg.query_readOnly(
        "select count(*) from comments where zid = ($1) and mod = ($2);",
        [zid, mod],
        function (err: any, result: { rows: { count: any }[] }) {
          if (err) {
            reject(err);
          } else {
            let count =
              result && result.rows && result.rows[0] && result.rows[0].count;
            count = Number(count);
            if (isNaN(count)) {
              count = 0;
            }
            resolve(count);
          }
        }
      );
    }
  ) as Promise<number>;
}

function sendCommentModerationEmail(
  req: any,
  uid: number,
  zid: number,
  unmoderatedCommentCount: string | number
): void {
  if (_.isUndefined(unmoderatedCommentCount)) {
    unmoderatedCommentCount = "";
  }
  let body = unmoderatedCommentCount;
  if (unmoderatedCommentCount === 1) {
    body += " Statement is waiting for your review here: ";
  } else {
    body += " Statements are waiting for your review here: ";
  }

  getZinvite(zid)
    .catch(function (err: any) {
      logger.error("polis_err_getting_zinvite", err);
      return void 0;
    })
    .then(function (zinvite: any) {
      // NOTE: the counter goes in the email body so it doesn't create a new email thread (in Gmail, etc)

      body += createProdModerationUrl(zinvite);

      body += "\n\nThank you for using Polis.";

      // NOTE: adding a changing element (date) at the end to prevent gmail from thinking the URL is a
      // signature, and hiding it. (since the URL doesn't change between emails, Gmail tries to be smart,
      // and hides it)
      // "Sent: " + Date.now() + "\n";

      // NOTE: Adding zid to the subject to force the email client to create a new email thread.
      return sendEmailByUid(
        uid,
        `Waiting for review (conversation ${zinvite})`,
        body
      );
    })
    .catch(function (err: any) {
      logger.error("polis_err_sending_email", err);
    });
}

async function handle_POST_comments_bulk(
  req: PolisRequest,
  res: Response & { json: (data: any) => void }
): Promise<void> {
  const { zid, uid, pid: initialPid, is_seed } = req.p;
  // @ts-expect-error body parsing
  const csv = req.body.csv;
  let pid = initialPid;
  if (!csv) {
    failJson(res, 400, "polis_err_param_missing_csv");
    return;
  }

  async function doGetPid(): Promise<number> {
    if (_.isUndefined(pid) || Number(pid) === -1) {
      const newPid = await getPidPromise(zid!, uid!, true);
      if (newPid === -1) {
        const rows = await addParticipant(zid!, uid!);
        const ptpt = rows[0];
        pid = ptpt.pid;
        return Number(pid);
      } else {
        return newPid;
      }
    }
    return Number(pid);
  }

  try {
    const [finalPid, is_moderator] = await Promise.all([
      doGetPid(),
      isModerator(zid!, uid!),
      getConversationInfo(zid!),
    ]);

    if (!is_moderator) {
      failJson(res, 403, "polis_err_post_comment_auth");
      return;
    }

    if (finalPid < 0) {
      failJson(res, 500, "polis_err_post_comment_bad_pid");
      return;
    }

    const records = parse(String(csv), {
      columns: true,
      skip_empty_lines: true,
    });
    const commentTexts: string[] = records.map(
      (record: any) => record.comment_text
    );

    const results = [];
    let lastInteractionTime = new Date(0);

    for (const txt of commentTexts) {
      try {
        if (!txt || txt.trim() === "") {
          results.push({
            txt,
            status: "skipped",
            reason: "polis_err_param_missing_txt" + commentTexts + String(csv),
          });
          continue;
        }

        const commentExistsAlready = await commentExists(zid!, txt);
        if (commentExistsAlready) {
          results.push({
            txt,
            status: "skipped",
            reason: "polis_err_post_comment_duplicate",
          });
          continue;
        }

        const langDetectionPromise = detectLanguage(txt);

        const [detections] = await Promise.all([langDetectionPromise]);

        let active = true;

        let mod = 0;
        if (is_moderator && is_seed) {
          mod = polisTypes.mod.ok;
          active = true;
        }

        const detection = Array.isArray(detections)
          ? detections[0]
          : detections;
        const lang = detection.language;
        const lang_confidence = detection.confidence;

        const insertedComment: any = await pg.queryP(
          `INSERT INTO COMMENTS
          (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, $10, $11)
          RETURNING *;`,
          [
            finalPid,
            zid,
            txt,
            1,
            active,
            mod,
            uid,
            false,
            is_seed || false,
            lang,
            lang_confidence,
          ]
        );

        const comment = insertedComment[0];
        const tid = comment.tid;
        const createdTimeMillis = safeTimestampToMillis(comment.created);
        const createdTime = new Date(createdTimeMillis);

        if (createdTime > lastInteractionTime) {
          lastInteractionTime = createdTime;
        }

        if (!active) {
          addNotificationTask(zid!);
        }

        results.push({ txt, status: "success", tid });
      } catch (err: any) {
        logger.error("polis_err_bulk_comment_item", { error: err, txt });
        let reason = "polis_err_post_comment";
        if (err.code === "23505" || err.code === 23505) {
          reason = "polis_err_post_comment_duplicate";
        }
        results.push({ txt, status: "error", reason });
      }
    }

    setTimeout(() => {
      if (lastInteractionTime > new Date(0)) {
        updateConversationModifiedTime(zid!, lastInteractionTime);
        updateLastInteractionTimeForConversation(zid!, uid!);
      }
    }, 100);

    res.json({
      results,
      currentPid: pid,
    });
  } catch (err: any) {
    failJson(res, 500, "polis_err_post_comments_bulk", err);
  }
}

export {
  handle_GET_comments_translations,
  handle_GET_comments,
  handle_GET_nextComment,
  handle_POST_comments_bulk,
  handle_POST_comments,
  handle_PUT_comments,
};
