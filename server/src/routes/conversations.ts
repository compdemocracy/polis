import _ from "underscore";
import { DEFAULTS } from "../utils/constants";
import { createOneSuzinvite } from "../invites/suzinvites";
import { failJson } from "../utils/fail";
import { generateAndRegisterZinvite, generateToken } from "../auth";
import { getUserInfoForUid2 } from "../user";
import { getZinvite } from "../utils/zinvite";
import { sql_conversations } from "../db/sql";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  doGetConversationPreloadInfo,
  getZidFromConversationId,
  getConversationInfo,
} from "../conversation";
import type {
  ConversationInfo,
  ConversationType,
  ExpressRequest,
  ExpressResponse,
} from "../d";
import {
  addConversationIds,
  buildConversationUrl,
  finishOne,
  getOneConversation,
  sendEmailByUid,
  updateConversationModifiedTime,
} from "../server-helpers";
import {
  ifDefinedSet,
  isDuplicateKey,
  isModerator,
  isPolisDev,
  isUserAllowedToCreateConversations,
} from "../utils/common";

function failWithRetryRequest(res: {
  setHeader: (arg0: string, arg1: number) => void;
  writeHead: (arg0: number) => {
    (): any;
    new (): any;
    send: { (arg0: number): void; new (): any };
  };
}) {
  res.setHeader("Retry-After", 0);
  logger.warn("failWithRetryRequest");
  res.writeHead(500).send(57493875);
}

function createModerationUrl(
  req: { p?: ConversationType; protocol?: string; headers?: Headers },
  zinvite: string
) {
  let server = Config.getServerUrl();
  if (Config.domainOverride) {
    server = req?.protocol + "://" + Config.domainOverride;
  }

  if (
    typeof (req?.headers as any)?.host === "string" &&
    (req.headers as any).host.includes("preprod.pol.is")
  ) {
    server = "https://preprod.pol.is";
  }
  const url = server + "/m/" + zinvite;
  return url;
}

function generateSingleUseUrl(
  req: any,
  conversation_id: string,
  suzinvite: string
) {
  return (
    Config.getServerNameWithProtocol(req) +
    "/ot/" +
    conversation_id +
    "/" +
    suzinvite
  );
}

/**
 * Get conversation IDs that the user participates in or administers
 * @param uid - User ID
 * @param includeAll - Whether to include conversations the user participates in (not just owns)
 * @returns Object containing conversation IDs and admin status mapping
 */
async function getUserConversationIds(
  uid: number,
  includeAll: boolean
): Promise<{
  participantInOrSiteAdminOf: number[];
  isSiteAdmin: Record<number, boolean>;
}> {
  let zidListQuery =
    "select zid, 1 as type from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($1)))";

  if (includeAll) {
    zidListQuery +=
      " UNION ALL select zid, 2 as type from participants where uid = ($1)";
  }
  zidListQuery += ";";

  try {
    const rows = (await pg.queryP_readOnly(zidListQuery, [uid])) as {
      zid: number;
      type: number;
    }[];

    const participantInOrSiteAdminOf = rows?.map((row) => row.zid) || [];
    const siteAdminOf = rows?.filter((row) => row.type === 1) || [];
    const isSiteAdmin: Record<number, boolean> = {};
    siteAdminOf.forEach((row) => {
      isSiteAdmin[row.zid] = true;
    });

    return { participantInOrSiteAdminOf, isSiteAdmin };
  } catch (error) {
    logger.error("Error getting user conversation IDs:", error);
    throw error;
  }
}

/**
 * Build the SQL query for fetching conversations based on request parameters
 * @param req - Request object containing conversation filters
 * @param participantInOrSiteAdminOf - Array of conversation IDs the user has access to
 * @returns SQL query object
 */
