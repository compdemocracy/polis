// @ts-nocheck
// TODO ^^ enable typechecking after refactoring to use
// TODO modern import syntax for helpers

// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
"use strict";

import * as dotenv from "dotenv";
dotenv.config();

import Promise from "bluebird";
import express from "express";
import morgan from "morgan";
import timeout from "connect-timeout";

import server from "./src/server";
import Config from "./src/config";
import { makeFileFetcher } from "./src/utils/file-fetcher";
import logger from "./src/utils/logger";
import { fetchIndexForConversation } from "./src/conversation";
import { getPidForParticipant } from "./src/user";

import {
  middleware_check_if_options,
  middleware_log_middleware_errors,
  middleware_log_request_body,
  middleware_responseTime_start,
  middleware_http_json_logger,
  globalErrorHandler,
  setupGlobalProcessHandlers,
} from "./src/server-middleware";

import { handle_GET_conversationUuid } from "./src/routes/conversationUuid";
import { handle_GET_xidReport } from "./src/routes/export";
import {
  handle_GET_delphi,
  handle_GET_delphi_job_logs,
} from "./src/routes/delphi";
import { handle_GET_delphi_visualizations } from "./src/routes/delphi/visualizations";
import { handle_POST_delphi_jobs } from "./src/routes/delphi/jobs";
import { handle_GET_delphi_reports } from "./src/routes/delphi/reports";
import { handle_POST_delphi_batch_reports } from "./src/routes/delphi/batchReports";
import { handle_GET_participation_topicPrioritize } from "./src/routes/participation/topicPrioritize";

import {
  handle_GET_topicMod_topics,
  handle_GET_topicMod_comments,
  handle_POST_topicMod_moderate,
  handle_GET_topicMod_proximity,
  handle_GET_topicMod_hierarchy,
  handle_GET_topicMod_stats,
} from "./src/routes/delphi/topicMod";

import { handle_GET_topicStats } from "./src/routes/topicStats";

import {
  handle_POST_collectiveStatement,
  handle_GET_collectiveStatement,
} from "./src/routes/collectiveStatement";

import {
  handle_POST_topicAgenda_selections,
  handle_GET_topicAgenda_selections,
  handle_PUT_topicAgenda_selections,
  handle_DELETE_topicAgenda_selections,
} from "./src/routes/delphi/topicAgenda";

import {
  handle_GET_feeds_directory,
  handle_GET_consensus_feed,
  handle_GET_topics_feed,
} from "./src/routes/api/v3/feeds";
import { handle_GET_reportExport } from "./src/routes/export";
import { handle_GET_reportNarrative } from "./src/routes/reportNarrative";
import {
  handle_POST_auth_deregister_jwt,
  handle_POST_joinWithInvite,
} from "./src/auth";
import {
  handle_GET_comments_translations,
  handle_GET_comments,
  handle_GET_nextComment,
  handle_POST_comments_bulk,
  handle_POST_comments,
  handle_PUT_comments,
} from "./src/routes/comments";
import {
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
} from "./src/routes/conversations";
import {
  handle_DELETE_metadata_answers,
  handle_DELETE_metadata_questions,
  handle_GET_metadata_answers,
  handle_GET_metadata_choices,
  handle_GET_metadata_questions,
  handle_GET_metadata,
  handle_POST_metadata_answers,
  handle_POST_metadata_questions,
} from "./src/routes/metadata";
import {
  handle_GET_math_pca,
  handle_GET_math_pca2,
  handle_POST_math_update,
  handle_GET_math_correlationMatrix,
  handle_GET_bidToPid,
  handle_GET_xids,
  handle_POST_xidWhitelist,
  handle_GET_bid,
} from "./src/routes/math";
import {
  handle_GET_participants,
  handle_GET_participation,
  handle_GET_participationInit,
  handle_POST_participants,
  handle_POST_query_participants_by_metadata,
  handle_PUT_participants_extended,
} from "./src/routes/participation";
import {
  handle_GET_dataExport,
  handle_GET_dataExport_results,
} from "./src/routes/dataExport";
import {
  handle_GET_votes_famous,
  handle_GET_votes_me,
  handle_GET_votes,
  handle_POST_votes,
} from "./src/routes/votes";
import { handle_GET_implicit_conversation_generation } from "./src/routes/implicitConversation";
import {
  handle_GET_users,
  handle_PUT_users,
  handle_POST_users_invite,
} from "./src/routes/users";
import {
  handle_GET_notifications_subscribe,
  handle_GET_notifications_unsubscribe,
  handle_POST_convSubscriptions,
  handle_POST_notifyTeam,
} from "./src/routes/notify";
import {
  handle_GET_reports,
  handle_POST_reports,
  handle_PUT_reports,
  handle_POST_reportCommentSelections,
} from "./src/routes/reports";
import {
  handle_GET_ptptois,
  handle_PUT_ptptois,
} from "./src/routes/participantsOfInterest";
import {
  handle_POST_ptptCommentMod,
  handle_POST_upvotes,
  handle_POST_stars,
  handle_POST_trashes,
} from "./src/routes/commentMod";
import {
  handle_GET_einvites,
  handle_POST_einvites,
} from "./src/invites/routes";
import {
  handle_POST_treevite_waves,
  handle_GET_treevite_waves,
  handle_POST_treevite_acceptInvite,
  handle_POST_treevite_login,
  handle_GET_treevite_myInvites,
  handle_GET_treevite_invites,
  handle_GET_treevite_me,
  handle_GET_treevite_invites_csv,
  handle_GET_treevite_myInvites_csv,
} from "./src/invites/treevites";

import {
  attachAuthToken,
  ensureParticipant,
  ensureParticipantOptional,
  hybridAuth,
  hybridAuthOptional,
} from "./src/auth";
import {
  addCorsHeader,
  denyIfNotFromWhitelistedDomain,
  handle_GET_domainWhitelist,
  handle_POST_domainWhitelist,
  makeRedirectorTo,
  proxy,
  redirectIfNotHttps,
  writeDefaultHead,
} from "./src/utils/domain";
import {
  assignToP,
  assignToPCustom,
  getArrayOfInt,
  getArrayOfStringNonEmpty,
  getBool,
  getConversationIdFetchZid,
  getEmail,
  getInt,
  getIntInRange,
  getNumberInRange,
  getOptionalStringLimitLength,
  getReportIdFetchRid,
  getStringLimitLength,
  // getUrlLimitLength,
  moveToBody,
  need,
  resolve_pidThing,
  want,
  wantHeader,
} from "./src/utils/parameter";

