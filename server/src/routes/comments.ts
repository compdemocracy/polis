import _ from "underscore";
import { ManagementClient } from "auth0";
import { parse } from "csv-parse/sync";
import badwords from "badwords/object";

import { addParticipant } from "../participant";
import { CommentOptions, GetCommentsParams, RequestWithP } from "../d";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { getNextComment } from "../nextComment";
import { getPidPromise, getUserInfoForUid2 } from "../user";
import { getZinvite } from "../utils/zinvite";
import { isModerator, polisTypes } from "../utils/common";
import { MPromise } from "../utils/metered";
import { votesPost } from "./votes";
import analyzeComment from "../utils/moderation";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  detectLanguage,
  getComment,
  getComments,
  translateAndStoreComment,
} from "../comment";
import {
  finishArray,
  finishOne,
  safeTimestampToMillis,
  sendEmailByUid,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
  updateVoteCount,
} from "../server-helpers";

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

const managementClient = new ManagementClient({
  domain: Config.authDomain!,
  clientId: Config.authClientId!,
  clientSecret: Config.authClientSecret!,
});

async function commentExists(zid: number, txt: string): Promise<boolean> {
  const rows = (await pg.queryP(
    "select zid from comments where zid = ($1) and txt = ($2);",
    [zid, txt]
  )) as Array<{ zid: number }>;
  return Array.isArray(rows) && rows.length > 0;
}

async function handle_GET_comments_translations(
  req: { p: { zid: number; tid: number; lang: string } },
  res: { status: (code: number) => { json: (data: unknown) => void } }
): Promise<void> {
  try {
    const { zid, tid, lang } = req.p;
    const firstTwoCharsOfLang = lang.slice(0, 2);

    const comment = await getComment(zid, tid);
    if (!comment || !comment.txt) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const existingTranslations = await pg.queryP(
      "select * from comment_translations where zid = ($1) and tid = ($2) and lang LIKE ($3 || '%');",
      [zid, tid, firstTwoCharsOfLang]
    );

    const rows =
      (existingTranslations as unknown as any[])?.length > 0
        ? existingTranslations
        : await translateAndStoreComment(zid, tid, comment.txt, lang);

    res.status(200).json(rows || []);
  } catch (err) {
    failJson(res as any, 500, "polis_err_get_comments_translations", err);
  }
}

async function handle_GET_comments(req: RequestWithP, res: any): Promise<void> {
  try {
    // The function is designed to work with partial parameters, where most fields are optional
    let comments = (await getComments(req.p as GetCommentsParams)) as any[];
    if (req.p.rid) {
      const selections = (await pg.queryP(
        "select tid, selection from report_comment_selections where rid = ($1);",
        [req.p.rid]
      )) as Array<{ tid: number; selection: number }>;

      const tidToSelection = selections.reduce<
        Record<number, { selection: number }>
      >((acc, s) => {
        acc[s.tid] = { selection: s.selection };
        return acc;
      }, {});

      comments = (comments as any[]).map((c: any) => {
        c.includeInReport =
          tidToSelection[c.tid] && tidToSelection[c.tid].selection > 0;
        return c;
      });
    }
    finishArray(res, comments);
  } catch (err) {
    failJson(res, 500, "polis_err_get_comments", err);
  }
}

function addNotificationTask(zid: number): Promise<any> {
  return pg.queryP(
    "insert into notification_tasks (zid) values ($1) on conflict (zid) do update set modified = now_as_millis();",
    [zid]
  );
}

interface CommentModerationResult {
  active: boolean;
  mod: number;
  classifications: string[];
}