function buildConversationsQuery(
  req: { p: ConversationType },
  participantInOrSiteAdminOf: number[]
) {
  const uid = req.p.uid;
  let query = sql_conversations.select(sql_conversations.star());
  let isRootsQuery = false;
  let orClauses;

  if (!_.isUndefined(req.p.context)) {
    if (req.p.context === "/") {
      orClauses = sql_conversations.is_public.equals(true);
      isRootsQuery = true;
    } else {
      orClauses = sql_conversations.context.equals(req.p.context);
    }
  } else {
    orClauses = sql_conversations.owner.equals(uid);
    if (participantInOrSiteAdminOf.length) {
      orClauses = orClauses.or(
        sql_conversations.zid.in(participantInOrSiteAdminOf)
      );
    }
  }

  query = query.where(orClauses);

  if (!_.isUndefined(req.p.course_invite)) {
    query = query.and(sql_conversations.course_id.equals(req.p.course_id));
  }
  if (!_.isUndefined(req.p.is_active)) {
    query = query.and(sql_conversations.is_active.equals(req.p.is_active));
  }
  if (!_.isUndefined(req.p.is_draft)) {
    query = query.and(sql_conversations.is_draft.equals(req.p.is_draft));
  }
  if (!_.isUndefined(req.p.zid)) {
    query = query.and(sql_conversations.zid.equals(req.p.zid));
  }
  if (isRootsQuery) {
    query = query.and(sql_conversations.context.isNotNull());
  }

  query = query.order(sql_conversations.created.descending);

  if (!_.isUndefined(req.p.limit)) {
    query = query.limit(req.p.limit);
  } else {
    query = query.limit(999);
  }

  return query;
}

/**
 * Process raw conversation data and add computed fields, URLs, and cleanup
 * @param data - Raw conversation data from database
 * @param req - Request object containing user preferences
 * @param isSiteAdmin - Mapping of conversation IDs to admin status
 * @returns Processed conversation data ready for API response
 */
