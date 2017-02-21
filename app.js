// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
"use strict";

const Promise = require('bluebird');
const express = require('express');
const optional = require("optional");

const server = require('./server');

const polisServerBrand = optional('polisServerBrand');

const app = express();


console.log('init 1');

var helpersInitialized = new Promise(function(resolve, reject) {
  resolve(server.initializePolisHelpers());
});



helpersInitialized.then(function(o) {
  const {
    addCorsHeader,
    assignToP,
    assignToPCustom,
    auth,
    authOptional,
    COOKIES,
    denyIfNotFromWhitelistedDomain,
    devMode,
    enableAgid,
    fetchIndexForAdminPage,
    fetchIndexForConversation,
    fetchIndexForReportPage,
    fetchIndexWithoutPreloadData,
    getArrayOfInt,
    getArrayOfStringNonEmpty,
    getBool,
    getConversationIdFetchZid,
    getEmail,
    getInt,
    getIntInRange,
    getNumberInRange,
    getOptionalStringLimitLength,
    getPassword,
    getPasswordWithCreatePasswordRules,
    getPidForParticipant,
    getReportIdFetchRid,
    getStringLimitLength,
    getUrlLimitLength,
    haltOnTimeout,
    HMAC_SIGNATURE_PARAM_NAME,
    hostname,
    makeFileFetcher,
    makeRedirectorTo,
    moveToBody,
    need,
    pidCache,
    portForAdminFiles,
    portForParticipationFiles,
    proxy,
    redirectIfApiDomain,
    redirectIfHasZidButNoConversationId,
    redirectIfNotHttps,
    redirectIfWrongDomain,
    resolve_pidThing,
    timeout,
    want,
    wantCookie,
    winston,
    writeDefaultHead,

    middleware_log_request_body,
    middleware_log_middleware_errors,
    middleware_check_if_options,
    middleware_responseTime_start,

    handle_DELETE_metadata_answers,
    handle_DELETE_metadata_questions,
    handle_GET_bid,
    handle_GET_bidToPid,
    handle_GET_canvas_app_instructions_png,
    handle_GET_changePlanWithCoupon,
    handle_GET_comments,
    handle_GET_conditionalIndexFetcher,
    handle_GET_contexts,
    handle_GET_conversation_assigmnent_xml,
    handle_GET_conversationPreloadInfo,
    handle_GET_conversations,
    handle_GET_conversationsRecentActivity,
    handle_GET_conversationsRecentlyStarted,
    handle_GET_conversationStats,
    handle_GET_createPlanChangeCoupon,
    handle_GET_enterprise_deal_url,
    handle_GET_math_correlationMatrix,
    handle_GET_dataExport,
    handle_GET_dataExport_results,
    handle_GET_domainWhitelist,
    handle_GET_dummyButton,
    handle_GET_einvites,
    handle_GET_facebook_delete,
    handle_GET_groupDemographics,
    handle_GET_iim_conversation,
    handle_GET_iip_conversation,
    handle_GET_implicit_conversation_generation,
    handle_GET_launchPrep,
    handle_GET_localFile_dev_only,
    handle_GET_locations,
    handle_GET_lti_oauthv1_credentials,
    handle_GET_math_pca,
    handle_GET_math_pca2,
    handle_GET_metadata,
    handle_GET_metadata_answers,
    handle_GET_metadata_choices,
    handle_GET_metadata_questions,
    handle_GET_nextComment,
    handle_GET_notifications_subscribe,
    handle_GET_notifications_unsubscribe,
    handle_GET_participants,
    handle_GET_participation,
    handle_GET_participationInit,
    handle_GET_perfStats,
    handle_GET_ptptois,
    handle_GET_reports,
    handle_GET_setup_assignment_xml,
    handle_GET_slack_login,
    handle_GET_snapshot,
    handle_GET_stripe_account_connect,
    handle_GET_stripe_account_connected_oauth_callback,
    handle_GET_tryCookie,
    handle_GET_twitter_image,
    handle_GET_twitter_oauth_callback,
    handle_GET_twitter_users,
    handle_GET_twitterBtn,
    handle_GET_users,
    handle_GET_verification,
    handle_GET_votes,
    handle_GET_votes_famous,
    handle_GET_votes_me,
    handle_GET_xids,
    handle_GET_zinvites,



    handle_POST_auth_deregister,
    handle_POST_auth_facebook,
    handle_POST_auth_login,
    handle_POST_auth_new,
    handle_POST_auth_password,
    handle_POST_auth_pwresettoken,
    handle_POST_auth_slack_redirect_uri,
    handle_POST_charge,
    handle_POST_comments,
    handle_POST_comments_slack,
    handle_POST_contexts,
    handle_POST_contributors,
    handle_POST_conversation_close,
    handle_POST_conversation_reopen,
    handle_POST_conversations,
    handle_POST_convSubscriptions,
    handle_POST_domainWhitelist,
    handle_POST_einvites,
    handle_POST_joinWithInvite,
    handle_POST_lti_conversation_assignment,
    handle_POST_lti_setup_assignment,
    handle_POST_metadata_answers,
    handle_POST_metadata_questions,
    handle_POST_metrics,
    handle_POST_participants,
    handle_POST_post_payment_form,
    handle_POST_ptptCommentMod,
    handle_POST_query_participants_by_metadata,
    handle_POST_reserve_conversation_id,
    handle_POST_sendCreatedLinkToEmail,
    handle_POST_sendEmailExportReady,
    handle_POST_slack_interactive_messages,
    handle_POST_slack_user_invites,
    handle_POST_stars,
    handle_POST_trashes,
    handle_POST_tutorial,
    handle_POST_upvotes,
    handle_POST_users_invite,
    handle_POST_votes,
    handle_POST_waitinglist,
    handle_POST_zinvites,
    handle_PUT_comments,
    handle_PUT_conversations,
    handle_PUT_ptptois,
    handle_PUT_users,
  } = o;

  console.log('begin route config');

  app.disable('x-powered-by');
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


  //app.use(meter("api.all"));
  // app.use(express.logger());

  app.use(middleware_responseTime_start);

  // const gzipMiddleware = express.compress();
  // function maybeApplyGzip(req, res, next) {
  //   if (req.path && req.path.indexOf("/math/pca2") >= 0) {
  //     // pca2 caches gzipped responses, so no need to gzip again.
  //     next(null);
  //   } else {
  //     return gzipMiddleware(req, res, next);
  //   }
  // }

  app.use(redirectIfNotHttps);
  app.use(express.cookieParser());
  app.use(express.bodyParser());
  app.use(writeDefaultHead);
  app.use(redirectIfWrongDomain);
  app.use(redirectIfApiDomain);

  if (devMode) {
    app.use(express.compress());
  } else {
    // Cloudflare would apply gzip if we didn't
    // but it's about 2x faster if we do the gzip (for the inbox query on mike's account)
    app.use(express.compress());
  }
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



  app.get("/api/v3/math/pca",
    handle_GET_math_pca);

  app.get("/api/v3/math/pca2",
    //meter("api.math.pca.get"),
    moveToBody,
    redirectIfHasZidButNoConversationId, // TODO remove once
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, -1),
    handle_GET_math_pca2);

  app.get("/api/v3/math/correlationMatrix",
    moveToBody,
    // need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('report_id', getReportIdFetchRid, assignToPCustom('rid')),
    want('lastVoteTimestamp', getInt, assignToP, -1),
    handle_GET_math_correlationMatrix);



  app.get("/api/v3/dataExport",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
    want('format', getStringLimitLength(1, 100), assignToP),
    want('unixTimestamp', getStringLimitLength(99), assignToP),
    handle_GET_dataExport);

  app.get("/api/v3/dataExport/results",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
    want('filename', getStringLimitLength(1, 1000), assignToP),
    handle_GET_dataExport_results);

  // TODO doesn't scale, stop sending entire mapping.
  app.get("/api/v3/bidToPid",
    authOptional(assignToP),
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, 0),
    handle_GET_bidToPid);

  app.get("/api/v3/xids",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_xids);

  // TODO cache
  app.get("/api/v3/bid",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, 0),
    handle_GET_bid);

  app.post("/api/v3/auth/password",
    need('pwresettoken', getOptionalStringLimitLength(1000), assignToP),
    need('newPassword', getPasswordWithCreatePasswordRules, assignToP),
    handle_POST_auth_password);

  app.post("/api/v3/auth/pwresettoken",
    need('email', getEmail, assignToP),
    handle_POST_auth_pwresettoken);

  app.post("/api/v3/auth/deregister",
    want("showPage", getStringLimitLength(1, 99), assignToP),
    handle_POST_auth_deregister);

  app.get("/api/v3/zinvites/:zid",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_zinvites);

  app.post("/api/v3/zinvites/:zid",
    moveToBody,
    auth(assignToP),
    want('short_url', getBool, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_zinvites);

  // // tags: ANON_RELATED
  app.get("/api/v3/participants",
    moveToBody,
    auth(assignToP),
    // want('pid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    // resolve_pidThing('pid', assignToP),
    handle_GET_participants);

  app.get("/api/v3/dummyButton",
    moveToBody,
    need("button", getStringLimitLength(1, 999), assignToP),
    authOptional(assignToP),
    handle_GET_dummyButton);


  app.get("/api/v3/conversations/preload",
    moveToBody,
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    handle_GET_conversationPreloadInfo);

  app.get("/api/v3/conversations/recently_started",
    auth(assignToP),
    moveToBody,
    want('sinceUnixTimestamp', getStringLimitLength(99), assignToP),
    handle_GET_conversationsRecentlyStarted);

  app.get("/api/v3/conversations/recent_activity",
    auth(assignToP),
    moveToBody,
    want('sinceUnixTimestamp', getStringLimitLength(99), assignToP),
    handle_GET_conversationsRecentActivity);

  app.post("/api/v3/participants",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('answers', getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
    want('parent_url', getStringLimitLength(9999), assignToP),
    want('referrer', getStringLimitLength(9999), assignToP),
    handle_POST_participants);

  app.get("/api/v3/notifications/subscribe",
    moveToBody,
    need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    need('email', getEmail, assignToP),
    handle_GET_notifications_subscribe);

  app.get("/api/v3/notifications/unsubscribe",
    moveToBody,
    need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    need('email', getEmail, assignToP),
    handle_GET_notifications_unsubscribe);

  app.post("/api/v3/convSubscriptions",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need("type", getInt, assignToP),
    want('email', getEmail, assignToP),
    handle_POST_convSubscriptions);

  app.post("/api/v3/auth/login",
    need('password', getPassword, assignToP),
    want('email', getEmail, assignToP),
    want('lti_user_id', getStringLimitLength(1, 9999), assignToP),
    want('lti_user_image', getStringLimitLength(1, 9999), assignToP),
    want('lti_context_id', getStringLimitLength(1, 9999), assignToP),
    want('tool_consumer_instance_guid', getStringLimitLength(1, 9999), assignToP),
    want('afterJoinRedirectUrl', getStringLimitLength(1, 9999), assignToP),
    handle_POST_auth_login);

  app.post("/api/v3/joinWithInvite",
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    wantCookie(COOKIES.PERMANENT_COOKIE, getOptionalStringLimitLength(32), assignToPCustom('permanentCookieToken')),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('answers', getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
    want('referrer', getStringLimitLength(9999), assignToP),
    want('parent_url', getStringLimitLength(9999), assignToP),
    handle_POST_joinWithInvite);

  app.get("/perfStats_9182738127",
    moveToBody,
    handle_GET_perfStats);

  app.post("/api/v3/sendEmailExportReady",
    need('webserver_username', getStringLimitLength(1, 999), assignToP),
    need('webserver_pass', getStringLimitLength(1, 999), assignToP),
    need('email', getEmail, assignToP),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    need('filename', getStringLimitLength(9999), assignToP),
    handle_POST_sendEmailExportReady);

  app.get("/api/v3/domainWhitelist",
    moveToBody,
    auth(assignToP),
    handle_GET_domainWhitelist);

  app.post("/api/v3/domainWhitelist",
    auth(assignToP),
    need('domain_whitelist', getOptionalStringLimitLength(999), assignToP, ""),
    handle_POST_domainWhitelist);

  app.get("/api/v3/conversationStats",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('until', getInt, assignToP),
    handle_GET_conversationStats);

  app.get("/api/v3/snapshot",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_snapshot);

  app.get("/api/v3/auth/slack/redirect_uri",
    moveToBody,
    need('code', getStringLimitLength(1, 999), assignToP),
    want('state', getStringLimitLength(999), assignToP),
    handle_POST_auth_slack_redirect_uri);

  app.post("/api/v3/slack/interactive_messages",
    need('payload', getOptionalStringLimitLength(9999), assignToP, ""),
    handle_POST_slack_interactive_messages);

  // this endpoint isn't really ready for general use TODO_SECURITY
  app.get("/api/v3/facebook/delete",
    moveToBody,
    auth(assignToP),
    handle_GET_facebook_delete);

  app.post("/api/v3/auth/facebook",
    enableAgid,
    authOptional(assignToP),
    // need('fb_user_id', getStringLimitLength(1, 9999), assignToP),
    // need('fb_login_status', getStringLimitLength(1, 9999), assignToP),
    // need('fb_auth_response', getStringLimitLength(1, 9999), assignToP),
    // need('fb_access_token', getStringLimitLength(1, 9999), assignToP),
    want('fb_granted_scopes', getStringLimitLength(1, 9999), assignToP),
    want('fb_friends_response', getStringLimitLength(1, 99999), assignToP),
    want('fb_public_profile', getStringLimitLength(1, 99999), assignToP),
    want('fb_email', getEmail, assignToP),
    want('hname', getOptionalStringLimitLength(9999), assignToP),
    want('provided_email', getEmail, assignToP),
    want('conversation_id', getOptionalStringLimitLength(999), assignToP),
    want('password', getPassword, assignToP),
    need('response', getStringLimitLength(1, 9999), assignToP),
    want("owner", getBool, assignToP, true),
    handle_POST_auth_facebook);

  app.post("/api/v3/auth/new",
    want('anon', getBool, assignToP),
    want('password', getPasswordWithCreatePasswordRules, assignToP),
    want('password2', getPasswordWithCreatePasswordRules, assignToP),
    want('email', getOptionalStringLimitLength(999), assignToP),
    want('hname', getOptionalStringLimitLength(999), assignToP),
    want('oinvite', getOptionalStringLimitLength(999), assignToP),
    want('encodedParams', getOptionalStringLimitLength(9999), assignToP), // TODO_SECURITY we need to add an additional key param to ensure this is secure. we don't want anyone adding themselves to other people's site_id groups.
    want('zinvite', getOptionalStringLimitLength(999), assignToP),
    want('organization', getOptionalStringLimitLength(999), assignToP),
    want('gatekeeperTosPrivacy', getBool, assignToP),
    want('lti_user_id', getStringLimitLength(1, 9999), assignToP),
    want('lti_user_image', getStringLimitLength(1, 9999), assignToP),
    want('lti_context_id', getStringLimitLength(1, 9999), assignToP),
    want('tool_consumer_instance_guid', getStringLimitLength(1, 9999), assignToP),
    want('afterJoinRedirectUrl', getStringLimitLength(1, 9999), assignToP),
    want("owner", getBool, assignToP, true),
    handle_POST_auth_new);


  app.post("/api/v3/tutorial",
    auth(assignToP),
    need("step", getInt, assignToP),
    handle_POST_tutorial);

  app.get("/api/v3/users",
    moveToBody,
    want("errIfNoAuth", getBool, assignToP),
    authOptional(assignToP),
    handle_GET_users);

  // use this to generate coupons for free upgrades
  // TODO_SECURITY
  app.get("/api/v3/createPlanChangeCoupon_aiudhfaiodufy78sadtfiasdf",
    moveToBody,
    need('uid', getInt, assignToP),
    need('planCode', getOptionalStringLimitLength(999), assignToP),
    handle_GET_createPlanChangeCoupon);

  app.get("/api/v3/changePlanWithCoupon",
    moveToBody,
    authOptional(assignToP),
    need('code', getOptionalStringLimitLength(999), assignToP),
    handle_GET_changePlanWithCoupon);


  // Just for testing that the new custom stripe form is submitting properly
  app.post("/api/v3/post_payment_form",
    handle_POST_post_payment_form);

  app.post("/api/v3/charge",
    auth(assignToP),
    want('stripeToken', getOptionalStringLimitLength(999), assignToP),
    want('stripeEmail', getOptionalStringLimitLength(999), assignToP),
    need('plan', getOptionalStringLimitLength(999), assignToP),
    handle_POST_charge);

  app.get("/api/v3/participation",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('strict', getBool, assignToP),
    handle_GET_participation);


  app.get("/api/v3/group_demographics",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_groupDemographics);

  app.get("/api/v3/comments",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('tids', getArrayOfInt, assignToP),
    want('moderation', getBool, assignToP),
    want('mod', getInt, assignToP),
    want('mod_gt', getInt, assignToP),
    want('include_social', getBool, assignToP),
    want('include_demographics', getBool, assignToP),
    //    need('lastServerToken', _.identity, assignToP),
    resolve_pidThing('not_voted_by_pid', assignToP, "get:comments:not_voted_by_pid"),
    resolve_pidThing('pid', assignToP, "get:comments:pid"),
    handle_GET_comments);

  // // NOTE: using GET so it can be hit from an email URL.
  // app.get("/api/v3/mute",
  //     moveToBody,
  //     // NOTE: no auth. We're relying on the signature. These URLs will be sent to conversation moderators.
  //     need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
  //     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
  //     need('tid', getInt, assignToP),
  //     handle_GET_mute);
  //

  // // NOTE: using GET so it can be hit from an email URL.
  // app.get("/api/v3/unmute",
  //     moveToBody,
  //     // NOTE: no auth. We're relying on the signature. These URLs will be sent to conversation moderators.
  //     need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
  //     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
  //     need('tid', getInt, assignToP),
  //     handle_GET_unmute);
  //

  // TODO probably need to add a retry mechanism like on joinConversation to handle possibility of duplicate tid race-condition exception
  app.post("/api/v3/comments",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('txt', getOptionalStringLimitLength(997), assignToP),
    want('vote', getIntInRange(-1, 1), assignToP, -1), // default to agree
    want("twitter_tweet_id", getStringLimitLength(999), assignToP),
    want("quote_twitter_screen_name", getStringLimitLength(999), assignToP),
    want("quote_txt", getStringLimitLength(999), assignToP),
    want("quote_src_url", getUrlLimitLength(999), assignToP),
    want("anon", getBool, assignToP),
    want("is_seed", getBool, assignToP),
    want('xid', getStringLimitLength(1, 999), assignToP),
    resolve_pidThing('pid', assignToP, "post:comments"),
    handle_POST_comments);


  app.post("/api/v3/comments/slack",
    auth(assignToP),
    want('slack_team', getOptionalStringLimitLength(99), assignToP),
    want('slack_user_id', getOptionalStringLimitLength(99), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('txt', getOptionalStringLimitLength(997), assignToP),
    want('vote', getIntInRange(-1, 1), assignToP, -1), // default to agree
    want("twitter_tweet_id", getStringLimitLength(999), assignToP),
    want("quote_twitter_screen_name", getStringLimitLength(999), assignToP),
    want("quote_txt", getStringLimitLength(999), assignToP),
    want("quote_src_url", getUrlLimitLength(999), assignToP),
    want("anon", getBool, assignToP),
    want("is_seed", getBool, assignToP),
    resolve_pidThing('pid', assignToP, "post:comments"),
    handle_POST_comments_slack);

  app.get("/api/v3/votes/me",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_votes_me);

  // // TODO Since we know what is selected, we also know what is not selected. So server can compute the ratio of support for a comment inside and outside the selection, and if the ratio is higher inside, rank those higher.
  // app.get("/api/v3/selection",
  //     moveToBody,
  //     want('users', getArrayOfInt, assignToP),
  //     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
  //     handle_GET_selection);
  //

  app.get("/api/v3/votes",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('tid', getInt, assignToP),
    resolve_pidThing('pid', assignToP, "get:votes"),
    handle_GET_votes);

  app.get("/api/v3/nextComment",
    timeout(15000),
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    resolve_pidThing('not_voted_by_pid', assignToP, "get:nextComment"),
    want('without', getArrayOfInt, assignToP),
    want('include_social', getBool, assignToP),
    haltOnTimeout,
    handle_GET_nextComment);

  app.get("/api/v3/participationInit",
    moveToBody,
    authOptional(assignToP),
    want('ptptoiLimit', getInt, assignToP),
    want('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    denyIfNotFromWhitelistedDomain, // this seems like the easiest place to enforce the domain whitelist. The index.html is cached on cloudflare, so that's not the right place.
    resolve_pidThing('pid', assignToP, "get:votes"), // must be after zid getter
    handle_GET_participationInit);

  app.post("/api/v3/votes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('vote', getIntInRange(-1, 1), assignToP),
    want('starred', getBool, assignToP),
    want('weight', getNumberInRange(-1, 1), assignToP, 0),
    resolve_pidThing('pid', assignToP, "post:votes"),
    want('xid', getStringLimitLength(1, 999), assignToP),
    handle_POST_votes);


  app.post("/api/v3/ptptCommentMod",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('as_abusive', getBool, assignToP, null),
    want('as_factual', getBool, assignToP, null),
    want('as_feeling', getBool, assignToP, null),
    want('as_important', getBool, assignToP, null),
    want('as_notfact', getBool, assignToP, null),
    want('as_notgoodidea', getBool, assignToP, null),
    want('as_notmyfeeling', getBool, assignToP, null),
    want('as_offtopic', getBool, assignToP, null),
    want('as_spam', getBool, assignToP, null),
    want('as_unsure', getBool, assignToP, null),
    // resolve_pidThing('pid', assignToP, "post:ptptModComment"),
    getPidForParticipant(assignToP, pidCache),
    handle_POST_ptptCommentMod);

  app.post("/api/v3/upvotes",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_upvotes);

  app.post("/api/v3/stars",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('starred', getIntInRange(0, 1), assignToP),
    getPidForParticipant(assignToP, pidCache),
    handle_POST_stars);

  app.post("/api/v3/trashes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('trashed', getIntInRange(0, 1), assignToP),
    getPidForParticipant(assignToP, pidCache),
    handle_POST_trashes);

  app.put('/api/v3/comments',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('tid', getInt, assignToP),
    need('active', getBool, assignToP),
    need('mod', getInt, assignToP),
    need('is_meta', getBool, assignToP),
    need('velocity', getNumberInRange(0, 1), assignToP),
    handle_PUT_comments);

  // use this to generate them
  app.get('/api/v3/lti_oauthv1_credentials',
    moveToBody,
    want('uid', getInt, assignToP),
    handle_GET_lti_oauthv1_credentials);

  app.post('/api/v3/conversation/close',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_conversation_close);

  app.post('/api/v3/conversation/reopen',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_conversation_reopen);

  app.put('/api/v3/conversations',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    want('is_active', getBool, assignToP),
    want('is_anon', getBool, assignToP),
    want('is_draft', getBool, assignToP, false),
    want('is_data_open', getBool, assignToP, false),
    want('owner_sees_participation_stats', getBool, assignToP, false),
    want('profanity_filter', getBool, assignToP),
    want('short_url', getBool, assignToP, false),
    want('spam_filter', getBool, assignToP),
    want('strict_moderation', getBool, assignToP),
    want('topic', getOptionalStringLimitLength(1000), assignToP),
    want('description', getOptionalStringLimitLength(50000), assignToP),
    want('vis_type', getInt, assignToP),
    want('help_type', getInt, assignToP),
    want('write_type', getInt, assignToP),
    want('socialbtn_type', getInt, assignToP),
    want('bgcolor', getOptionalStringLimitLength(20), assignToP),
    want('help_color', getOptionalStringLimitLength(20), assignToP),
    want('help_bgcolor', getOptionalStringLimitLength(20), assignToP),
    want('style_btn', getOptionalStringLimitLength(500), assignToP),
    want('auth_needed_to_vote', getBool, assignToP),
    want('auth_needed_to_write', getBool, assignToP),
    want('auth_opt_fb', getBool, assignToP),
    want('auth_opt_tw', getBool, assignToP),
    want('auth_opt_allow_3rdparty', getBool, assignToP),
    want('verifyMeta', getBool, assignToP),
    want('send_created_email', getBool, assignToP), // ideally the email would be sent on the post, but we post before they click create to allow owner to prepopulate comments.
    want('launch_presentation_return_url_hex', getStringLimitLength(1, 9999), assignToP), // LTI editor tool redirect url (once conversation editing is done)
    want('context', getOptionalStringLimitLength(999), assignToP),
    want('tool_consumer_instance_guid', getOptionalStringLimitLength(999), assignToP),
    want('custom_canvas_assignment_id', getInt, assignToP),
    want('link_url', getStringLimitLength(1, 9999), assignToP),
    handle_PUT_conversations);


  app.put('/api/v3/users',
    moveToBody,
    auth(assignToP),
    want('email', getEmail, assignToP),
    want('hname', getOptionalStringLimitLength(9999), assignToP),
    want('uid_of_user', getInt, assignToP),
    handle_PUT_users);


  app.delete('/api/v3/metadata/questions/:pmqid',
    moveToBody,
    auth(assignToP),
    need('pmqid', getInt, assignToP),
    handle_DELETE_metadata_questions);

  app.delete('/api/v3/metadata/answers/:pmaid',
    moveToBody,
    auth(assignToP),
    need('pmaid', getInt, assignToP),
    handle_DELETE_metadata_answers);

  app.get('/api/v3/metadata/questions',
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
    handle_GET_metadata_questions);

  app.post('/api/v3/metadata/questions',
    moveToBody,
    auth(assignToP),
    need('key', getOptionalStringLimitLength(999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_metadata_questions);

  app.post('/api/v3/metadata/answers',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('pmqid', getInt, assignToP),
    need('value', getOptionalStringLimitLength(999), assignToP),
    handle_POST_metadata_answers);

  app.get('/api/v3/metadata/choices',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_metadata_choices);

  app.get('/api/v3/metadata/answers',
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('pmqid', getInt, assignToP),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
    handle_GET_metadata_answers);

  app.get('/api/v3/metadata',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
    handle_GET_metadata);


  app.get('/api/v3/enterprise_deal_url',
    moveToBody,
    // want('upfront', getBool, assignToP),
    need('monthly', getInt, assignToP),
    want('maxUsers', getInt, assignToP),
    want('plan_name', getOptionalStringLimitLength(99), assignToP),
    want('plan_id', getOptionalStringLimitLength(99), assignToP),
    handle_GET_enterprise_deal_url);

  app.get('/api/v3/stripe_account_connect',
    handle_GET_stripe_account_connect);

  app.get('/api/v3/stripe_account_connected_oauth_callback',
    moveToBody,
    want("code", getStringLimitLength(9999), assignToP),
    want("access_token", getStringLimitLength(9999), assignToP),
    want("error", getStringLimitLength(9999), assignToP),
    want("error_description", getStringLimitLength(9999), assignToP),
    handle_GET_stripe_account_connected_oauth_callback);

  app.get('/api/v3/conversations',
    moveToBody,
    authOptional(assignToP),
    want('include_all_conversations_i_am_in', getBool, assignToP),
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('course_invite', getStringLimitLength(1, 32), assignToP),
    want('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('want_upvoted', getBool, assignToP),
    want('want_mod_url', getBool, assignToP), // NOTE - use this for API only!
    want('want_inbox_item_admin_url', getBool, assignToP), // NOTE - use this for API only!
    want('want_inbox_item_participant_url', getBool, assignToP), // NOTE - use this for API only!
    want('want_inbox_item_admin_html', getBool, assignToP), // NOTE - use this for API only!
    want('want_inbox_item_participant_html', getBool, assignToP), // NOTE - use this for API only!
    want('limit', getIntInRange(1, 9999), assignToP), // not allowing a super high limit to prevent DOS attacks
    want('context', getStringLimitLength(1, 999), assignToP),
    want('xid', getStringLimitLength(1, 999), assignToP),
    handle_GET_conversations);

  app.get('/api/v3/reports',
    moveToBody,
    auth(assignToP),
    want('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('report_id', getReportIdFetchRid, assignToPCustom('rid')), // Knowing the report_id grants the user permission to view the report
    handle_GET_reports);

  app.get('/api/v3/contexts',
    moveToBody,
    authOptional(assignToP),
    handle_GET_contexts);

  app.post('/api/v3/contexts',
    auth(assignToP),
    need('name', getStringLimitLength(1, 300), assignToP),
    handle_POST_contexts);

  app.post('/api/v3/reserve_conversation_id',
    auth(assignToP),
    handle_POST_reserve_conversation_id);

  // TODO check to see if ptpt has answered necessary metadata questions.
  app.post('/api/v3/conversations',
    auth(assignToP),
    want('is_active', getBool, assignToP, true),
    want('is_draft', getBool, assignToP, false),
    want('is_anon', getBool, assignToP, false),
    want('owner_sees_participation_stats', getBool, assignToP, false),
    want('profanity_filter', getBool, assignToP, true),
    want('short_url', getBool, assignToP, false),
    want('spam_filter', getBool, assignToP, true),
    want('strict_moderation', getBool, assignToP, false),
    want('context', getOptionalStringLimitLength(999), assignToP, ""),
    want('topic', getOptionalStringLimitLength(1000), assignToP, ""),
    want('description', getOptionalStringLimitLength(50000), assignToP, ""),
    want('conversation_id', getStringLimitLength(6, 300), assignToP, ""),
    want('is_slack', getBool, assignToP, false),
    
    want('is_data_open', getBool, assignToP, false),
    handle_POST_conversations);

  // app.get('/api/v3/users',
  //   handle_GET_users);

  app.post('/api/v3/query_participants_by_metadata',
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('pmaids', getArrayOfInt, assignToP, []),
    handle_POST_query_participants_by_metadata);

  app.post('/api/v3/sendCreatedLinkToEmail',
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_POST_sendCreatedLinkToEmail);

  app.get("/api/v3/twitterBtn",
    moveToBody,
    authOptional(assignToP),
    want("dest", getStringLimitLength(9999), assignToP),
    want("owner", getBool, assignToP, true),
    handle_GET_twitterBtn);

  app.get("/api/v3/twitter_oauth_callback",
    moveToBody,
    enableAgid,
    auth(assignToP),
    need("dest", getStringLimitLength(9999), assignToP),
    need("oauth_token", getStringLimitLength(9999), assignToP), // TODO verify
    need("oauth_verifier", getStringLimitLength(9999), assignToP), // TODO verify
    want("owner", getBool, assignToP, true),
    handle_GET_twitter_oauth_callback);

  app.get("/api/v3/locations",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need("gid", getInt, assignToP),
    handle_GET_locations);

  app.put("/api/v3/ptptois",
    moveToBody,
    auth(assignToP),
    need("mod", getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    resolve_pidThing('pid', assignToP),
    handle_PUT_ptptois);

  app.get("/api/v3/ptptois",
    moveToBody,
    auth(assignToP),
    want('mod', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
    handle_GET_ptptois);

  app.get("/api/v3/votes/famous",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, -1),
    want('ptptoiLimit', getIntInRange(0, 99), assignToP),
    handle_GET_votes_famous);

  app.get("/api/v3/twitter_users",
    moveToBody,
    authOptional(assignToP),
    want("twitter_user_id", getInt, assignToP), // if not provided, returns info for the signed-in user
    handle_GET_twitter_users);

  app.post("/api/v3/einvites",
    need('email', getEmail, assignToP),
    handle_POST_einvites);

  // // TODO_SECURITY
  // app.get("/api/v3/cache/purge/f2938rh2389hr283hr9823rhg2gweiwriu78",
  //   // moveToBody,
  //   handle_GET_cache_purge);

  app.get("/api/v3/einvites",
    moveToBody,
    need("einvite", getStringLimitLength(1, 100), assignToP),
    handle_GET_einvites);

  app.post("/api/v3/LTI/setup_assignment",
    authOptional(assignToP),
    need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school
    need("user_id", getStringLimitLength(1, 9999), assignToP),
    need("context_id", getStringLimitLength(1, 9999), assignToP),
    want("tool_consumer_instance_guid", getStringLimitLength(1, 9999), assignToP), //  scope to the right LTI/canvas? instance
    want("roles", getStringLimitLength(1, 9999), assignToP),
    want("user_image", getStringLimitLength(1, 9999), assignToP),
    want("lis_person_contact_email_primary", getStringLimitLength(1, 9999), assignToP),
    want("lis_person_name_full", getStringLimitLength(1, 9999), assignToP),
    want("lis_outcome_service_url", getStringLimitLength(1, 9999), assignToP), //  send grades here!
    want("launch_presentation_return_url", getStringLimitLength(1, 9999), assignToP),
    want("ext_content_return_types", getStringLimitLength(1, 9999), assignToP),
    handle_POST_lti_setup_assignment);

  // app.post("/api/v3/LTI/canvas_nav",
  //     need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school
  //     need("user_id", getStringLimitLength(1, 9999), assignToP),
  //     need("context_id", getStringLimitLength(1, 9999), assignToP),
  //     need("tool_consumer_instance_guid", getStringLimitLength(1, 9999), assignToP), //  scope to the right LTI/canvas? instance
  //     want("roles", getStringLimitLength(1, 9999), assignToP),
  //     want("user_image", getStringLimitLength(1, 9999), assignToP),
  //     want("lis_person_contact_email_primary", getStringLimitLength(1, 9999), assignToP),
  //     want("lis_person_name_full", getStringLimitLength(1, 9999), assignToP),
  //     want("lis_outcome_service_url", getStringLimitLength(1, 9999), assignToP), //  send grades here!
  //     want("launch_presentation_return_url", getStringLimitLength(1, 9999), assignToP),
  //     want("ext_content_return_types", getStringLimitLength(1, 9999), assignToP),
  //     handle_POST_lti_canvas_nav);

  app.post("/api/v3/LTI/conversation_assignment",
    need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school    need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school
    need("oauth_signature_method", getStringLimitLength(1, 9999), assignToP), // probably "HMAC-SHA-1"
    need("oauth_nonce", getStringLimitLength(1, 9999), assignToP), //rK81yoLBZhxVeaQHOUQQV8Ug5AObZtWv4R0ezQN20
    need("oauth_version", getStringLimitLength(1, 9999), assignToP), //'1.0'
    need("oauth_timestamp", getStringLimitLength(1, 9999), assignToP), //?
    need("oauth_callback", getStringLimitLength(1, 9999), assignToP), // about:blank

    need("user_id", getStringLimitLength(1, 9999), assignToP),
    need("context_id", getStringLimitLength(1, 9999), assignToP),
    want("roles", getStringLimitLength(1, 9999), assignToP),
    want("user_image", getStringLimitLength(1, 9999), assignToP),
    // per assignment stuff
    want("custom_canvas_assignment_id", getInt, assignToP), // NOTE: it enters our system as an int, but we'll
    want("lis_outcome_service_url", getStringLimitLength(1, 9999), assignToP), //  send grades here!
    want("lis_result_sourcedid", getStringLimitLength(1, 9999), assignToP), //  grading context
    want("tool_consumer_instance_guid", getStringLimitLength(1, 9999), assignToP), //  canvas instance
    handle_POST_lti_conversation_assignment);

  app.get("/api/v3/LTI/setup_assignment.xml",
    handle_GET_setup_assignment_xml);

  // app.post("/api/v3/LTI/editor_tool",
  //     need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school
  //     need("user_id", getStringLimitLength(1, 9999), assignToP),
  //     need("context_id", getStringLimitLength(1, 9999), assignToP),
  //     want("roles", getStringLimitLength(1, 9999), assignToP),
  //     want("user_image", getStringLimitLength(1, 9999), assignToP),
  // // lis_outcome_service_url: send grades here!
  //     want("lis_person_contact_email_primary", getStringLimitLength(1, 9999), assignToP),
  //     want("launch_presentation_return_url", getStringLimitLength(1, 9999), assignToP),
  //     want("ext_content_return_types", getStringLimitLength(1, 9999), assignToP),
  //     handle_POST_lti_editor_tool);

  // app.post("/api/v3/LTI/editor_tool_for_setup",
  //     need("oauth_consumer_key", getStringLimitLength(1, 9999), assignToP), // for now, this will be the professor, but may also be the school
  //     need("user_id", getStringLimitLength(1, 9999), assignToP),
  //     need("context_id", getStringLimitLength(1, 9999), assignToP),
  //     want("roles", getStringLimitLength(1, 9999), assignToP),
  //     want("user_image", getStringLimitLength(1, 9999), assignToP),
  // // lis_outcome_service_url: send grades here!
  //     want("lis_person_contact_email_primary", getStringLimitLength(1, 9999), assignToP),
  //     want("launch_presentation_return_url", getStringLimitLength(1, 9999), assignToP),
  //     want("ext_content_return_types", getStringLimitLength(1, 9999), assignToP),
  //     handle_POST_lti_editor_tool_for_setup);

  app.get("/api/v3/LTI/conversation_assignment.xml",
    handle_GET_conversation_assigmnent_xml);

  app.get("/canvas_app_instructions.png",
    handle_GET_canvas_app_instructions_png);

  // app.post("/api/v3/users/invite",
  //     // authWithApiKey(assignToP),
  //     auth(assignToP),
  //     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
  //     need('single_use_tokens', getBool, assignToP),
  //     need('xids', getArrayOfStringNonEmpty, assignToP),
  //     handle_POST_users_invite);

  app.post("/api/v3/users/invite",
    // authWithApiKey(assignToP),
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    // need('single_use_tokens', getBool, assignToP),
    need('emails', getArrayOfStringNonEmpty, assignToP),
    handle_POST_users_invite);


  app.get(/^\/slack_login_code.*/,
    moveToBody,
    authOptional(assignToP),
    handle_GET_slack_login);

  app.post("/api/v3/slack/user/invites",
    need('slack_team', getStringLimitLength(1, 20), assignToP),
    need('slack_user_id', getStringLimitLength(1, 20), assignToP),
    handle_POST_slack_user_invites);


  app.get(/^\/polis_site_id.*/,
    moveToBody,
    need("parent_url", getStringLimitLength(1, 10000), assignToP),
    want("referrer", getStringLimitLength(1, 10000), assignToP),
    want("auth_needed_to_vote", getBool, assignToP),
    want("auth_needed_to_write", getBool, assignToP),
    want("auth_opt_fb", getBool, assignToP),
    want("auth_opt_tw", getBool, assignToP),
    want('auth_opt_allow_3rdparty', getBool, assignToP),
    want('show_vis', getBool, assignToP),
    want('topic', getStringLimitLength(1, 1000), assignToP),
    want('ucv', getBool, assignToP), // not persisted
    want('ucw', getBool, assignToP), // not persisted
    want('ucst', getBool, assignToP), // not persisted
    want('ucsd', getBool, assignToP), // not persisted
    want('ucsv', getBool, assignToP), // not persisted
    want('ucsf', getBool, assignToP), // not persisted
    want('xid', getStringLimitLength(1, 999), assignToP), // not persisted
    handle_GET_implicit_conversation_generation);

  app.get("/iip/:conversation_id",
    // function(req, res, next) {
    //     req.p.conversation_id = req.params.conversation_id;
    //     next();
    // },
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_iip_conversation);

  app.get("/iim/:conversation_id",
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    handle_GET_iim_conversation);

  // proxy for fetching twitter profile images
  // Needed because Twitter doesn't provide profile pics in response to a request - you have to fetch the user info, then parse that to get the URL, requiring two round trips.
  // There is a bulk user data API, but it's too slow to block on in our /famous route.
  // So references to this route are injected into the twitter part of the /famous response.
  app.get("/twitter_image",
    moveToBody,
    need('id', getStringLimitLength(999), assignToP),
    handle_GET_twitter_image);

  // TODO this should probably be exempt from the CORS restrictions
  app.get("/api/v3/launchPrep",
    moveToBody,
    need("dest", getStringLimitLength(1, 10000), assignToP),
    handle_GET_launchPrep);

  app.get("/api/v3/tryCookie",
    moveToBody,
    handle_GET_tryCookie);

  app.get("/api/v3/verify",
    moveToBody,
    need("e", getStringLimitLength(1, 1000), assignToP),
    handle_GET_verification);

  app.post("/api/v3/contributors",
    authOptional(assignToP),
    need('agreement_version', getIntInRange(1, 999999), assignToP),
    need('name', getStringLimitLength(746), assignToP),
    need('email', getStringLimitLength(256), assignToP),
    need('github_id', getStringLimitLength(256), assignToP),
    need('company_name', getStringLimitLength(746), assignToP),
    handle_POST_contributors);

  app.post("/api/v3/waitinglist",
    need('name', getStringLimitLength(746), assignToP),
    need('email', getEmail, assignToP),
    want('affiliation', getStringLimitLength(999), assignToP),
    want('role', getStringLimitLength(999), assignToP),
    need('campaign', getStringLimitLength(100), assignToP),
    handle_POST_waitinglist);

  app.post("/api/v3/metrics",
      authOptional(assignToP),
      need('types', getArrayOfInt, assignToP),
      need('times', getArrayOfInt, assignToP),
      need('durs', getArrayOfInt, assignToP),
      need('clientTimestamp', getInt, assignToP),
      handle_POST_metrics);

  if (polisServerBrand && polisServerBrand.registerRoutes) {
    polisServerBrand.registerRoutes(app, o);
  }






  function makeFetchIndexWithoutPreloadData() {
    let port = portForParticipationFiles;
    return function(req, res) {
      return fetchIndexWithoutPreloadData(req, res, port);
    };
  }



  // app.get("/api/v3/setFirstCookie",
  //     moveToBody,
  //     handle_GET_setFirstCookie);
  // app.get("/api/v3/LTI/canvas_nav.xml",
  //     handle_GET_lti_canvas_nav_xml);
  // app.get("/api/v3/LTI/editor_tool.xml",
  //     handle_GET_lti_editor_tool_xml);
  // app.get("/api/v3/LTI/editor_tool_for_setup.xml",
  //     handle_GET_editor_tool_for_setup_xml);
  //app.use(express.static(__dirname + '/src/desktop/index.html'));
  //app.use('/static', express.static(__dirname + '/src'));
  //app.get('/', staticFile);
  // app.get(/^\/iip\/([0-9][0-9A-Za-z]+)$/, fetchIndex);
  // app.get(/^\/iim\/([0-9][0-9A-Za-z]+)$/, fetchIndex);

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
  app.get(/^\/settings\/enterprise}.*$/, makeFetchIndexWithoutPreloadData());

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
  app.get(/^\/dist\/admin_bundle.js$/, makeFileFetcher(hostname, portForAdminFiles, "/dist/admin_bundle.js", {
    'Content-Type': "application/javascript",
  }));
  app.get(/^\/__webpack_hmr$/, makeFileFetcher(hostname, portForAdminFiles, "/__webpack_hmr", {
    'Content-Type': "eventsource",
  }));
  app.get(/^\/privacy$/, fetchIndexForAdminPage);
  app.get(/^\/tos$/, fetchIndexForAdminPage);

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
  app.get(/^\/pwreset.*/, fetchIndexForAdminPage);
  app.get(/^\/company$/, fetchIndexForAdminPage);

  app.get(/^\/report\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForReportPage);
  
  app.get(/^\/embed$/, makeFileFetcher(hostname, portForAdminFiles, "/embed.html", {
    'Content-Type': "text/html",
  }));
  app.get(/^\/canvas_setup_backup_instructions$/, makeFileFetcher(hostname, portForParticipationFiles, "/canvas_setup_backup_instructions.html", {
    'Content-Type': "text/html",
  }));
  app.get(/^\/styleguide$/, makeFileFetcher(hostname, portForParticipationFiles, "/styleguide.html", {
    'Content-Type': "text/html",
  }));
  // Duplicate url for content at root. Needed so we have something for "About" to link to.
  app.get(/^\/about$/, makeRedirectorTo("/gov"));
  app.get(/^\/home(\/.*)?/, makeRedirectorTo("/gov"));
  app.get(/^\/s\/CTE\/?$/, makeFileFetcher(hostname, portForParticipationFiles, "/football.html", {
    'Content-Type': "text/html",
  }));
  app.get(/^\/twitterAuthReturn(\/.*)?$/, makeFileFetcher(hostname, portForParticipationFiles, "/twitterAuthReturn.html", {
    'Content-Type': "text/html",
  }));

  app.get(/^\/localFile\/.*/, handle_GET_localFile_dev_only);

  app.get("/", handle_GET_conditionalIndexFetcher);

  // proxy static files
  app.get(/^\/cached\/.*/, proxy);
  app.get(/^\/font\/.*/, proxy);
  app.get(/^\/.*embed.*js\/.*/, proxy);

  var missingFilesGet404 = false;
  if (missingFilesGet404) {
    // 404 everything else
    app.get(/^\/[^(api\/)]?.*/, makeFileFetcher(hostname, portForAdminFiles, "/404.html", {
      'Content-Type': "text/html",
    }));
  } else {
    // proxy everything else
    app.get(/^\/[^(api\/)]?.*/, proxy);
  }

  app.listen(process.env.PORT);

  winston.log("info", 'started on port ' + process.env.PORT);

}, function(err) {
  console.error("failed to init server");
  console.error(err);
});
