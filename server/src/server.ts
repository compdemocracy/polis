// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

import akismetLib from "akismet";
import AWS from "aws-sdk";
import badwords from "badwords/object";
import Promise from "bluebird";
import http from "http";
import httpProxy from "http-proxy";
import async from "async";
import FB from "fb";
import fs from "fs";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import OAuth from "oauth";
import replaceStream from "replacestream";
import responseTime from "response-time";
import request from "request-promise"; // includes Request, but adds promise methods
import LruCache from "lru-cache";
import timeout from "connect-timeout";
import zlib from "zlib";
import _ from "underscore";
import pg from "pg";

import { METRICS_IN_RAM, addInRamMetric, MPromise } from "./utils/metered";
import CreateUser from "./auth/create-user";
import Password from "./auth/password";
import dbPgQuery from "./db/pg-query";

import Config from "./config";
// Re-import disassembled code to promise existing code will work
import Log from "./log";

import {
  Body,
  DetectLanguageResult,
  Headers,
  Query,
  AuthRequest,
  ParticipantInfo,
  PidReadyResult,
  CommentOptions,
  ParticipantFields,
  ParticipantCommentModerationResult,
  UserType,
  ConversationType,
  CommentType,
  TwitterParameters,
  ParticipantSocialNetworkInfo,
  ParticipantOption,
  DemographicEntry,
  Demo,
  Vote,
  Assignment,
} from "./d";

AWS.config.update({ region: Config.awsRegion });
const devMode = Config.isDevMode;
const s3Client = new AWS.S3({ apiVersion: "2006-03-01" });
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const yell = Log.yell;
const escapeLiteral = pg.Client.prototype.escapeLiteral;
const pgQuery = dbPgQuery.query;
const pgQuery_readOnly = dbPgQuery.query_readOnly;
const pgQueryP = dbPgQuery.queryP;
const pgQueryP_metered = dbPgQuery.queryP_metered;
const pgQueryP_metered_readOnly = dbPgQuery.queryP_metered_readOnly;
const pgQueryP_readOnly = dbPgQuery.queryP_readOnly;
const pgQueryP_readOnly_wRetryIfEmpty = dbPgQuery.queryP_readOnly_wRetryIfEmpty;
const doSendVerification = CreateUser.doSendVerification;
const generateAndRegisterZinvite = CreateUser.generateAndRegisterZinvite;
const generateToken = Password.generateToken;
const generateTokenP = Password.generateTokenP;

import cookies from "./utils/cookies";
const COOKIES = cookies.COOKIES;
const COOKIES_TO_CLEAR = cookies.COOKIES_TO_CLEAR;

import constants from "./utils/constants";
const DEFAULTS = constants.DEFAULTS;

import User from "./user";
import Conversation from "./conversation";
import Session from "./session";
import Comment from "./comment";
import Utils from "./utils/common";
import SQL from "./db/sql";
// End of re-import

// const winston = require("winston");
// # notifications
const winston = console;
import emailSenders from "./email/senders";
const sendTextEmail = emailSenders.sendTextEmail;
const sendTextEmailWithBackupOnly = emailSenders.sendTextEmailWithBackupOnly;

if (devMode) {
  Promise.longStackTraces();
}

// Bluebird uncaught error handler.
Promise.onPossiblyUnhandledRejection(function (err: { stack: any }) {
  console.log("onPossiblyUnhandledRejection");
  console.error(JSON.stringify(err));
});

const adminEmails = Config.adminEmails ? JSON.parse(Config.adminEmails) : [];

const polisDevs = Config.adminUIDs ? JSON.parse(Config.adminUIDs) : [];

function isPolisDev(uid?: any) {
  console.log("polisDevs", polisDevs);
  return polisDevs.indexOf(uid) >= 0;
}
// log heap stats
setInterval(function () {
  let mem = process.memoryUsage();
  let heapUsed = mem.heapUsed;
  let rss = mem.rss;
  let heapTotal = mem.heapTotal;
  winston.log(
    "info",
    "heapUsed:",
    heapUsed,
    "heapTotal:",
    heapTotal,
    "rss:",
    rss
  );
}, 10 * 1000);

const polisFromAddress = Config.polisFromAddress;

// typically https://pol.is or http://localhost:5000
const serverUrl = Config.getServerUrl();