async function processConversationData(
  data: any[],
  req: { p: ConversationType },
  isSiteAdmin: Record<number, boolean>
): Promise<any[]> {
  const uid = req.p.uid;
  const xid = req.p.xid;
  const want_upvoted = req.p.want_upvoted;
  const want_mod_url = req.p.want_mod_url;
  const want_inbox_item_admin_url = req.p.want_inbox_item_admin_url;
  const want_inbox_item_participant_url = req.p.want_inbox_item_participant_url;
  const want_inbox_item_admin_html = req.p.want_inbox_item_admin_html;
  const want_inbox_item_participant_html =
    req.p.want_inbox_item_participant_html;

  try {
    // Add conversation IDs
    await addConversationIds(data);

    // Handle single-use URLs if XID is provided
    const suurlsPromise = xid
      ? Promise.all(
          data.map(function (conv: { zid: number; owner: number }) {
            return createOneSuzinvite(
              xid,
              conv.zid,
              conv.owner,
              _.partial(generateSingleUseUrl, req)
            );
          })
        )
      : Promise.resolve();

    // Handle upvotes if requested
    const upvotesPromise =
      uid && want_upvoted
        ? pg.queryP_readOnly("select zid from upvotes where uid = ($1);", [uid])
        : Promise.resolve();

    const [suurlData, upvotes] = await Promise.all([
      suurlsPromise,
      upvotesPromise,
    ]);

    const suurlIndex = suurlData ? _.indexBy(suurlData, "zid") : null;
    const upvotesIndex = upvotes ? _.indexBy(upvotes, "zid") : null;

    // Process each conversation
    data.forEach(function (conv: any) {
      // Set ownership flag
      conv.is_owner = uid !== undefined && conv.owner === uid;

      const root = Config.getServerNameWithProtocol(req);

      if (want_mod_url) {
        conv.mod_url = createModerationUrl(req, conv.conversation_id);
      }
      if (want_inbox_item_admin_url) {
        conv.inbox_item_admin_url = root + "/iim/" + conv.conversation_id;
      }
      if (want_inbox_item_participant_url) {
        conv.inbox_item_participant_url = root + "/iip/" + conv.conversation_id;
      }
      if (want_inbox_item_admin_html) {
        conv.inbox_item_admin_html =
          "<a href='" +
          root +
          "/" +
          conv.conversation_id +
          "'>" +
          (conv.topic || conv.created) +
          "</a>" +
          " <a href='" +
          root +
          "/m/" +
          conv.conversation_id +
          "'>moderate</a>";
        conv.inbox_item_admin_html_escaped = conv.inbox_item_admin_html.replace(
          /'/g,
          "\\'"
        );
      }
      if (want_inbox_item_participant_html) {
        conv.inbox_item_participant_html =
          "<a href='" +
          root +
          "/" +
          conv.conversation_id +
          "'>" +
          (conv.topic || conv.created) +
          "</a>";
        conv.inbox_item_participant_html_escaped =
          conv.inbox_item_participant_html.replace(/'/g, "\\'");
      }

      if (suurlIndex) {
        conv.url = suurlIndex[conv.zid || ""].suurl;
      } else {
        conv.url = buildConversationUrl(req, conv.conversation_id);
      }

      if (upvotesIndex && upvotesIndex[conv.zid || ""]) {
        conv.upvoted = true;
      }

      conv.created = Number(conv.created);
      conv.modified = Number(conv.modified);

      if (_.isUndefined(conv.topic) || conv.topic === "") {
        conv.topic = new Date(conv.created).toUTCString();
      }

      conv.is_mod = conv.is_owner || isSiteAdmin[conv.zid || ""];

      // Clean up sensitive data
      delete conv.zid;
      delete conv.is_anon;
      delete conv.is_draft;
      delete conv.is_public;
      if (conv.context === "") {
        delete conv.context;
      }
    });

    return data;
  } catch (error) {
    logger.error("Error processing conversation data:", error);
    throw error;
  }
}

/**
 * Main API handler to get conversations for a user
 * @param req - Express request object with user parameters
 * @param res - Express response object
 */
export async function getConversations(req: { p: ConversationType }, res: any) {
  try {
    const uid = req.p.uid;

    // Get user's conversation access
    const { participantInOrSiteAdminOf, isSiteAdmin } =
      await getUserConversationIds(
        uid,
        req.p.include_all_conversations_i_am_in
      );

    // Build and execute main query
    const query = buildConversationsQuery(req, participantInOrSiteAdminOf);
    let data = (await pg.queryP_readOnly(query.toString())) as any[];

    // Process the conversation data
    data = await processConversationData(data, req, isSiteAdmin);

    res.status(200).json(data);
  } catch (error) {
    logger.error("Error getting conversations:", error);
    failJson(res, 500, "polis_err_get_conversations", error);
  }
}

function getConversationUrl(req: any, zid: number, dontUseCache: boolean) {
  return getZinvite(zid, dontUseCache).then(function (zinvite: string) {
    return buildConversationUrl(req, zinvite);
  });
}

/**
 * Generate and replace the zinvite for a conversation
 * Note: This is needed because we initially create a conversation with POST,
 * then set properties with subsequent PUT. Could be refactored in the future.
 * @param zid - Conversation ID
 * @param generateShortZinvite - Whether to generate a short zinvite
 * @returns Promise resolving to the new zinvite
 */
function generateAndReplaceZinvite(zid: number, generateShortZinvite: any) {
  let len = 12;
  if (generateShortZinvite) {
    len = 6;
  }
  return new Promise(function (
    resolve: (arg0: any) => void,
    reject: (arg0: string) => void
  ) {
    generateToken(len, false, function (err: any, zinvite: string) {
      if (err) {
        return reject("polis_err_creating_zinvite");
      }
      pg.query(
        "update zinvites set zinvite = ($1) where zid = ($2);",
        [zinvite, zid],
        function (err: any) {
          if (err) {
            reject(err);
          } else {
            resolve(zinvite);
          }
        }
      );
    });
  });
}

async function verifyMetadataAnswersExistForEachQuestion(
  zid: number
): Promise<void> {
  const errorcode = "polis_err_missing_metadata_answers";

  const questions = (await pg.queryP_readOnly(
    "select pmqid from participant_metadata_questions where zid = ($1);",
    [zid]
  )) as { pmqid: number }[];

  if (!questions || !questions.length) {
    return;
  }

  const pmqids = questions.map((row) => Number(row.pmqid));

  const answers = (await pg.queryP_readOnly(
    "select pmaid, pmqid from participant_metadata_answers where pmqid in (" +
      pmqids.join(",") +
      ") and alive = TRUE and zid = ($1);",
    [zid]
  )) as { pmqid: number }[];

  if (!answers || !answers.length) {
    throw new Error(errorcode);
  }

  const questionsMap = _.reduce(
    pmqids,
    function (o: { [x: string]: number }, pmqid: string | number) {
      o[pmqid] = 1;
      return o;
    },
    {}
  );

  answers.forEach(function (row: { pmqid: string | number }) {
    delete questionsMap[row.pmqid];
  });

  if (Object.keys(questionsMap).length) {
    throw new Error(errorcode);
  }
}

/**
 * Get the first vote for each participant ID
 * @param votes - Array of vote objects with pid property
 * @returns Array of first votes per participant
 */
function getFirstForPid(votes: any[]): any[] {
  const seen: Record<string, boolean> = {};
  const firstVotes: any[] = [];

  for (const vote of votes) {
    if (!seen[vote.pid]) {
      firstVotes.push(vote);
      seen[vote.pid] = true;
    }
  }

  return firstVotes;
}

/**
 * Get recent conversations based on a timestamp field
 * @param req - Request object with user ID and timestamp
 * @param res - Response object
 * @param field - Database field to filter by (created or modified)
 */
function doGetConversationsRecent(
  req: { p: { uid?: any; sinceUnixTimestamp: any } },
  res: { json: (arg0: any) => void },
  field: string
) {
  if (!isPolisDev(req.p.uid)) {
    failJson(res, 403, "polis_err_no_access_for_this_user");
    return;
  }
  let time = req.p.sinceUnixTimestamp;
  if (_.isUndefined(time)) {
    time = Date.now() - 1000 * 60 * 60 * 24 * 7;
  } else {
    time *= 1000;
  }
  time = parseInt(time);
  pg.queryP_readOnly(
    "select * from conversations where " + field + " >= ($1);",
    [time]
  )
    .then((rows: any) => {
      res.json(rows);
    })
    .catch((err: any) => {
      failJson(res, 403, "polis_err_conversationsRecent", err);
    });
}

function handle_GET_conversationsRecentlyStarted(req: any, res: any) {
  doGetConversationsRecent(req, res, "created");
}

function handle_GET_conversationsRecentActivity(req: any, res: any) {
  doGetConversationsRecent(req, res, "modified");
}

function handle_GET_conversationStats(
  req: { p: { zid: number; uid?: number; until: any; rid: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: {
        (arg0: {
          voteTimes: any;
          firstVoteTimes: any[];
          commentTimes: any;
          firstCommentTimes: any[];
          votesHistogram: any;
          burstHistogram: any[];
        }): void;
        new (): any;
      };
    };
  }
) {
  const zid = req.p.zid;
  const uid = req.p.uid;
  const until = req.p.until;

  const hasPermission = req.p.rid
    ? Promise.resolve(!!req.p.rid)
    : isModerator(zid, uid);

  hasPermission
    .then(function (ok: any) {
      if (!ok) {
        failJson(
          res,
          403,
          "polis_err_conversationStats_need_report_id_or_moderation_permission"
        );
        return;
      }

      const args = [zid];

      const q0 = until
        ? "select created, pid, mod from comments where zid = ($1) and created < ($2) order by created;"
        : "select created, pid, mod from comments where zid = ($1) order by created;";

      const q1 = until
        ? "select created, pid from votes where zid = ($1) and created < ($2) order by created;"
        : "select created, pid from votes where zid = ($1) order by created;";

      if (until) {
        args.push(until);
      }

      return Promise.all([
        pg.queryP_readOnly(q0, args),
        pg.queryP_readOnly(q1, args),
      ]).then(function (a: any[]) {
        function castTimestamp(o: { created: number }) {
          o.created = Number(o.created);
          return o;
        }
        const comments = _.map(a[0], castTimestamp);
        const votes = _.map(a[1], castTimestamp);

        const votesGroupedByPid = _.groupBy(votes, "pid");
        const votesHistogramObj = {};
        _.each(
          votesGroupedByPid,
          function (votesByParticipant: string | any[]) {
            votesHistogramObj[votesByParticipant.length] =
              votesHistogramObj[votesByParticipant.length] + 1 || 1;
          }
        );
        let votesHistogram: { n_votes: any; n_ptpts: any }[] = [];
        _.each(votesHistogramObj, function (ptptCount: any, voteCount: any) {
          votesHistogram.push({
            n_votes: voteCount,
            n_ptpts: ptptCount,
          });
        });
        votesHistogram.sort(function (a, b) {
          return a.n_ptpts - b.n_ptpts;
        });

        const burstsForPid = {};
        // a 10 minute gap between votes counts as a gap between bursts
        const interBurstGap = 10 * 60 * 1000;
        _.each(
          votesGroupedByPid,
          function (votesByParticipant: string | any[], pid: string) {
            burstsForPid[pid] = 1;
            let prevCreated = votesByParticipant.length
              ? votesByParticipant[0]
              : 0;
            for (let v = 1; v < votesByParticipant.length; v++) {
              const vote = votesByParticipant[v];
              if (interBurstGap + prevCreated < vote.created) {
                burstsForPid[pid] += 1;
              }
              prevCreated = vote.created;
            }
          }
        );
        const burstHistogramObj = {};
        _.each(burstsForPid, function (bursts: string | number) {
          burstHistogramObj[bursts] = burstHistogramObj[bursts] + 1 || 1;
        });
        const burstHistogram: { n_ptpts: any; n_bursts: number }[] = [];
        _.each(burstHistogramObj, function (ptptCount: any, burstCount: any) {
          burstHistogram.push({
            n_ptpts: ptptCount,
            n_bursts: Number(burstCount),
          });
        });
        burstHistogram.sort(function (a, b) {
          return a.n_bursts - b.n_bursts;
        });

        // since an agree vote is submitted for each comment's author, this includes people
        // who only wrote a comment, but didn't explicitly vote.
        let actualParticipants = getFirstForPid(votes);
        actualParticipants = _.pluck(actualParticipants, "created");
        let commenters = getFirstForPid(comments);
        commenters = _.pluck(commenters, "created");

        const totalComments = _.pluck(comments, "created");
        const totalVotes = _.pluck(votes, "created");

        votesHistogram = _.map(
          votesHistogram,
          function (x: { n_votes: any; n_ptpts: any }) {
            return {
              n_votes: Number(x.n_votes),
              n_ptpts: Number(x.n_ptpts),
            };
          }
        );

        res.status(200).json({
          voteTimes: totalVotes,
          firstVoteTimes: actualParticipants,
          commentTimes: totalComments,
          firstCommentTimes: commenters,
          votesHistogram: votesHistogram,
          burstHistogram: burstHistogram,
        });
      });
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_conversationStats_misc", err);
    });
}

function handle_POST_conversation_close(
  req: { p: { zid: number; uid?: number } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  let q = "select * from conversations where zid = ($1)";
  const params = [req.p.zid];
  if (!isPolisDev(req.p.uid)) {
    q = q + " and owner = ($2)";
    params.push(req.p.uid);
  }
  pg.queryP(q, params)
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        failJson(
          res,
          500,
          "polis_err_closing_conversation_no_such_conversation"
        );
        return;
      }
      const conv = rows[0];
      pg.queryP(
        "update conversations set is_active = false where zid = ($1);",
        [conv.zid]
      );
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_closing_conversation", err);
    });
}