const app = express();
const devMode = Config.isDevMode;
const hostname = Config.staticFilesHost;
const staticFilesAdminPort = Config.staticFilesAdminPort;
const staticFilesParticipationPort = Config.staticFilesParticipationPort;
const HMAC_SIGNATURE_PARAM_NAME = "signature";

// Dev-only http logger; Datadog JSON logger is enabled in prod via middleware
if (devMode) {
  // 'dev' format is
  // :method :url :status :response-time ms - :res[content-length]
  app.use(morgan("dev"));
} else {
  app.use(middleware_http_json_logger);
}

// Trust the X-Forwarded-Proto and X-Forwarded-Host, but only on private subnets.
// See: https://github.com/pol-is/polis/issues/546
// See: https://expressjs.com/en/guide/behind-proxies.html
app.set("trust proxy", 1);

const helpersInitialized = new Promise(function (resolve) {
  resolve(server.initializePolisHelpers());
});

helpersInitialized.then(
  function (o: any) {
    const {
      fetchIndexForAdminPage,
      fetchIndexForReportPage,
      fetchIndexWithoutPreloadData,
      haltOnTimeout,
      redirectIfHasZidButNoConversationId,

      handle_GET_conditionalIndexFetcher,
      handle_GET_contexts,
      handle_GET_dummyButton,
      handle_GET_locations,
      handle_GET_perfStats,
      handle_GET_snapshot,
      handle_GET_testConnection,
      handle_GET_testDatabase,
      handle_GET_verification,
      handle_GET_zinvites,

      handle_POST_contexts,
      handle_POST_contributors,
      handle_POST_metrics,
      handle_POST_sendCreatedLinkToEmail,
      handle_POST_sendEmailExportReady,
      handle_POST_tutorial,
      handle_POST_zinvites,
    } = o;

    app.disable("x-powered-by");
    // app.disable('etag'); // seems to be eating CPU, and we're not using etags yet. https://www.dropbox.com/s/hgfd5dm0e29728w/Screenshot%202015-06-01%2023.42.47.png?dl=0

    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    //
    //             BEGIN MIDDLEWARE
    //
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////

    app.use(middleware_responseTime_start);

    app.use(redirectIfNotHttps);
    app.use(express.bodyParser());
    app.use(express.cookieParser()); // Add cookie parser to access req.cookies
    app.use(writeDefaultHead);

    app.use(express.compress());
    app.use(middleware_log_request_body);
    app.use(middleware_log_middleware_errors);

    app.all("/api/v3/*", addCorsHeader);
    app.all("/font/*", addCorsHeader);
    app.all("/api/v3/*", middleware_check_if_options);

    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    //
    //             END MIDDLEWARE
    //
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////
    ////////////////////////////////////////////

    app.get("/api/v3/math/pca", handle_GET_math_pca);

    app.get(
      "/api/v3/math/pca2",
      moveToBody,
      redirectIfHasZidButNoConversationId, // TODO remove once
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("math_tick", getInt, assignToP),
      wantHeader(
        "If-None-Match",
        getStringLimitLength(1000),
        assignToPCustom("ifNoneMatch")
      ),
      handle_GET_math_pca2
    );

    app.get(
      "/api/v3/math/correlationMatrix",
      moveToBody,
      // need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
      need("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      want("math_tick", getInt, assignToP, -1),
      handle_GET_math_correlationMatrix
    );

    app.get(
      "/api/v3/dataExport",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      want("format", getStringLimitLength(1, 100), assignToP),
      want("unixTimestamp", getStringLimitLength(99), assignToP),
      handle_GET_dataExport
    );

    app.get(
      "/api/v3/reportExport/:report_id/:report_type",
      moveToBody,
      need("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      need("report_id", getStringLimitLength(1, 1000), assignToP),
      need("report_type", getStringLimitLength(1, 1000), assignToP),
      handle_GET_reportExport
    );

    app.get(
      "/api/v3/dataExport/results",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      want("filename", getStringLimitLength(1, 1000), assignToP),
      handle_GET_dataExport_results
    );

    // TODO doesn't scale, stop sending entire mapping.
    app.get(
      "/api/v3/bidToPid",
      hybridAuthOptional(assignToP),
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("math_tick", getInt, assignToP, 0),
      handle_GET_bidToPid
    );

    app.get(
      "/api/v3/xid/:xid_report",
      moveToBody,
      need("xid_report", getStringLimitLength(1, 99), assignToP),
      handle_GET_xidReport
    );

    app.get(
      "/api/v3/xids",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_xids
    );

    // TODO cache
    app.get(
      "/api/v3/bid",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("math_tick", getInt, assignToP, 0),
      handle_GET_bid
    );

    app.post("/api/v3/auth/deregister", handle_POST_auth_deregister_jwt);

    app.get(
      "/api/v3/zinvites/:zid",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_zinvites
    );

    app.post(
      "/api/v3/zinvites/:zid",
      moveToBody,
      hybridAuth(assignToP),
      want("short_url", getBool, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_zinvites
    );

    // // tags: ANON_RELATED
    app.get(
      "/api/v3/participants",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_participants
    );

    app.get(
      "/api/v3/dummyButton",
      moveToBody,
      need("button", getStringLimitLength(1, 999), assignToP),
      hybridAuthOptional(assignToP),
      handle_GET_dummyButton
    );

    app.get(
      "/api/v3/conversations/preload",
      moveToBody,
      need("conversation_id", getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
      handle_GET_conversationPreloadInfo
    );

    app.get(
      "/api/v3/conversations/recently_started",
      hybridAuth(assignToP),
      moveToBody,
      want("sinceUnixTimestamp", getStringLimitLength(99), assignToP),
      handle_GET_conversationsRecentlyStarted
    );

    app.get(
      "/api/v3/conversations/recent_activity",
      hybridAuth(assignToP),
      moveToBody,
      want("sinceUnixTimestamp", getStringLimitLength(99), assignToP),
      handle_GET_conversationsRecentActivity
    );

    app.post(
      "/api/v3/participants",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("answers", getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
      want("parent_url", getStringLimitLength(9999), assignToP),
      want("referrer", getStringLimitLength(9999), assignToP),
      handle_POST_participants
    );

    app.get(
      "/api/v3/notifications/subscribe",
      moveToBody,
      need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // we actually need conversation_id to build a url
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      need("email", getEmail, assignToP),
      handle_GET_notifications_subscribe
    );

    app.get(
      "/api/v3/notifications/unsubscribe",
      moveToBody,
      need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // we actually need conversation_id to build a url
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      need("email", getEmail, assignToP),
      handle_GET_notifications_unsubscribe
    );

    app.post(
      "/api/v3/convSubscriptions",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("type", getInt, assignToP),
      need("email", getEmail, assignToP),
      handle_POST_convSubscriptions
    );

    app.post(
      "/api/v3/joinWithInvite",
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("suzinvite", getOptionalStringLimitLength(32), assignToP),
      want("answers", getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
      want("referrer", getStringLimitLength(9999), assignToP),
      want("parent_url", getStringLimitLength(9999), assignToP),
      handle_POST_joinWithInvite
    );

    app.get("/perfStats_9182738127", moveToBody, handle_GET_perfStats);

    app.post(
      "/api/v3/sendEmailExportReady",
      need("webserver_username", getStringLimitLength(1, 999), assignToP),
      need("webserver_pass", getStringLimitLength(1, 999), assignToP),
      need("email", getEmail, assignToP),
      // we actually need conversation_id to build a url
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      need("filename", getStringLimitLength(9999), assignToP),
      handle_POST_sendEmailExportReady
    );

    app.post(
      "/api/v3/notifyTeam",
      need("webserver_username", getStringLimitLength(1, 999), assignToP),
      need("webserver_pass", getStringLimitLength(1, 999), assignToP),
      need("subject", getStringLimitLength(9999), assignToP),
      need("body", getStringLimitLength(99999), assignToP),
      handle_POST_notifyTeam
    );

    app.get(
      "/api/v3/domainWhitelist",
      moveToBody,
      hybridAuth(assignToP),
      handle_GET_domainWhitelist
    );

    app.post(
      "/api/v3/domainWhitelist",
      hybridAuth(assignToP),
      need(
        "domain_whitelist",
        getOptionalStringLimitLength(999),
        assignToP,
        ""
      ),
      handle_POST_domainWhitelist
    );

    app.post(
      "/api/v3/xidWhitelist",
      hybridAuth(assignToP),
      need("xid_whitelist", getArrayOfStringNonEmpty, assignToP),
      handle_POST_xidWhitelist
    );

    app.get(
      "/api/v3/conversationStats",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      want("until", getInt, assignToP),
      handle_GET_conversationStats
    );

    app.get(
      "/api/v3/conversationUuid",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_conversationUuid
    );

    app.get(
      "/api/v3/snapshot",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_snapshot
    );

    app.post(
      "/api/v3/tutorial",
      hybridAuth(assignToP),
      need("step", getInt, assignToP),
      handle_POST_tutorial
    );

    app.get(
      "/api/v3/users",
      moveToBody,
      hybridAuthOptional(assignToP),
      want("xid", getStringLimitLength(1, 999), assignToP),
      want("owner_uid", getInt, assignToP),
      handle_GET_users
    );

    app.get(
      "/api/v3/participation",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("strict", getBool, assignToP),
      handle_GET_participation
    );

    app.get(
      "/api/v3/comments",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // if you want to get report-specific info
      want("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      want("tids", getArrayOfInt, assignToP),
      want("moderation", getBool, assignToP),
      want("mod", getInt, assignToP),
      // set this to true if you want to see the comments that are ptpt-visible given the current "strict mod" setting, or false for ptpt-invisible comments.
      want("modIn", getBool, assignToP),
      want("mod_gt", getInt, assignToP),
      want("include_voting_patterns", getBool, assignToP, false),
      want("limit", getInt, assignToP),
      want("offset", getInt, assignToP),
      resolve_pidThing("pid", assignToP, "get:comments:pid"),
      handle_GET_comments
    );

    app.post(
      "/api/v3/comments",
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("xid", getStringLimitLength(1, 999), assignToP), // Process XID before ensureParticipant
      ensureParticipant({ createIfMissing: true, issueJWT: true }),
      need("txt", getStringLimitLength(1, 997), assignToP),
      want("vote", getIntInRange(-1, 1), assignToP),
      want("is_seed", getBool, assignToP),
      attachAuthToken(),
      handle_POST_comments
    );

    // bulk upload csv of seed statements
    app.post(
      "/api/v3/comments-bulk",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("is_seed", getBool, assignToP),
      want("xid", getStringLimitLength(1, 999), assignToP),
      resolve_pidThing("pid", assignToP, "post:comments-bulk"),
      handle_POST_comments_bulk
    );

    app.get(
      "/api/v3/comments/translations",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("tid", getInt, assignToP),
      want("lang", getStringLimitLength(1, 10), assignToP),
      handle_GET_comments_translations
    );

    app.get(
      "/api/v3/votes/me",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_votes_me
    );

    app.get(
      "/api/v3/votes",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("tid", getInt, assignToP),
      resolve_pidThing("pid", assignToP, "get:votes"),
      handle_GET_votes
    );

    app.get(
      "/api/v3/nextComment",
      timeout(15000),
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      resolve_pidThing("not_voted_by_pid", assignToP, "get:nextComment"),
      want("without", getArrayOfInt, assignToP),
      // preferred language of nextComment
      want("lang", getStringLimitLength(1, 10), assignToP),
      ensureParticipantOptional({ createIfMissing: false, issueJWT: false }),
      haltOnTimeout,
      handle_GET_nextComment
    );

    app.get("/api/v3/testConnection", moveToBody, handle_GET_testConnection);

    app.get("/api/v3/testDatabase", moveToBody, handle_GET_testDatabase);

    app.get("/api/v3/delphi", moveToBody, handle_GET_delphi);

    app.get("/api/v3/delphi/logs", moveToBody, handle_GET_delphi_job_logs);

    // Add POST endpoint for creating Delphi jobs
    app.post(
      "/api/v3/delphi/jobs",
      moveToBody,
      hybridAuth(assignToP),
      function (req, res) {
        try {
          handle_POST_delphi_jobs(req, res);
        } catch (err) {
          res.json({
            status: "error",
            message: "Internal server error in job creation endpoint",
            error: err.message || "Unknown error",
          });
        }
      }
    );

    // Add GET endpoint for Delphi reports
    app.get("/api/v3/delphi/reports", moveToBody, function (req, res) {
      try {
        handle_GET_delphi_reports(req, res);
      } catch (err) {
        res.json({
          status: "error",
          message: "Internal server error in reports endpoint",
          error: err.message || "Unknown error",
        });
      }
    });

    // Use the directly imported handler from the top of the file

    // Add error handling wrapper for async route handler
    app.get("/api/v3/delphi/visualizations", moveToBody, function (req, res) {
      try {
        handle_GET_delphi_visualizations(req, res);
      } catch (err) {
        res.json({
          status: "error",
          message: "Internal server error in visualizations endpoint",
          error: err.message || "Unknown error",
        });
      }
    });

    // Add POST endpoint for batch report generation
    app.post(
      "/api/v3/delphi/batchReports",
      moveToBody,
      hybridAuth(assignToP),
      function (req, res) {
        try {
          handle_POST_delphi_batch_reports(req, res);
        } catch (err) {
          res.json({
            status: "error",
            message: "Internal server error in batch reports endpoint",
            error: err.message || "Unknown error",
          });
        }
      }
    );

    // TopicMod endpoints for topic-based moderation
    app.get(
      "/api/v3/topicMod/topics",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_topicMod_topics
    );

    app.get(
      "/api/v3/topicMod/topics/:topicKey/comments",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_topicMod_comments
    );

    app.post(
      "/api/v3/topicMod/moderate",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_topicMod_moderate
    );

    app.get(
      "/api/v3/topicMod/proximity",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_topicMod_proximity
    );

    app.get(
      "/api/v3/topicMod/stats",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_topicMod_stats
    );

    app.get(
      "/api/v3/topicMod/hierarchy",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_topicMod_hierarchy
    );

    app.get("/api/v3/topicStats", moveToBody, function (req, res) {
      try {
        handle_GET_topicStats(req, res);
      } catch (err) {
        res.json({
          status: "error",
          message: "Internal server error in topicStats endpoint",
          error: err.message || "Unknown error",
        });
      }
    });

    // Collective Statement routes
    app.post(
      "/api/v3/collectiveStatement",
      moveToBody,
      hybridAuth(assignToP),
      function (req, res) {
        try {
          handle_POST_collectiveStatement(req, res);
        } catch (err) {
          res.json({
            status: "error",
            message: "Internal server error in collectiveStatement endpoint",
            error: err.message || "Unknown error",
          });
        }
      }
    );

    app.get("/api/v3/collectiveStatement", moveToBody, function (req, res) {
      try {
        handle_GET_collectiveStatement(req, res);
      } catch (err) {
        res.json({
          status: "error",
          message: "Internal server error in collectiveStatement endpoint",
          error: err.message || "Unknown error",
        });
      }
    });

    // Topic Agenda routes
    app.post(
      "/api/v3/topicAgenda/selections",
      hybridAuthOptional(assignToP),
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipant({ createIfMissing: true, issueJWT: true }),
      attachAuthToken(),
      handle_POST_topicAgenda_selections
    );

    app.get(
      "/api/v3/topicAgenda/selections",
      hybridAuthOptional(assignToP),
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipantOptional({ createIfMissing: false, issueJWT: false }),
      handle_GET_topicAgenda_selections
    );

    app.put(
      "/api/v3/topicAgenda/selections",
      hybridAuth(assignToP),
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipant({ createIfMissing: false, issueJWT: false }),
      handle_PUT_topicAgenda_selections
    );

    app.delete(
      "/api/v3/topicAgenda/selections",
      hybridAuth(assignToP),
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipant({ createIfMissing: false, issueJWT: false }),
      handle_DELETE_topicAgenda_selections
    );

    // RSS Feeds routes
    app.get("/feeds/:reportId", function (req, res) {
      try {
        handle_GET_feeds_directory(req, res);
      } catch (err) {
        res.status(500).send(`
          <html><head><title>Error</title></head><body>
            <h1>Error</h1>
            <p>Internal server error: ${err.message || "Unknown error"}</p>
          </body></html>
        `);
      }
    });

    app.get("/feeds/:reportId/consensus", function (req, res) {
      try {
        handle_GET_consensus_feed(req, res);
      } catch (err) {
        res.status(500).set("Content-Type", "application/rss+xml").send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Error</title>
              <description>Internal server error: ${
                err.message || "Unknown error"
              }</description>
            </channel>
          </rss>
        `);
      }
    });

    app.get("/feeds/:reportId/topics", function (req, res) {
      try {
        handle_GET_topics_feed(req, res);
      } catch (err) {
        res.status(500).set("Content-Type", "application/rss+xml").send(`
          <?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Error</title>
              <description>Internal server error: ${
                err.message || "Unknown error"
              }</description>
            </channel>
          </rss>
        `);
      }
    });

    app.get("/robots.txt", function (req, res) {
      res.send("User-agent: *\n" + "Disallow: /api/");
    });

    app.get(
      "/api/v3/participationInit",
      moveToBody,
      hybridAuthOptional(assignToP),
      want("ptptoiLimit", getInt, assignToP),
      want(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("includePCA", getBool, assignToP),
      want("conversation_id", getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
      want("lang", getStringLimitLength(1, 10), assignToP), // preferred language of nextComment
      want(
        "domain_whitelist_override_key",
        getStringLimitLength(1, 1000),
        assignToP
      ),
      denyIfNotFromWhitelistedDomain, // this seems like the easiest place to enforce the domain whitelist. The index.html is cached on cloudflare, so that's not the right place.
      want("xid", getStringLimitLength(1, 999), assignToP),
      ensureParticipantOptional({
        createIfMissing: false, // Don't create new participants
        issueJWT: true, // Issue JWT for existing participants
      }),
      handle_GET_participationInit
    );

    // New endpoint for topic prioritization in participation interface
    app.get(
      "/api/v3/participation/topicPrioritize",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // Preserve the original conversation_id for the response
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      handle_GET_participation_topicPrioritize
    );

    app.post(
      "/api/v3/votes",
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("xid", getStringLimitLength(1, 999), assignToP), // Process XID before ensureParticipant
      ensureParticipant({ createIfMissing: true, issueJWT: true }),
      need("tid", getInt, assignToP),
      need("vote", getIntInRange(-1, 1), assignToP),
      want("starred", getBool, assignToP),
      want("high_priority", getBool, assignToP, false),
      want("lang", getStringLimitLength(1, 10), assignToP),
      attachAuthToken(),
      handle_POST_votes
    );

    app.put(
      "/api/v3/participants_extended",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("show_translation_activated", getBool, assignToP),
      handle_PUT_participants_extended
    );

    app.post(
      "/api/v3/ptptCommentMod",
      hybridAuth(assignToP),
      need("tid", getInt, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("as_abusive", getBool, assignToP, null),
      want("as_factual", getBool, assignToP, null),
      want("as_feeling", getBool, assignToP, null),
      want("as_important", getBool, assignToP, null),
      want("as_notfact", getBool, assignToP, null),
      want("as_notgoodidea", getBool, assignToP, null),
      want("as_notmyfeeling", getBool, assignToP, null),
      want("as_offtopic", getBool, assignToP, null),
      want("as_spam", getBool, assignToP, null),
      want("as_unsure", getBool, assignToP, null),
      getPidForParticipant(assignToP),
      handle_POST_ptptCommentMod
    );

    app.post(
      "/api/v3/upvotes",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_upvotes
    );

    app.post(
      "/api/v3/stars",
      hybridAuth(assignToP),
      need("tid", getInt, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("starred", getIntInRange(0, 1), assignToP),
      getPidForParticipant(assignToP),
      handle_POST_stars
    );

    app.post(
      "/api/v3/trashes",
      hybridAuth(assignToP),
      need("tid", getInt, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("trashed", getIntInRange(0, 1), assignToP),
      getPidForParticipant(assignToP),
      handle_POST_trashes
    );

    app.put(
      "/api/v3/comments",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("tid", getInt, assignToP),
      need("active", getBool, assignToP),
      need("mod", getInt, assignToP),
      need("is_meta", getBool, assignToP),
      need("velocity", getNumberInRange(0, 1), assignToP),
      handle_PUT_comments
    );

    app.post(
      "/api/v3/reportCommentSelections",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      need("tid", getInt, assignToP),
      need("include", getBool, assignToP),
      handle_POST_reportCommentSelections
    );

    app.post(
      "/api/v3/conversation/close",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_conversation_close
    );

    app.post(
      "/api/v3/conversation/reopen",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_conversation_reopen
    );

    app.put(
      "/api/v3/conversations",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // we actually need conversation_id to build a url
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      want("is_active", getBool, assignToP),
      want("is_anon", getBool, assignToP),
      want("is_draft", getBool, assignToP, false),
      want("is_data_open", getBool, assignToP, false),
      want("owner_sees_participation_stats", getBool, assignToP, false),
      want("profanity_filter", getBool, assignToP),
      want("short_url", getBool, assignToP, false),
      want("spam_filter", getBool, assignToP),
      want("strict_moderation", getBool, assignToP),
      want("topic", getOptionalStringLimitLength(1000), assignToP),
      want("description", getOptionalStringLimitLength(50000), assignToP),
      want("importance_enabled", getBool, assignToP),
      want("vis_type", getInt, assignToP),
      want("help_type", getInt, assignToP),
      want("write_type", getInt, assignToP),
      want("socialbtn_type", getInt, assignToP),
      want("bgcolor", getOptionalStringLimitLength(20), assignToP),
      want("help_color", getOptionalStringLimitLength(20), assignToP),
      want("help_bgcolor", getOptionalStringLimitLength(20), assignToP),
      want("style_btn", getOptionalStringLimitLength(500), assignToP),
      want("auth_needed_to_vote", getBool, assignToP),
      want("auth_needed_to_write", getBool, assignToP),
      want("auth_opt_allow_3rdparty", getBool, assignToP),
      want("verifyMeta", getBool, assignToP),
      want("send_created_email", getBool, assignToP), // ideally the email would be sent on the post, but we post before they click create to allow owner to prepopulate comments.
      want("context", getOptionalStringLimitLength(999), assignToP),
      want("link_url", getStringLimitLength(1, 9999), assignToP),
      want("subscribe_type", getInt, assignToP),
      want("treevite_enabled", getBool, assignToP, false),
      handle_PUT_conversations
    );

    app.put(
      "/api/v3/users",
      moveToBody,
      hybridAuth(assignToP),
      want("email", getEmail, assignToP),
      want("hname", getOptionalStringLimitLength(9999), assignToP),
      want("uid_of_user", getInt, assignToP),
      handle_PUT_users
    );

    app.delete(
      "/api/v3/metadata/questions/:pmqid",
      moveToBody,
      hybridAuth(assignToP),
      need("pmqid", getInt, assignToP),
      handle_DELETE_metadata_questions
    );

    app.delete(
      "/api/v3/metadata/answers/:pmaid",
      moveToBody,
      hybridAuth(assignToP),
      need("pmaid", getInt, assignToP),
      handle_DELETE_metadata_answers
    );

    app.get(
      "/api/v3/metadata/questions",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("suzinvite", getOptionalStringLimitLength(32), assignToP),
      want("zinvite", getOptionalStringLimitLength(300), assignToP),
      // TODO want('lastMetaTime', getInt, assignToP, 0),
      handle_GET_metadata_questions
    );

    app.post(
      "/api/v3/metadata/questions",
      moveToBody,
      hybridAuth(assignToP),
      need("key", getOptionalStringLimitLength(999), assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_POST_metadata_questions
    );

    app.post(
      "/api/v3/metadata/answers",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("pmqid", getInt, assignToP),
      need("value", getOptionalStringLimitLength(999), assignToP),
      handle_POST_metadata_answers
    );

    app.get(
      "/api/v3/metadata/choices",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_metadata_choices
    );

    app.get(
      "/api/v3/metadata/answers",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("pmqid", getInt, assignToP),
      want("suzinvite", getOptionalStringLimitLength(32), assignToP),
      want("zinvite", getOptionalStringLimitLength(300), assignToP),
      // TODO want('lastMetaTime', getInt, assignToP, 0),
      handle_GET_metadata_answers
    );

    app.get(
      "/api/v3/metadata",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("zinvite", getOptionalStringLimitLength(300), assignToP),
      want("suzinvite", getOptionalStringLimitLength(32), assignToP),
      // TODO want('lastMetaTime', getInt, assignToP, 0),
      handle_GET_metadata
    );

    app.get(
      "/api/v3/conversations",
      moveToBody,
      hybridAuthOptional(assignToP),
      want("include_all_conversations_i_am_in", getBool, assignToP),
      want("is_active", getBool, assignToP),
      want("is_draft", getBool, assignToP),
      want("course_invite", getStringLimitLength(1, 32), assignToP),
      want(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("want_upvoted", getBool, assignToP),
      want("want_mod_url", getBool, assignToP), // NOTE - use this for API only!
      want("want_inbox_item_admin_url", getBool, assignToP), // NOTE - use this for API only!
      want("want_inbox_item_participant_url", getBool, assignToP), // NOTE - use this for API only!
      want("want_inbox_item_admin_html", getBool, assignToP), // NOTE - use this for API only!
      want("want_inbox_item_participant_html", getBool, assignToP), // NOTE - use this for API only!
      want("limit", getIntInRange(1, 9999), assignToP), // not allowing a super high limit to prevent DOS attacks
      want("context", getStringLimitLength(1, 999), assignToP),
      want("xid", getStringLimitLength(1, 999), assignToP),
      handle_GET_conversations
    );

    app.get(
      "/api/v3/reports",
      moveToBody,
      hybridAuthOptional(assignToP),
      want(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("report_id", getReportIdFetchRid, assignToPCustom("rid")), // Knowing the report_id grants the user permission to view the report
      handle_GET_reports
    );

    app.get(
      "/api/v3/reportNarrative",
      hybridAuth(assignToP),
      moveToBody,
      need("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      handle_GET_reportNarrative
    );

    app.post(
      "/api/v3/mathUpdate",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("math_update_type", getStringLimitLength(1, 32), assignToP), // expecting "recompute" or "update"
      handle_POST_math_update
    );

    app.post(
      "/api/v3/reports",
      hybridAuth(assignToP),
      want(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("mod_level", getInt, assignToPCustom("mod_level")),
      handle_POST_reports
    );

    app.put(
      "/api/v3/reports",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("report_id", getReportIdFetchRid, assignToPCustom("rid")),
      want("report_name", getStringLimitLength(999), assignToP),
      want("label_x_neg", getStringLimitLength(999), assignToP),
      want("label_x_pos", getStringLimitLength(999), assignToP),
      want("label_y_neg", getStringLimitLength(999), assignToP),
      want("label_y_pos", getStringLimitLength(999), assignToP),
      want("label_group_0", getStringLimitLength(999), assignToP),
      want("label_group_1", getStringLimitLength(999), assignToP),
      want("label_group_2", getStringLimitLength(999), assignToP),
      want("label_group_3", getStringLimitLength(999), assignToP),
      want("label_group_4", getStringLimitLength(999), assignToP),
      want("label_group_5", getStringLimitLength(999), assignToP),
      want("label_group_6", getStringLimitLength(999), assignToP),
      want("label_group_7", getStringLimitLength(999), assignToP),
      want("label_group_8", getStringLimitLength(999), assignToP),
      want("label_group_9", getStringLimitLength(999), assignToP),
      handle_PUT_reports
    );

    app.get(
      "/api/v3/contexts",
      moveToBody,
      hybridAuthOptional(assignToP),
      handle_GET_contexts
    );

    app.post(
      "/api/v3/contexts",
      hybridAuth(assignToP),
      need("name", getStringLimitLength(1, 300), assignToP),
      handle_POST_contexts
    );

    app.post(
      "/api/v3/reserve_conversation_id",
      hybridAuth(assignToP),
      handle_POST_reserve_conversation_id
    );

    // TODO check to see if ptpt has answered necessary metadata questions.
    app.post(
      "/api/v3/conversations",
      hybridAuth(assignToP),
      want("is_active", getBool, assignToP, true),
      want("is_draft", getBool, assignToP, false),
      want("is_anon", getBool, assignToP, false),
      want("owner_sees_participation_stats", getBool, assignToP, false),
      want("profanity_filter", getBool, assignToP, true),
      want("short_url", getBool, assignToP, false),
      want("spam_filter", getBool, assignToP, true),
      want("strict_moderation", getBool, assignToP, false),
      want("context", getOptionalStringLimitLength(999), assignToP, ""),
      want("topic", getOptionalStringLimitLength(1000), assignToP, ""),
      want("description", getOptionalStringLimitLength(50000), assignToP, ""),
      want("conversation_id", getStringLimitLength(6, 300), assignToP, ""),
      want("is_data_open", getBool, assignToP, false),
      want("ownerXid", getStringLimitLength(1, 999), assignToP),
      want("treevite_enabled", getBool, assignToP, false),
      handle_POST_conversations
    );

    app.post(
      "/api/v3/query_participants_by_metadata",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("pmaids", getArrayOfInt, assignToP, []),
      handle_POST_query_participants_by_metadata
    );

    app.post(
      "/api/v3/sendCreatedLinkToEmail",
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // Preserve the original conversation_id for the email link
      need("conversation_id", getStringLimitLength(1, 100), assignToP),
      handle_POST_sendCreatedLinkToEmail
    );

    app.get(
      "/api/v3/locations",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("gid", getInt, assignToP),
      handle_GET_locations
    );

    app.put(
      "/api/v3/ptptois",
      moveToBody,
      hybridAuth(assignToP),
      need("mod", getInt, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      resolve_pidThing("pid", assignToP, "put:ptptois"),
      handle_PUT_ptptois
    );

    app.get(
      "/api/v3/ptptois",
      moveToBody,
      hybridAuthOptional(assignToP),
      want("mod", getInt, assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      handle_GET_ptptois
    );

    app.get(
      "/api/v3/votes/famous",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("math_tick", getInt, assignToP, -1),
      want("ptptoiLimit", getIntInRange(0, 99), assignToP),
      handle_GET_votes_famous
    );

    app.post(
      "/api/v3/treevite/waves",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("invites_per_user", getInt, assignToP),
      want("owner_invites", getInt, assignToP),
      want("parent_wave", getInt, assignToP),
      handle_POST_treevite_waves
    );

    app.get(
      "/api/v3/treevite/waves",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("wave", getInt, assignToP),
      handle_GET_treevite_waves
    );

    app.post(
      "/api/v3/treevite/acceptInvite",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("invite_code", getStringLimitLength(1, 128), assignToP),
      handle_POST_treevite_acceptInvite
    );

    app.post(
      "/api/v3/treevite/login",
      moveToBody,
      hybridAuthOptional(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      need("login_code", getStringLimitLength(1, 256), assignToP),
      handle_POST_treevite_login
    );

    app.get(
      "/api/v3/treevite/myInvites",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipantOptional({ createIfMissing: false, issueJWT: false }),
      handle_GET_treevite_myInvites
    );

    app.get(
      "/api/v3/treevite/invites",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      want("wave_id", getInt, assignToP),
      want("status", getInt, assignToP),
      want("limit", getInt, assignToP),
      want("offset", getInt, assignToP),
      handle_GET_treevite_invites
    );

    app.get(
      "/api/v3/treevite/invites/csv",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_treevite_invites_csv
    );

    app.get(
      "/api/v3/treevite/me",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipantOptional({ createIfMissing: false, issueJWT: false }),
      handle_GET_treevite_me
    );

    app.get(
      "/api/v3/treevite/myInvites/csv",
      moveToBody,
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      ensureParticipantOptional({ createIfMissing: false, issueJWT: false }),
      handle_GET_treevite_myInvites_csv
    );

    app.post(
      "/api/v3/einvites",
      need("email", getEmail, assignToP),
      handle_POST_einvites
    );

    app.get(
      "/api/v3/einvites",
      moveToBody,
      need("einvite", getStringLimitLength(1, 100), assignToP),
      handle_GET_einvites
    );

    app.post(
      "/api/v3/users/invite",
      // authWithApiKey(assignToP),
      hybridAuth(assignToP),
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      // we actually need conversation_id to build a url
      need("conversation_id", getStringLimitLength(1, 1000), assignToP),
      // need('single_use_tokens', getBool, assignToP),
      need("emails", getArrayOfStringNonEmpty, assignToP),
      handle_POST_users_invite
    );

    app.get(
      /^\/polis_site_id.*/,
      moveToBody,
      need("parent_url", getStringLimitLength(1, 10000), assignToP),
      want("referrer", getStringLimitLength(1, 10000), assignToP),
      want("auth_needed_to_vote", getBool, assignToP),
      want("auth_needed_to_write", getBool, assignToP),
      want("auth_opt_allow_3rdparty", getBool, assignToP),
      want("show_vis", getBool, assignToP),
      want("show_share", getBool, assignToP),
      want("bg_white", getBool, assignToP),
      want("topic", getStringLimitLength(1, 1000), assignToP),
      want("ucv", getBool, assignToP), // not persisted
      want("ucw", getBool, assignToP), // not persisted
      want("ucsh", getBool, assignToP), // not persisted
      want("ucst", getBool, assignToP), // not persisted
      want("ucsd", getBool, assignToP), // not persisted
      want("ucsv", getBool, assignToP), // not persisted
      want("ucsf", getBool, assignToP), // not persisted
      want("ui_lang", getStringLimitLength(1, 10), assignToP), // not persisted
      want("dwok", getStringLimitLength(1, 1000), assignToP), // not persisted
      want("xid", getStringLimitLength(1, 999), assignToP), // not persisted
      want("subscribe_type", getStringLimitLength(1, 9), assignToP), // not persisted
      want("x_name", getStringLimitLength(1, 746), assignToP), // not persisted here, but later on POST vote/comment
      want("x_profile_image_url", getStringLimitLength(1, 3000), assignToP), // not persisted here, but later on POST vote/comment
      want("x_email", getStringLimitLength(256), assignToP), // not persisted here, but later on POST vote/comment
      want("build", getStringLimitLength(300), assignToP),
      handle_GET_implicit_conversation_generation
    );

    app.get(
      "/iip/:conversation_id",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_iip_conversation
    );

    app.get(
      "/iim/:conversation_id",
      moveToBody,
      need(
        "conversation_id",
        getConversationIdFetchZid,
        assignToPCustom("zid")
      ),
      handle_GET_iim_conversation
    );

    app.get(
      "/api/v3/verify",
      moveToBody,
      need("e", getStringLimitLength(1, 1000), assignToP),
      handle_GET_verification
    );

    app.post(
      "/api/v3/contributors",
      hybridAuthOptional(assignToP),
      need("agreement_version", getIntInRange(1, 999999), assignToP),
      need("name", getStringLimitLength(746), assignToP),
      need("email", getStringLimitLength(256), assignToP),
      need("github_id", getStringLimitLength(256), assignToP),
      need("company_name", getStringLimitLength(746), assignToP),
      handle_POST_contributors
    );

    app.post(
      "/api/v3/metrics",
      hybridAuthOptional(assignToP),
      need("types", getArrayOfInt, assignToP),
      need("times", getArrayOfInt, assignToP),
      need("durs", getArrayOfInt, assignToP),
      need("clientTimestamp", getInt, assignToP),
      handle_POST_metrics
    );

    function makeFetchIndexWithoutPreloadData() {
      const port = staticFilesParticipationPort;
      return function (req, res) {
        return fetchIndexWithoutPreloadData(req, res, port);
      };
    }

    // Conversation aliases
    app.get(/^\/football$/, makeRedirectorTo("/2arcefpshi"));
    app.get(/^\/pdf$/, makeRedirectorTo("/23mymwyhkn")); // pdf 2017
    app.get(/^\/nabi$/, makeRedirectorTo("/8ufpzc6fkm")); //

    app.get(/^\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // conversation view
    app.get(/^\/explore\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // power view
    app.get(/^\/share\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // share view
    app.get(/^\/summary\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // summary view
    app.get(/^\/ot\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // conversation view, one-time url
    // TODO consider putting static files on /static, and then using a catch-all to serve the index.
    app.get(/^\/conversation\/create(\/.*)?/, fetchIndexWithoutPreloadData);
    app.get(/^\/user\/create(\/.*)?$/, fetchIndexWithoutPreloadData);
    app.get(/^\/user\/login(\/.*)?$/, fetchIndexWithoutPreloadData);

    app.get(/^\/settings(\/.*)?$/, makeFetchIndexWithoutPreloadData());

    app.get(/^\/user\/logout(\/.*)?$/, fetchIndexWithoutPreloadData);

    // admin dash routes
    app.get(/^\/m\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/integrate(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/other-conversations(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/account(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/bot(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/conversations(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/signout(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/signin(\/.*)?/, fetchIndexForAdminPage);
    app.get(
      /^\/dist\/admin_bundle.js$/,
      makeFileFetcher(hostname, staticFilesAdminPort, "/dist/admin_bundle.js", {
        "Content-Type": "application/javascript",
      })
    );
    app.get(
      /^\/__webpack_hmr$/,
      makeFileFetcher(hostname, staticFilesAdminPort, "/__webpack_hmr", {
        "Content-Type": "eventsource",
      })
    );
    app.get(/^\/privacy$/, fetchIndexForAdminPage);
    app.get(/^\/tos$/, fetchIndexForAdminPage);
    app.get(/^\/donate$/, fetchIndexForAdminPage);

    // admin dash-based landers
    app.get(/^\/gov(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/createuser(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/contrib(\/.*)?/, fetchIndexForAdminPage);

    app.get(/^\/bot\/install(\/.*)?/, fetchIndexForAdminPage);
    app.get(/^\/bot\/support(\/.*)?/, fetchIndexForAdminPage);

    app.get(/^\/inbox(\/.*)?$/, fetchIndexWithoutPreloadData);
    // app.get(/^\/r/, fetchIndexWithoutPreloadData);
    app.get(/^\/hk/, fetchIndexWithoutPreloadData);
    app.get(/^\/s\//, fetchIndexWithoutPreloadData);
    app.get(/^\/s$/, fetchIndexWithoutPreloadData);
    app.get(/^\/hk\/new/, fetchIndexWithoutPreloadData);
    app.get(/^\/inboxApiTest/, fetchIndexWithoutPreloadData);
    app.get(/^\/pwresetinit.*/, fetchIndexForAdminPage);
    app.get(/^\/demo\/[0-9][0-9A-Za-z]+/, fetchIndexForConversation);
    app.get(/^\/demo$/, fetchIndexForAdminPage);
    app.get(/^\/pwreset.*/, fetchIndexForAdminPage);
    app.get(/^\/company$/, fetchIndexForAdminPage);

    app.get(/^\/report\/r?[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForReportPage);
    app.get(
      /^\/narrativeReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      fetchIndexForReportPage
    );
    app.get(/^\/stats\/r?[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForReportPage);
    // Report route for LLM-generated group topics
    app.get(
      /^\/commentsReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    // Topic Report route for individual topic reports with dropdown
    app.get(
      /^\/topicReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    app.get(
      /^\/topicsVizReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      fetchIndexForReportPage
    );
    // Topic Hierarchy route for circle pack visualization
    app.get(
      /^\/topicHierarchy\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    // Collective Statements carousel route
    app.get(
      /^\/collectiveStatements\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    // Export Report route for data export interface
    app.get(
      /^\/exportReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    app.get(
      /^\/topicMapNarrativeReport\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );
    app.get(
      /^\/topicStats\/r?[0-9][0-9A-Za-z]+(\/.*)?/,
      function (req, res, next) {
        return fetchIndexForReportPage(req, res, next);
      }
    );

    app.get(
      /^\/embed$/,
      makeFileFetcher(hostname, staticFilesAdminPort, "/embed.html", {
        "Content-Type": "text/html",
      })
    );
    app.get(
      /^\/embedPreprod$/,
      makeFileFetcher(hostname, staticFilesAdminPort, "/embedPreprod.html", {
        "Content-Type": "text/html",
      })
    );
    app.get(
      /^\/embedReport$/,
      makeFileFetcher(hostname, staticFilesAdminPort, "/embedReport.html", {
        "Content-Type": "text/html",
      })
    );
    app.get(
      /^\/embedReportPreprod$/,
      makeFileFetcher(
        hostname,
        staticFilesAdminPort,
        "/embedReportPreprod.html",
        {
          "Content-Type": "text/html",
        }
      )
    );
    app.get(
      /^\/styleguide$/,
      makeFileFetcher(
        hostname,
        staticFilesParticipationPort,
        "/styleguide.html",
        {
          "Content-Type": "text/html",
        }
      )
    );
    // Duplicate url for content at root. Needed so we have something for "About" to link to.
    app.get(/^\/about$/, makeRedirectorTo("/home"));
    app.get(/^\/home(\/.*)?/, fetchIndexForAdminPage);
    app.get(
      /^\/s\/CTE\/?$/,
      makeFileFetcher(
        hostname,
        staticFilesParticipationPort,
        "/football.html",
        {
          "Content-Type": "text/html",
        }
      )
    );

    app.get("/", handle_GET_conditionalIndexFetcher);

    // proxy static files
    app.get(/^\/cached\/.*/, proxy);
    app.get(/^\/font\/.*/, proxy);
    app.get(/^\/.*embed.*js\/.*/, proxy);
    app.get(/^\/report_bundle.*\.js$/, proxy);
    app.get(/^\/report_style.*\.css$/, proxy);

    // ends in slash? redirect to non-slash version
    app.get(/.*\//, function (req, res) {
      let pathAndQuery = req.originalUrl;

      // remove slash at end
      if (pathAndQuery.endsWith("/")) {
        pathAndQuery = pathAndQuery.slice(0, pathAndQuery.length - 1);
      }

      // remove slashes before "?"
      if (pathAndQuery.indexOf("?") >= 1) {
        pathAndQuery = pathAndQuery.replace("/?", "?");
      }

      const fullUrl = req.protocol + "://" + req.get("host") + pathAndQuery;

      if (pathAndQuery !== req.originalUrl) {
        res.redirect(fullUrl);
      } else {
        proxy(req, res);
      }
    });

    const missingFilesGet404 = false;
    if (missingFilesGet404) {
      // 404 everything else
      app.get(
        /^\/[^(api\/)]?.*/,
        makeFileFetcher(hostname, staticFilesAdminPort, "/404.html", {
          "Content-Type": "text/html",
        })
      );
    } else {
      // proxy everything else
      app.get(/^\/[^(api\/)]?.*/, proxy);
    }

    // move app.listen to index.ts
  },

  function (err) {
    logger.error("failed to init server", err);
  }
);

// Setup global error handling
app.use(globalErrorHandler);

// Initialize global process-level error handlers
setupGlobalProcessHandlers();

export default app;