let akismet = akismetLib.client({
  blog: serverUrl,
  apiKey: Config.akismetAntispamApiKey,
});

akismet.verifyKey(function (err: any, verified: any) {
  if (verified) {
    winston.log("info", "Akismet: API key successfully verified.");
  } else {
    winston.log("info", "Akismet: Unable to verify API key.");
  }
});

function isSpam(o: {
  comment_content: any;
  comment_author: any;
  permalink: string;
  user_ip: any;
  user_agent: any;
  referrer: any;
}) {
  return new MPromise(
    "isSpam",
    function (resolve: (arg0: any) => void, reject: (arg0: any) => void) {
      akismet.checkSpam(o, function (err: any, spam: any) {
        if (err) {
          reject(err);
        } else {
          resolve(spam);
        }
      });
    }
  );
}

let INFO;
if (devMode) {
  // INFO = console.log;

  INFO = function () {
    winston.log.apply(console, arguments);
  };
} else {
  INFO = function () {};
}

// basic defaultdict implementation
function DD(this: any, f: () => { votes: number; comments: number }) {
  this.m = {};
  this.f = f;
}
// basic defaultarray implementation
function DA(this: any, f: any) {
  this.m = [];
  this.f = f;
}
DD.prototype.g = DA.prototype.g = function (k: string | number) {
  if (this.m.hasOwnProperty(k)) {
    return this.m[k];
  }
  let v = this.f(k);
  this.m[k] = v;
  return v;
};
DD.prototype.s = DA.prototype.s = function (k: string | number, v: any) {
  this.m[k] = v;
};

const domainOverride = Config.domainOverride;

function haltOnTimeout(req: { timedout: any }, res: any, next: () => void) {
  if (req.timedout) {
    fail(res, 500, "polis_err_timeout_misc");
  } else {
    next();
  }
}

function ifDefinedSet(
  name: string,
  source: { [x: string]: any },
  dest: { [x: string]: any }
) {
  if (!_.isUndefined(source[name])) {
    dest[name] = source[name];
  }
}

const sql_votes_latest_unique = SQL.sql_votes_latest_unique;
const sql_conversations = SQL.sql_conversations;
const sql_participant_metadata_answers = SQL.sql_participant_metadata_answers;
const sql_participants_extended = SQL.sql_participants_extended;
const sql_reports = SQL.sql_reports;
const sql_users = SQL.sql_users;

const encrypt = Session.encrypt;
const decrypt = Session.decrypt;
const makeSessionToken = Session.makeSessionToken;
const getUserInfoForSessionToken = Session.getUserInfoForSessionToken;
const createPolisLtiToken = Session.createPolisLtiToken;
const isPolisLtiToken = Session.isPolisLtiToken;
const getUserInfoForPolisLtiToken = Session.getUserInfoForPolisLtiToken;
const startSession = Session.startSession;
const endSession = Session.endSession;
const setupPwReset = Session.setupPwReset;
const getUidForPwResetToken = Session.getUidForPwResetToken;
const clearPwResetToken = Session.clearPwResetToken;

function hasAuthToken(req: { cookies: { [x: string]: any } }) {
  return !!req.cookies[COOKIES.TOKEN];
}

function getUidForApiKey(apikey: any) {
  return pgQueryP_readOnly_wRetryIfEmpty(
    "select uid from apikeysndvweifu WHERE apikey = ($1);",
    [apikey]
  );
}
// http://en.wikipedia.org/wiki/Basic_access_authentication#Client_side
function doApiKeyBasicAuth(
  assigner: any,
  header: string,
  isOptional: any,
  req: any,
  res: any,
  next: (err: any) => void
) {
  let token = header.split(/\s+/).pop() || "", // and the encoded auth token
    auth = new Buffer(token, "base64").toString(), // convert from base64
    parts = auth.split(/:/), // split on colon
    username = parts[0],
    // password = parts[1], // we don't use the password part (just use "apikey:")
    apikey = username;
  return doApiKeyAuth(assigner, apikey, isOptional, req, res, next);
}

function doApiKeyAuth(
  assigner: (arg0: any, arg1: string, arg2: number) => void,
  apikey: string,
  isOptional: any,
  req: any,
  res: { status: (arg0: number) => void },
  next: { (err: any): void; (err: any): void; (arg0?: string): void }
) {
  getUidForApiKey(apikey)
    .then(function (rows: string | any[]) {
      if (!rows || !rows.length) {
        res.status(403);
        next("polis_err_auth_no_such_api_token");
        return;
      }
      assigner(req, "uid", Number(rows[0].uid));
      next();
    })
    .catch(function (err: { stack: any }) {
      res.status(403);
      console.error(err.stack);
      next("polis_err_auth_no_such_api_token2");
    });
}