function handle_POST_conversation_reopen(
  req: { p: { zid: number; uid?: number } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: {}): void; new (): any };
    };
  }
) {
  let q = "select * from conversations where zid = ($1)";
  const params = [req.p.zid];
  if (!isPolisDev(req.p.uid)) {
    q = q + " and owner = ($2)";
    params.push(req.p.uid);
  }
  pg.queryP(q, params)
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        failJson(
          res,
          500,
          "polis_err_closing_conversation_no_such_conversation"
        );
        return;
      }
      const conv = rows[0];
      pg.queryP("update conversations set is_active = true where zid = ($1);", [
        conv.zid,
      ])
        .then(function () {
          res.status(200).json({});
        })
        .catch(function (err: any) {
          failJson(res, 500, "polis_err_reopening_conversation2", err);
        });
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_reopening_conversation", err);
    });
}

function handle_PUT_conversations(
  req: {
    p: {
      short_url: any;
      zid: number;
      uid?: number;
      verifyMeta: any;
      is_active: any;
      is_anon: any;
      is_draft: any;
      is_data_open: any;
      profanity_filter: any;
      spam_filter: any;
      strict_moderation: any;
      topic: string;
      description: string;
      vis_type: any;
      help_type: any;
      socialbtn_type: any;
      bgcolor: string;
      help_color: string;
      help_bgcolor: string;
      style_btn: any;
      write_type: any;
      importance_enabled: any;
      owner_sees_participation_stats: any;
      launch_presentation_return_url_hex: any;
      link_url: any;
      send_created_email: any;
      conversation_id: string;
      context: any;
    };
  },
  res: any
) {
  const generateShortUrl = req.p.short_url;
  isModerator(req.p.zid, req.p.uid)
    .then(function (ok: any) {
      if (!ok) {
        failJson(res, 403, "polis_err_update_conversation_permission");
        return;
      }

      let verifyMetaPromise;
      if (req.p.verifyMeta) {
        verifyMetaPromise = verifyMetadataAnswersExistForEachQuestion(
          req.p.zid
        );
      } else {
        verifyMetaPromise = Promise.resolve();
      }

      const fields: ConversationType = {};
      if (!_.isUndefined(req.p.is_active)) {
        fields.is_active = req.p.is_active;
      }
      if (!_.isUndefined(req.p.is_anon)) {
        fields.is_anon = req.p.is_anon;
      }
      if (!_.isUndefined(req.p.is_draft)) {
        fields.is_draft = req.p.is_draft;
      }
      if (!_.isUndefined(req.p.is_data_open)) {
        fields.is_data_open = req.p.is_data_open;
      }
      if (!_.isUndefined(req.p.profanity_filter)) {
        fields.profanity_filter = req.p.profanity_filter;
      }
      if (!_.isUndefined(req.p.spam_filter)) {
        fields.spam_filter = req.p.spam_filter;
      }
      if (!_.isUndefined(req.p.strict_moderation)) {
        fields.strict_moderation = req.p.strict_moderation;
      }
      if (!_.isUndefined(req.p.topic)) {
        fields.topic = req.p.topic;
      }
      if (!_.isUndefined(req.p.description)) {
        fields.description = req.p.description;
      }
      if (!_.isUndefined(req.p.vis_type)) {
        fields.vis_type = req.p.vis_type;
      }
      if (!_.isUndefined(req.p.help_type)) {
        fields.help_type = req.p.help_type;
      }
      if (!_.isUndefined(req.p.socialbtn_type)) {
        fields.socialbtn_type = req.p.socialbtn_type;
      }
      if (!_.isUndefined(req.p.bgcolor)) {
        if (req.p.bgcolor === "default") {
          fields.bgcolor = null;
        } else {
          fields.bgcolor = req.p.bgcolor;
        }
      }
      if (!_.isUndefined(req.p.help_color)) {
        if (req.p.help_color === "default") {
          fields.help_color = null;
        } else {
          fields.help_color = req.p.help_color;
        }
      }
      if (!_.isUndefined(req.p.help_bgcolor)) {
        if (req.p.help_bgcolor === "default") {
          fields.help_bgcolor = null;
        } else {
          fields.help_bgcolor = req.p.help_bgcolor;
        }
      }
      if (!_.isUndefined(req.p.style_btn)) {
        fields.style_btn = req.p.style_btn;
      }
      if (!_.isUndefined(req.p.write_type)) {
        fields.write_type = req.p.write_type;
      }
      if (!_.isUndefined(req.p.importance_enabled)) {
        fields.importance_enabled = req.p.importance_enabled;
      }
      if (!_.isUndefined((req.p as any).treevite_enabled)) {
        (fields as any).treevite_enabled = (req.p as any).treevite_enabled;
      }
      ifDefinedSet("auth_opt_allow_3rdparty", req.p, fields);

      if (!_.isUndefined(req.p.owner_sees_participation_stats)) {
        fields.owner_sees_participation_stats =
          !!req.p.owner_sees_participation_stats;
      }
      if (!_.isUndefined(req.p.link_url)) {
        fields.link_url = req.p.link_url;
      }

      ifDefinedSet("subscribe_type", req.p, fields);

      const q = sql_conversations
        .update(fields)
        .where(sql_conversations.zid.equals(req.p.zid))
        // .and( sql_conversations.owner.equals(req.p.uid) )
        .returning("*");
      verifyMetaPromise.then(
        function () {
          pg.query(q.toString(), function (err: any, result: { rows: any[] }) {
            if (err) {
              failJson(res, 500, "polis_err_update_conversation", err);
              return;
            }
            const conv = result && result.rows && result.rows[0];
            // The first check with isModerator implictly tells us
            // this can be returned in HTTP response.
            conv.is_mod = true;

            const promise = generateShortUrl
              ? generateAndReplaceZinvite(req.p.zid, generateShortUrl)
              : Promise.resolve();
            const successCode = generateShortUrl ? 201 : 200;

            promise
              .then(function () {
                // send notification email
                if (req.p.send_created_email) {
                  Promise.all([
                    getUserInfoForUid2(req.p.uid),
                    getConversationUrl(req, req.p.zid, true),
                  ])
                    .then(function (results: any[]) {
                      const hname = results[0].hname;
                      const url = results[1];
                      sendEmailByUid(
                        req.p.uid,
                        "Conversation created",
                        "Hi " +
                          hname +
                          ",\n" +
                          "\n" +
                          "Here's a link to the conversation you just created. Use it to invite participants to the conversation. Share it by whatever network you prefer - Gmail, Facebook, Twitter, etc., or just post it to your website or blog. Try it now! Click this link to go to your conversation:" +
                          "\n" +
                          url +
                          "\n" +
                          "\n" +
                          "With gratitude,\n" +
                          "\n" +
                          "The team at pol.is\n"
                      ).catch(function (err: any) {
                        logger.error(
                          "polis_err_sending_conversation_created_email",
                          err
                        );
                      });
                    })
                    .catch(function (err: any) {
                      logger.error(
                        "polis_err_sending_conversation_created_email",
                        err
                      );
                    });
                }

                finishOne(res, conv, true, successCode);

                updateConversationModifiedTime(req.p.zid);
              })
              .catch(function (err: any) {
                failJson(res, 500, "polis_err_update_conversation", err);
              });
          });
        },
        function (err: { message: any }) {
          failJson(res, 500, err.message, err);
        }
      );
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_update_conversation", err);
    });
}