export async function isProConvo(owner: number): Promise<boolean> {
  try {
    const { email } = await getUserInfoForUid2(owner);
    if (!email) {
      logger.warn(`No email found for owner ID: ${owner}`);
      return false;
    }
    const users = await managementClient.usersByEmail.getByEmail({ email });

    if (!users || users.data.length === 0) {
      logger.warn(`No OIDC user found for email: ${email}`);
      return false;
    }
    const user = users.data[0];
    const userId = user.user_id;

    if (!userId) {
      logger.error(`OIDC user object for ${email} is missing a user_id.`);
      return false;
    }
    const roles = await managementClient.users.getRoles({ id: userId });
    const hasRole = roles.data.some((role) => role.name === "delphi-enabled");

    return hasRole;
  } catch (error) {
    logger.error(error);
    return false;
  }
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

// Perform content moderation checks (Pro feature - toxicity analysis and profanity filtering)
// Note: Seed and moderator comments bypass this function entirely
async function moderateComment(
  txt: string,
  conversation: any,
  ip?: string | undefined
): Promise<CommentModerationResult> {
  let active = true;
  const classifications: string[] = [];
  let mod = 0;

  // Run moderation checks in parallel
  const [polisModResponse, bad] = await Promise.all([
    analyzeComment(txt, conversation.topic, ip),
    Promise.resolve(hasBadWords(txt)),
  ]);

  if (bad && conversation.profanity_filter) {
    active = false;
    classifications.push("bad");
    logger.info("active=false because (bad && conv.profanity_filter)");
  }

  const commentToxicityThreshold = 100;

  const toxicityScore = Number(polisModResponse);

  if (typeof toxicityScore === "number" && !isNaN(toxicityScore)) {
    logger.debug(
      `Polismod toxicity Score for comment "${txt}": ${toxicityScore}`
    );

    if (toxicityScore >= commentToxicityThreshold) {
      active = false;
      mod = -1;
      classifications.push("bad");
      logger.info("active=false because (Toxicity)");
    }
  }

  return { active, mod, classifications };
}

/**
 * Simplified comment handler - all participant management is handled by middleware
 */
async function handle_POST_comments(req: RequestWithP, res: any) {
  const { zid, uid, pid, txt, vote, is_seed, xid } = req.p;

  try {
    // 1. Validate input
    if (!txt || txt === "") {
      failJson(res, 400, "polis_err_param_missing_txt");
      return;
    }

    // 2. Check for duplicates
    const exists = await commentExists(zid, txt);
    if (exists) {
      failJson(res, 409, "polis_err_post_comment_duplicate");
      return;
    }

    // 3. Get conversation info and check moderation status
    const [conversation, is_moderator] = await Promise.all([
      getConversationInfo(zid),
      isModerator(zid, uid),
    ]);

    if (!conversation.is_active) {
      failJson(res, 403, "polis_err_conversation_is_closed");
      return;
    }

    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.connection?.socket?.remoteAddress;

    // 4. Moderate the comment
    let active = true;
    let mod = 0;

    // Always auto-approve seed comments regardless of pro status
    if (is_seed || is_moderator) {
      mod = polisTypes.mod.ok;
      active = true;
    } else if (await isProConvo(conversation.owner)) {
      // Only apply pro moderation features to non-seed comments
      const moderationResult = await moderateComment(txt, conversation, ip);
      active = moderationResult.active;
      mod = moderationResult.mod;
    }

    // 5. Detect language
    const detections = await detectLanguage(txt);
    const detection = Array.isArray(detections) ? detections[0] : detections;
    const lang = detection.language;
    const lang_confidence = detection.confidence;

    // 6. Insert the comment
    const insertedComment = await pg.queryP(
      `INSERT INTO COMMENTS
      (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, $10, $11)
      RETURNING *;`,
      [
        pid,
        zid,
        txt,
        1, // velocity
        active,
        mod,
        uid,
        false, // anon
        is_seed || false,
        lang,
        lang_confidence,
      ]
    );

    const comment = insertedComment[0];
    const tid = comment.tid;

    // 7. Handle voting on the comment if specified
    const shouldDefaultVote = req.p.is_seed && _.isUndefined(vote);
    const finalVote = shouldDefaultVote ? 0 : vote;

    if (!_.isUndefined(finalVote)) {
      await votesPost(uid, pid, zid, tid, xid, finalVote, 0, false);
    }

    // 8. Handle moderation notifications
    const needsModeration = !active || conversation.strict_moderation;

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

    // 9. Schedule async updates
    const createdTimeMillis = safeTimestampToMillis(comment.created);
    setTimeout(() => {
      updateConversationModifiedTime(zid, new Date(createdTimeMillis));
      updateLastInteractionTimeForConversation(zid, uid);
      if (!_.isUndefined(finalVote)) {
        updateVoteCount(zid, pid);
      }
    }, 100);

    // 10. Build response
    const response: any = {
      tid,
      currentPid: pid,
    };

    // 11. Auth token will be automatically included by attachAuthToken middleware

    res.json(response);
  } catch (err: any) {
    // Log all errors for debugging
    logger.error("Comment creation failed", {
      zid,
      uid,
      pid,
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
          pid,
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
        pid,
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
        pid,
        error: err.message,
        constraint: err.constraint,
      });
      failJson(res, 500, "polis_err_post_comment_constraint_violation", err);
    } else {
      // Generic error - ensure we don't crash the server
      logger.error("Unexpected error in comment creation", {
        zid,
        uid,
        pid,
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

async function handle_GET_nextComment(
  req: PolisRequest,
  res: { status: (code: number) => { json: (data: unknown) => void } }
): Promise<void> {
  if (req.timedout) {
    return;
  }

  const pid = req.p.pid || req.p.not_voted_by_pid;

  try {
    const next = await getNextComment(
      req.p.zid,
      pid,
      req.p.without,
      req.p.lang
    );

    if (req.timedout) return;

    if (next) {
      if (!_.isUndefined(pid)) {
        next.currentPid = pid;
      }
      finishOne(res as any, next);
    } else {
      const response: CommentOptions = {};
      if (!_.isUndefined(pid)) {
        response.currentPid = pid;
      }
      res.status(200).json(response);
    }
  } catch (err) {
    if (req.timedout) return;
    failJson(res as any, 500, "polis_err_get_next_comment", err);
  }
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
        if (is_moderator || is_seed) {
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