const createDummyUser = User.createDummyUser;
const getConversationInfo = Conversation.getConversationInfo;
const getConversationInfoByConversationId = Conversation.getConversationInfoByConversationId;
const isXidWhitelisted = Conversation.isXidWhitelisted;
const getXidRecordByXidOwnerId = User.getXidRecordByXidOwnerId;

function doXidApiKeyAuth(
  assigner: (arg0: any, arg1: string, arg2: number) => void,
  apikey: any,
  xid: any,
  isOptional: any,
  req: AuthRequest,
  res: { status: (arg0: number) => void },
  next: {
    (err: any): void;
    (err: any): void;
    (arg0?: string | undefined): void;
  }
) {
  getUidForApiKey(apikey)
    .then(
      function (rows: string | any[]) {
        if (!rows || !rows.length) {
          res.status(403);
          next("polis_err_auth_no_such_api_token4");
          return;
        }
        let uidForApiKey = Number(rows[0].uid);
        return getXidRecordByXidOwnerId(
          xid,
          uidForApiKey,
          void 0, //zid_optional,
          req.body.x_profile_image_url || req?.query?.x_profile_image_url,
          req.body.x_name || req?.query?.x_name || null,
          req.body.x_email || req?.query?.x_email || null,
          !!req.body.agid || !!req?.query?.agid || null
        ).then((rows: string | any[]) => {
          if (!rows || !rows.length) {
            if (isOptional) {
              return next();
            } else {
              res.status(403);
              next("polis_err_auth_no_such_xid_for_this_apikey_1");
              return;
            }
          }
          let uidForCurrentUser = Number(rows[0].uid);
          assigner(req, "uid", uidForCurrentUser);
          assigner(req, "xid", xid);
          assigner(req, "owner_uid", uidForApiKey);
          assigner(req, "org_id", uidForApiKey);
          next();
        });
      },
      function (err: { stack: any }) {
        res.status(403);
        console.error(err.stack);
        next("polis_err_auth_no_such_api_token3");
      }
    )
    .catch(function (err: { stack: any }) {
      res.status(403);
      console.error(err);
      console.error(err.stack);
      next("polis_err_auth_misc_23423");
    });
}
function doHeaderAuth(
  assigner: (arg0: any, arg1: string, arg2: number) => void,
  isOptional: any,
  req: { headers?: { [x: string]: any }; body: { uid?: any } },
  res: { status: (arg0: number) => void },
  next: { (err: any): void; (arg0?: string | undefined): void }
) {
  let token = "";
  if (req && req.headers) token = req?.headers?.["x-polis"];

  getUserInfoForSessionToken(token, res, function (err: any, uid?: any) {
    if (err) {
      res.status(403);
      next("polis_err_auth_no_such_token");
      return;
    }
    if (req.body.uid && req.body.uid !== uid) {
      res.status(401);
      next("polis_err_auth_mismatch_uid");
      return;
    }
    assigner(req, "uid", Number(uid));
    next();
  });
}

function doPolisLtiTokenHeaderAuth(
  assigner: (arg0: any, arg1: string, arg2: number) => void,
  isOptional: any,
  req: { headers?: { [x: string]: any } },
  res: { status: (arg0: number) => void },
  next: { (err: any): void; (arg0?: string): void }
) {
  let token = req?.headers?.["x-polis"];

  getUserInfoForPolisLtiToken(token)
    .then(function (uid?: any) {
      assigner(req, "uid", Number(uid));
      next();
    })
    .catch(function (err: any) {
      res.status(403);
      next("polis_err_auth_no_such_token");
      return;
    });
}

String.prototype.hashCode = function () {
  let hash = 0;
  let i;
  let character;
  if (this.length === 0) {
    return hash;
  }
  for (i = 0; i < this.length; i++) {
    character = this.charCodeAt(i);
    hash = (hash << 5) - hash + character;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
};

const fail = Log.fail;
const userFail = Log.userFail;



export { initializePolisHelpers };

export default { initializePolisHelpers };