function handle_GET_conversations(
  req: {
    p: ConversationType;
  },
  res: any
) {
  let courseIdPromise = Promise.resolve();
  if (req.p.course_invite) {
    courseIdPromise = pg
      .queryP_readOnly(
        "select course_id from courses where course_invite = ($1);",
        [req.p.course_invite]
      )
      .then(function (rows: { course_id: any }[]) {
        return rows[0].course_id;
      });
  }
  courseIdPromise.then(function (course_id: any) {
    if (course_id) {
      req.p.course_id = course_id;
    }
    const lang = null; // for now just return the default
    if (req.p.zid) {
      getOneConversation(req.p.zid, req.p.uid, lang)
        .then(
          function (data: any) {
            finishOne(res, data);
          },
          function (err: any) {
            failJson(res, 500, "polis_err_get_conversations_2", err);
          }
        )
        .catch(function (err: any) {
          failJson(res, 500, "polis_err_get_conversations_1", err);
        });
    } else if (req.p.uid || req.p.context) {
      getConversations(req, res);
    } else {
      failJson(res, 403, "polis_err_need_auth");
    }
  });
}

function handle_POST_reserve_conversation_id(
  req: ExpressRequest,
  res: ExpressResponse
) {
  const zid = 0;
  const shortUrl = false;
  // TODO check auth - maybe bot has key
  generateAndRegisterZinvite(zid, shortUrl)
    .then(function (conversation_id: any) {
      res.json({
        conversation_id: conversation_id,
      });
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_reserve_conversation_id", err);
    });
}

function handle_POST_conversations(
  req: {
    p: {
      context: any;
      short_url: any;
      uid?: any;
      org_id: any;
      topic: any;
      description: any;
      is_active: any;
      is_data_open: any;
      is_draft: any;
      is_anon: any;
      profanity_filter: any;
      spam_filter: any;
      strict_moderation: any;
      owner_sees_participation_stats: any;
      auth_needed_to_vote: any;
      auth_needed_to_write: any;
      auth_opt_allow_3rdparty: any;
      conversation_id: any;
      treevite_enabled: any;
    };
  },
  res: any
) {
  const xidStuffReady = Promise.resolve();

  xidStuffReady
    .then(() => {
      const generateShortUrl = req.p.short_url;

      isUserAllowedToCreateConversations(
        req.p.uid,
        function (err: any, isAllowed: any) {
          if (err) {
            failJson(
              res,
              403,
              "polis_err_add_conversation_failed_user_check",
              err
            );
            return;
          }
          if (!isAllowed) {
            failJson(
              res,
              403,
              "polis_err_add_conversation_not_enabled",
              new Error("polis_err_add_conversation_not_enabled")
            );
            return;
          }
          const q = sql_conversations
            .insert({
              owner: req.p.uid, // creator
              // assume the owner is the creator if there's no separate owner specified
              org_id: req.p.org_id || req.p.uid,
              topic: req.p.topic,
              description: req.p.description,
              is_active: req.p.is_active,
              is_data_open: req.p.is_data_open,
              is_draft: req.p.is_draft,
              is_public: true, // req.p.short_url,
              is_anon: req.p.is_anon,
              profanity_filter: req.p.profanity_filter,
              spam_filter: req.p.spam_filter,
              strict_moderation: req.p.strict_moderation,
              context: req.p.context || null,
              owner_sees_participation_stats:
                !!req.p.owner_sees_participation_stats,
              // Set defaults for fields that aren't set at postgres level.
              auth_needed_to_vote: DEFAULTS.auth_needed_to_vote,
              auth_needed_to_write: DEFAULTS.auth_needed_to_write,
              auth_opt_allow_3rdparty:
                req.p.auth_opt_allow_3rdparty ||
                DEFAULTS.auth_opt_allow_3rdparty,
              treevite_enabled: !!req.p.treevite_enabled,
            })
            .returning("*")
            .toString();

          pg.query(
            q,
            [],
            function (err: any, result: { rows: { zid: number }[] }) {
              if (err) {
                if (isDuplicateKey(err)) {
                  logger.error("polis_err_add_conversation", err);
                  failWithRetryRequest(res);
                } else {
                  failJson(res, 500, "polis_err_add_conversation", err);
                }
                return;
              }

              const zid =
                result && result.rows && result.rows[0] && result.rows[0].zid;

              const zinvitePromise = req.p.conversation_id
                ? getZidFromConversationId(req.p.conversation_id).then(
                    (zid: number) => {
                      return zid === 0 ? req.p.conversation_id : null;
                    }
                  )
                : generateAndRegisterZinvite(zid, generateShortUrl);

              zinvitePromise
                .then(function (zinvite: null) {
                  if (zinvite === null) {
                    failJson(
                      res,
                      400,
                      "polis_err_conversation_id_already_in_use",
                      err
                    );
                    return;
                  }
                  // NOTE: OK to return conversation_id,
                  // because this conversation was just created by this user.
                  finishOne(res, {
                    url: buildConversationUrl(req, zinvite),
                    zid: zid,
                  });
                })
                .catch(function (err: any) {
                  failJson(res, 500, "polis_err_zinvite_create", err);
                });
            }
          ); // end insert
        }
      ); // end isUserAllowedToCreateConversations
    })
    .catch((err: any) => {
      failJson(res, 500, "polis_err_conversation_create", err);
    }); // end xidStuffReady
} // end post conversations

function handle_GET_conversationPreloadInfo(
  req: { p: { conversation_id: any } },
  res: {
    status: (arg0: number) => {
      (): any;
      new (): any;
      json: { (arg0: any): void; new (): any };
    };
  }
) {
  return doGetConversationPreloadInfo(req.p.conversation_id).then(
    (conv: any) => {
      res.status(200).json(conv);
    },
    (err: any) => {
      failJson(res, 500, "polis_err_get_conversation_preload_info", err);
    }
  );
}

function handle_GET_iip_conversation(
  req: { params: { conversation_id: any } },
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: string) => void;
  }
) {
  const conversation_id = req.params.conversation_id;
  res.set({
    "Content-Type": "text/html",
  });
  res.send(
    "<a href='https://pol.is/" +
      conversation_id +
      "' target='_blank'>" +
      conversation_id +
      "</a>"
  );
}

function handle_GET_iim_conversation(
  req: { p: { zid: number }; params: { conversation_id: string } },
  res: {
    set: (arg0: { "Content-Type": string }) => void;
    send: (arg0: string) => void;
  }
) {
  const zid = req.p.zid;
  const conversation_id = req.params.conversation_id;
  getConversationInfo(zid)
    .then(function (info: ConversationInfo) {
      res.set({
        "Content-Type": "text/html",
      });
      const title = info.topic || info.created;
      res.send(
        "<a href='https://pol.is/" +
          conversation_id +
          "' target='_blank'>" +
          title +
          "</a>" +
          "<p><a href='https://pol.is/m" +
          conversation_id +
          "' target='_blank'>moderate</a></p>" +
          (info.description ? "<p>" + info.description + "</p>" : "")
      );
    })
    .catch(function (err: any) {
      failJson(res, 500, "polis_err_fetching_conversation_info", err);
    });
}

export {
  handle_GET_conversationPreloadInfo,
  handle_GET_conversations,
  handle_GET_conversationsRecentActivity,
  handle_GET_conversationsRecentlyStarted,
  handle_GET_conversationStats,
  handle_GET_iim_conversation,
  handle_GET_iip_conversation,
  handle_POST_conversation_close,
  handle_POST_conversation_reopen,
  handle_POST_conversations,
  handle_POST_reserve_conversation_id,
  handle_PUT_conversations,
};
