// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const akismetLib = require('akismet');
const AWS = require('aws-sdk');
AWS.config.set('region', 'us-east-1');
const badwords = require('badwords/object');
const Promise = require('bluebird');
const http = require('http');
const httpProxy = require('http-proxy');
// const Promise = require('es6-promise').Promise,
const sql = require("sql"); // see here for useful syntax: https://github.com/brianc/node-sql/blob/bbd6ed15a02d4ab8fbc5058ee2aff1ad67acd5dc/lib/node/valueExpression.js
const escapeLiteral = require('pg').Client.prototype.escapeLiteral;
const async = require('async');
const FB = require('fb');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
// May not need this anymore; looks like we're just using the other Intercom api, but need to figure out
// what's going on here
//const Intercom = require('intercom.io'); // https://github.com/tarunc/intercom.io
const IntercomOfficial = require('intercom-client');
const isTrue = require('boolean');
const OAuth = require('oauth');
// const Pushover = require('pushover-notifications');
// const pushoverInstance = new Pushover({
//   user: process.env.PUSHOVER_GROUP_POLIS_DEV,
//   token: process.env.PUSHOVER_POLIS_PROXY_API_KEY,
// });
// const postmark = require("postmark")(process.env.POSTMARK_API_KEY);
const querystring = require('querystring');
const devMode = isTrue(process.env.DEV_MODE);
const replaceStream = require('replacestream');
const responseTime = require('response-time');
const request = require('request-promise'); // includes Request, but adds promise methods
const s3Client = new AWS.S3({apiVersion: '2006-03-01'});
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const LruCache = require("lru-cache");
const timeout = require('connect-timeout');
const Translate = require('@google-cloud/translate');
const isValidUrl = require('valid-url');
const zlib = require('zlib');
const _ = require('underscore');
const Mailgun = require('mailgun-js');
const path = require('path');
const localServer = isTrue(config.get('LOCAL_SERVER'));
const i18n = require('i18n');

const config = require('./config');
const pg = require('./db/pg-query');
const MPromise = require('./utils/metered').MPromise;
const addInRamMetric = require('./utils/metered').addInRamMetric;
const yell = require('./log').yell;

i18n.configure({
    locales:['en', 'zh-TW'],
    directory: __dirname + '/locales'
});

// # Slack setup

var WebClient = require('@slack/client').WebClient;
var web = new WebClient(process.env.SLACK_API_TOKEN);
// const winston = require("winston");


// # notifications
const winston = console;
const emailSenders = require('./email/sendEmailSesMailgun').EmailSenders(AWS);
const sendTextEmail = emailSenders.sendTextEmail;

const resolveWith = (x) => { return Promise.resolve(x);};
const intercomClient = !isTrue(process.env.DISABLE_INTERCOM) ? new IntercomOfficial.Client({'token': process.env.INTERCOM_ACCESS_TOKEN}) : {
  leads: {
    create: resolveWith({body: {user_id: "null_intercom_user_id"}}),
    update: resolveWith({}),
  },
};

const useTranslateApi = isTrue(process.env.SHOULD_USE_TRANSLATION_API);
let translateClient = null;
if (useTranslateApi) {
  let creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (creds) {
    translateClient = Translate({
      projectId: JSON.parse(fs.readFileSync(creds)).project_id
    });
  } else {
    const GOOGLE_CREDS_TEMP_FILENAME = ".google_creds_temp";

    fs.writeFileSync(GOOGLE_CREDS_TEMP_FILENAME, process.env.GOOGLE_CREDS_STRINGIFIED);
    translateClient = Translate({
      projectId: JSON.parse(fs.readFileSync(GOOGLE_CREDS_TEMP_FILENAME)).project_id,
    });
  }

}


//var SegfaultHandler = require('segfault-handler');
 
//SegfaultHandler.registerHandler("segfault.log");

// var conversion = {
//   contact: { user_id: '8634dd66-f75e-428d-a2bf-930baa0571e9' },
//   user: { email: 'asdf@adsf.com', user_id: "12345" },
// };
// intercomClient.leads.convert(conversion).then((o) => {
//   console.error(o);
//   console.error(4);
// }).catch((err) => {
//   console.error(5);
//   console.error(err);
// });




if (devMode) {
  Promise.longStackTraces();
}

// Bluebird uncaught error handler.
Promise.onPossiblyUnhandledRejection(function(err) {
  console.log("onPossiblyUnhandledRejection");
  if (_.isObject(err)) {
    // since it may just throw as [object Object]
    console.error(1);
    console.dir(err);
    console.error(2);
    console.error(err);
    console.error(3);

    if (err && err.stack) {
      console.error(err.stack);
    }
    try {
      console.error(4);
      console.error(JSON.stringify(err));
    } catch (e) {
      console.error(5);
      console.error("stringify threw");
    }
  }
  console.error(6);
  // throw err; // not throwing since we're printing stack traces anyway
});



const adminEmailDataExport = process.env.ADMIN_EMAIL_DATA_EXPORT || ""
const adminEmailDataExportTest = process.env.ADMIN_EMAIL_DATA_EXPORT_TEST || ""
const adminEmailEmailTest = process.env.ADMIN_EMAIL_EMAIL_TEST || ""

const admin_emails = process.env.ADMIN_EMAILS ? JSON.parse(process.env.ADMIN_EMAILS) : [];
const polisDevs = process.env.ADMIN_UIDS ? JSON.parse(process.env.ADMIN_UIDS) : [];


function isPolisDev(uid) {
  console.log("polisDevs", polisDevs)
  return polisDevs.indexOf(uid) >= 0;
}

// so we can grant extra days to users
// eventually we should probably move this to db.
// for now, use git blame to see when these were added
const  usersToAdditionalTrialDays = {
  50756: 14, // julien
  85423: 100, // mike test
};

// log heap stats
setInterval(function() {
  let mem = process.memoryUsage();
  let heapUsed = mem.heapUsed;
  let rss = mem.rss;
  let heapTotal = mem.heapTotal;
  winston.log("info", "heapUsed:", heapUsed, "heapTotal:", heapTotal, "rss:", rss);
  // let start = Date.now();

  //metric("api.process.mem.heapUsed", heapUsed, start);
  //metric("api.process.mem.rss", rss, start);
  //metric("api.process.mem.heapTotal", heapTotal, start);
}, 10 * 1000);


// // BEGIN GITHUB OAUTH2
// let CLIENT_SECRET = "0b178e412a10fa023a0153bf7cefaf6dae0f74b9";
// let CLIENT_ID = "109a1eb4732b3ec1075b";
// let oauth2 = require('simple-oauth2')({
//   clientID: CLIENT_ID,
//   clientSecret: CLIENT_SECRET,
//   site: 'https://github.com/login',
//   tokenPath: '/oauth/access_token'
// });

// winston.log("info",oauth2);

// // Authorization uri definition
// let authorization_uri = oauth2.AuthCode.authorizeURL({
//   redirect_uri: 'https://preprod.pol.is/oauth2/oauth2_github_callback',
//   scope: 'notifications',
//   state: '3(#0/!~'
// });
// // END GITHUB OAUTH2


const POLIS_FROM_ADDRESS = process.env.POLIS_FROM_ADDRESS;

const akismet = akismetLib.client({
  blog: 'https://pol.is', // required: your root level url
  apiKey: process.env.AKISMET_ANTISPAM_API_KEY,
});

akismet.verifyKey(function(err, verified) {
  if (verified) {
    winston.log("info", 'Akismet: API key successfully verified.');
  } else {
    winston.log("info", 'Akismet: Unable to verify API key.');
  }
});


// let SELF_HOSTNAME = "localhost:" + process.env.PORT;
// if (!devMode) {
// ^^^ possible to use localhost on Heroku?
//  SELF_HOSTNAME = process.env.SERVICE_HOSTNAME
//}


function isSpam(o) {
  return new MPromise("isSpam", function(resolve, reject) {
    akismet.checkSpam(o, function(err, spam) {
      if (err) {
        reject(err);
      } else {
        resolve(spam);
      }
    });
  });
}

var INFO;
if (devMode) {
  INFO = console.log;

  // INFO = function() {
  //     winston.log.apply(console, arguments);
  // };
} else {
  INFO = function() {};
}



// basic defaultdict implementation
function DD(f) {
  this.m = {};
  this.f = f;
}
// basic defaultarray implementation
function DA(f) {
  this.m = [];
  this.f = f;
}
DD.prototype.g = DA.prototype.g = function(k) {
  if (this.m.hasOwnProperty(k)) {
    return this.m[k];
  }
  let v = this.f(k);
  this.m[k] = v;
  return v;
};
DD.prototype.s = DA.prototype.s = function(k, v) {
  this.m[k] = v;
};
// function emptyArray() {
//   return [];
// }



const domainOverride = process.env.DOMAIN_OVERRIDE || null;

function haltOnTimeout(req, res, next) {
  if (req.timedout) {
    fail(res, 500, "polis_err_timeout_misc");
  } else {
    next();
  }
}

function ifDefinedSet(name, source, dest) {
  if (!_.isUndefined(source[name])) {
    dest[name] = source[name];
  }
}

//metric("api.process.launch", 1);

// TODO clean this up
// const intercom = new Intercom(process.env.INTERCOM_ACCESS_TOKEN);
const intercom = intercomClient;

//first we define our tables
const sql_conversations = sql.define({
  name: 'conversations',
  columns: [
    "zid",
    "topic",
    "description",
    "participant_count",
    "is_anon",
    "is_active",
    "is_draft",
    "is_public", // TODO remove this column
    "is_data_open",
    "is_slack",
    "profanity_filter",
    "spam_filter",
    "strict_moderation",
    "email_domain",
    "owner",
    "org_id",
    "owner_sees_participation_stats",
    "context",
    "course_id",
    "lti_users_only",
    "modified",
    "created",
    "link_url",
    "parent_url",
    "vis_type",
    "write_type",
    "help_type",
    "socialbtn_type",
    "subscribe_type",
    "bgcolor",
    "help_color",
    "help_bgcolor",
    "style_btn",
    "auth_needed_to_vote",
    "auth_needed_to_write",
    "auth_opt_fb",
    "auth_opt_tw",
    "auth_opt_allow_3rdparty",
  ],
});

// const sql_votes = sql.define({
//   name: 'votes',
//   columns: [
//     "zid",
//     "tid",
//     "pid",
//     "created",
//     "vote",
//   ],
// });

const sql_votes_latest_unique = sql.define({
  name: 'votes_latest_unique',
  columns: [
    "zid",
    "tid",
    "pid",
    "modified",
    "vote",
  ],
});
const sql_comments = sql.define({
  name: 'comments',
  columns: [
    "tid",
    "zid",
    "pid",
    "uid",
    "created",
    "txt",
    "velocity",
    "active",
    "mod",
    "quote_src_url",
    "anon",
  ],
});

const sql_participant_metadata_answers = sql.define({
  name: 'participant_metadata_answers',
  columns: [
    "pmaid",
    "pmqid",
    "zid",
    "value",
    "alive",
  ],
});

const sql_participants_extended = sql.define({
  name: 'participants_extended',
  columns: [
    "uid",
    "zid",
    "referrer",
    "parent_url",
    "created",
    "modified",

    "show_translation_activated",

    "permanent_cookie",
    "origin",
    "encrypted_ip_address",
    "encrypted_x_forwarded_for",
  ],
});

//first we define our tables
const sql_users = sql.define({
  name: 'users',
  columns: [
    "uid",
    "hname",
    "email",
    "created",
  ],
});

const sql_reports = sql.define({
  name: 'reports',
  columns: [
    "rid",
    "report_id",
    "zid",
    "created",
    "modified",
    "report_name",
    "label_x_neg",
    "label_x_pos",
    "label_y_neg",
    "label_y_pos",
    "label_group_0",
    "label_group_1",
    "label_group_2",
    "label_group_3",
    "label_group_4",
    "label_group_5",
    "label_group_6",
    "label_group_7",
    "label_group_8",
    "label_group_9",
  ],
});



// // Eventually, the plan is to support a larger number-space by using some lowercase letters.
// // Waiting to implement that since there's cognitive overhead with mapping the IDs to/from
// // letters/numbers.
// // Just using digits [2-9] to start with. Omitting 0 and 1 since they can be confused with
// // letters once we start using letters.
// // This should give us roughly 8^8 = 16777216 conversations before we have to add letters.
// let ReadableIds = (function() {
//     function rand(a) {
//         return _.random(a.length);
//     }
//     // no 1 (looks like l)
//     // no 0 (looks like 0)
//     let numbers8 = "23456789".split("");

//     // should fit within 32 bits
//     function generateConversationId() {
//        return [
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8),
//             rand(numbers8)
//         ].join('');
//     }
//     return {
//         generateConversationId: generateConversationId,
//     };
// }());






function encrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = process.env.ENCRYPTION_PASSWORD_00001;
  const cipher = crypto.createCipher(algorithm, password);
  var crypted = cipher.update(text,'utf8','hex');
  crypted += cipher.final('hex');
  return crypted;
}

function decrypt(text) {
  const algorithm = 'aes-256-ctr';
  const password = process.env.ENCRYPTION_PASSWORD_00001;
  const decipher = crypto.createDecipher(algorithm, password);
  var dec = decipher.update(text,'hex','utf8');
  dec += decipher.final('utf8');
  return dec;
}
decrypt; // appease linter


function makeSessionToken() {
  // These can probably be shortened at some point.
  return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, "").substr(0, 20);
}

// But we need to squeeze a bit more out of the db right now,
// and generally remove sources of uncertainty about what makes
// various queries slow. And having every single query talk to PG
// adds a lot of variability across the board.
const userTokenCache = new LruCache({
  max: 9000,
});

function getUserInfoForSessionToken(sessionToken, res, cb) {
  let cachedUid = userTokenCache.get(sessionToken);
  if (cachedUid) {
    cb(null, cachedUid);
    return;
  }
  pg.queryP("select uid from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
    if (err) {
      console.error("token_fetch_error");
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      console.error("token_expired_or_missing");

      cb(403);
      return;
    }
    let uid = results.rows[0].uid;
    userTokenCache.set(sessionToken, uid);
    cb(null, uid);
  });
}


function createPolisLtiToken(tool_consumer_instance_guid, lti_user_id) {
  return ["xPolisLtiToken", tool_consumer_instance_guid, lti_user_id].join(":::");
}

function isPolisLtiToken(token) {
  return token.match(/^xPolisLtiToken/);
}
function isPolisSlackTeamUserToken(token) {
  return token.match(/^xPolisSlackTeamUserToken/);
}

// function sendSlackEvent(slack_team, o) {
//   return pg.queryP("insert into slack_bot_events (slack_team, event) values ($1, $2);", [slack_team, o]);
// }
function sendSlackEvent(o) {
  return pg.queryP("insert into slack_bot_events (event) values ($1);", [o]);
}

function parsePolisLtiToken(token) {
  let parts = token.split(/:::/);
  let o = {
    // parts[0] === "xPolisLtiToken", don't need that
    tool_consumer_instance_guid: parts[1],
    lti_user_id: parts[2],
  };
  return o;
}




function getUserInfoForPolisLtiToken(token) {
  let o = parsePolisLtiToken(token);
  return pg.queryP("select uid from lti_users where tool_consumer_instance_guid = $1 and lti_user_id = $2", [
    o.tool_consumer_instance_guid,
    o.lti_user_id,
  ]).then(function(rows) {
    return rows[0].uid;
  });
}

function startSession(uid, cb) {
  let token = makeSessionToken();
  //winston.log("info",'startSession: token will be: ' + sessionToken);
  winston.log("info", 'startSession');
  pg.queryP("insert into auth_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(err, repliesSetToken) {
    if (err) {
      cb(err);
      return;
    }
    winston.log("info", 'startSession: token set.');
    cb(null, token);
  });
}

function endSession(sessionToken, cb) {
  pg.queryP("delete from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
    if (err) {
      cb(err);
      return;
    }
    cb(null);
  });
}


function setupPwReset(uid, cb) {
  function makePwResetToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(140).toString('base64').replace(/[^A-Za-z0-9]/g, "").substr(0, 100);
  }
  let token = makePwResetToken();
  pg.queryP("insert into pwreset_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(errSetToken, repliesSetToken) {
    if (errSetToken) {
      cb(errSetToken);
      return;
    }
    cb(null, token);
  });
}

function getUidForPwResetToken(pwresettoken, cb) {
  // TODO "and created > timestamp - x"
  pg.queryP("select uid from pwreset_tokens where token = ($1);", [pwresettoken], function(errGetToken, results) {
    if (errGetToken) {
      console.error("pwresettoken_fetch_error");
      cb(500);
      return;
    }
    if (!results || !results.rows || !results.rows.length) {
      console.error("token_expired_or_missing");
      cb(403);
      return;
    }
    cb(null, {
      uid: results.rows[0].uid,
    });
  });
}

function clearPwResetToken(pwresettoken, cb) {
  pg.queryP("delete from pwreset_tokens where token = ($1);", [pwresettoken], function(errDelToken, repliesSetToken) {
    if (errDelToken) {
      cb(errDelToken);
      return;
    }
    cb(null);
  });
}



function hasAuthToken(req) {
  return !!req.cookies[COOKIES.TOKEN];
}



function getUidForApiKey(apikey) {
  return pg.queryP_readOnly_wRetryIfEmpty("select uid from apikeysndvweifu WHERE apikey = ($1);", [apikey]);
}


// http://en.wikipedia.org/wiki/Basic_access_authentication#Client_side
function doApiKeyBasicAuth(assigner, header, isOptional, req, res, next) {
  let token = header.split(/\s+/).pop() || '', // and the encoded auth token
    auth = new Buffer(token, 'base64').toString(), // convert from base64
    parts = auth.split(/:/), // split on colon
    username = parts[0],
    // password = parts[1], // we don't use the password part (just use "apikey:")
    apikey = username;
  return doApiKeyAuth(assigner, apikey, isOptional, req, res, next);
}

function doApiKeyAuth(assigner, apikey, isOptional, req, res, next) {
  getUidForApiKey(apikey).then(function(rows) {
    if (!rows || !rows.length) {
      res.status(403);
      next("polis_err_auth_no_such_api_token");
      return;
    }
    assigner(req, "uid", Number(rows[0].uid));
    next();
  }).catch(function(err) {
    res.status(403);
    console.error(err.stack);
    next("polis_err_auth_no_such_api_token2");
  });
}

// function getXidRecordByXidConversationId(xid, conversation_id) {
//   return pg.queryP("select * from xids where xid = ($2) and owner = (select org_id from conversations where zid = (select zid from zinvites where zinvite = ($1)))", [zinvite, xid]);
// }


function createDummyUser() {
  return new MPromise("createDummyUser", function(resolve, reject) {
    pg.queryP("INSERT INTO users (created) VALUES (default) RETURNING uid;", [], function(err, results) {
      if (err || !results || !results.rows || !results.rows.length) {
        console.error(err);
        reject(new Error("polis_err_create_empty_user"));
        return;
      }
      resolve(results.rows[0].uid);
    });
  });
}

function createXidRecord(ownerUid, uid, xid, x_profile_image_url, x_name, x_email) {
  return pg.queryP("insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ($1, $2, $3, $4, $5, $6) " +
    "on conflict (owner, xid) do nothing;", [
      ownerUid,
      uid,
      xid,
      x_profile_image_url || null,
      x_name || null,
      x_email || null,
    ]);
}



function getConversationInfo(zid) {
  return new MPromise("getConversationInfo", function(resolve, reject) {
    pg.queryP("SELECT * FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.rows[0]);
      }
    });
  });
}

function getConversationInfoByConversationId(conversation_id) {
  return new MPromise("getConversationInfoByConversationId", function(resolve, reject) {
    pg.queryP("SELECT * FROM conversations WHERE zid = (select zid from zinvites where zinvite = ($1));", [conversation_id], function(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.rows[0]);
      }
    });
  });
}

function isXidWhitelisted(owner, xid) {
  return pg.queryP("select * from xid_whitelist where owner = ($1) and xid = ($2);", [owner, xid]).then((rows) => {
    return !!rows && rows.length > 0;
  });
}

function getXidRecordByXidOwnerId(xid, owner, zid_optional, x_profile_image_url, x_name, x_email, createIfMissing) {
  return pg.queryP("select * from xids where xid = ($1) and owner = ($2);", [xid, owner]).then(function(rows) {
    if (!rows || !rows.length) {
      console.log('no xInfo yet');
      if (!createIfMissing) {
        return null;
      }

      var shouldCreateXidEntryPromise = !zid_optional ? Promise.resolve(true) : getConversationInfo(zid_optional).then((conv) => {
        return conv.use_xid_whitelist ? isXidWhitelisted(owner, xid) : Promise.resolve(true);
      });

      return shouldCreateXidEntryPromise.then((should) => {
        if (!should) {
          return null;
        }
        return createDummyUser().then((newUid) => {
          console.log('created dummy');
          return createXidRecord(owner, newUid, xid, x_profile_image_url||null, x_name||null, x_email||null).then(() => {
            console.log('created xInfo');
            return [{
              uid: newUid,
              owner: owner,
              xid: xid,
              x_profile_image_url: x_profile_image_url,
              x_name: x_name,
              x_email: x_email,
            }];
          });
        });
      });
    }
    return rows;
  });
}

// function doXidOwnerConversationIdAuth(assigner, xid, conversation_id, req, res, next) {
//   getXidRecordByXidConversationId(xid, conversation_id).then(function(rows) {
//     if (!rows || !rows.length) {
//       res.status(403);
//       next("polis_err_auth_no_such_api_token4");
//       return;
//     }
//     assigner(req, "uid", Number(rows[0].uid));
//     next();
//   });
// }


function doXidApiKeyAuth(assigner, apikey, xid, isOptional, req, res, next) {
  getUidForApiKey(apikey).then(function(rows) {
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
      req.body.x_profile_image_url || req.query.x_profile_image_url,
      req.body.x_name || req.query.x_name || null,
      req.body.x_email || req.query.x_email || null,
      !!req.body.agid || !!req.query.agid || null
    ).then((rows) => {
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

  }, function(err) {
    res.status(403);
    console.error(err.stack);
    next("polis_err_auth_no_such_api_token3");
  }).catch(function(err) {
    res.status(403);
    console.error(err);
    console.error(err.stack);
    next("polis_err_auth_misc_23423");
  });
}


function doHeaderAuth(assigner, isOptional, req, res, next) {
  let token = req.headers["x-polis"];

  //if (req.body.uid) { next(401); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
  getUserInfoForSessionToken(token, res, function(err, uid) {

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

function doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, next) {
  let token = req.headers["x-polis"];

  getUserInfoForPolisLtiToken(token).then(function(uid) {
    assigner(req, "uid", Number(uid));
    next();
  }).catch(function(err) {
    res.status(403);
    next("polis_err_auth_no_such_token");
    return;
  });
}

function doPolisSlackTeamUserTokenHeaderAuth(assigner, isOptional, req, res, next) {
  let token = req.headers["x-polis"];

  getUserInfoForPolisLtiToken(token).then(function(uid) {
    assigner(req, "uid", Number(uid));
    next();
  }).catch(function(err) {
    res.status(403);
    next("polis_err_auth_no_such_token");
    return;
  });
}


// Consolidate query/body items in one place so other middleware has one place to look.
function moveToBody(req, res, next) {
  if (req.query) {
    req.body = req.body || {};
    Object.assign(req.body, req.query);
  }
  if (req.params) {
    req.body = req.body || {};
    Object.assign(req.body, req.params);
  }
  // inti req.p if not there already
  req.p = req.p || {};
  next();
}

// function logPath(req, res, next) {
//     winston.log("info",req.method + " " + req.url);
//     next();
// }


String.prototype.hashCode = function() {
  let hash = 0;
  let i;
  let character;
  if (this.length === 0) {
    return hash;
  }
  for (i = 0; i < this.length; i++) {
    character = this.charCodeAt(i);
    hash = ((hash << 5) - hash) + character;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
};

function fail(res, httpCode, clientVisibleErrorString, err) {
  emitTheFailure(res, httpCode, "polis_err", clientVisibleErrorString, err);
  yell(clientVisibleErrorString);
}

function userFail(res, httpCode, clientVisibleErrorString, err) {
  emitTheFailure(res, httpCode, "polis_user_err", clientVisibleErrorString, err);
}

function emitTheFailure(res, httpCode, extraErrorCodeForLogs, clientVisibleErrorString, err) {
  console.error(clientVisibleErrorString, extraErrorCodeForLogs, err);
  if (err && err.stack) {
    console.error(err.stack);
  }
  res.writeHead(httpCode || 500);
  res.end(clientVisibleErrorString);
}

function isEmail(s) {
  return typeof s === "string" && s.length < 999 && s.indexOf("@") > 0;
}

function getEmail(s) {
  return new Promise(function(resolve, reject) {
    if (!isEmail(s)) {
      return reject("polis_fail_parse_email");
    }
    resolve(s);
  });
}

function getPassword(s) {
  return new Promise(function(resolve, reject) {
    if (typeof s !== "string" || s.length > 999 || s.length === 0) {
      return reject("polis_fail_parse_password");
    }
    resolve(s);
  });
}

function getPasswordWithCreatePasswordRules(s) {
  return getPassword(s).then(function(s) {
    if (typeof s !== "string" || s.length < 6) {
      throw new Error("polis_err_password_too_short");
    }
    return s;
  });
}

function getOptionalStringLimitLength(limit) {
  return function(s) {
    return new Promise(function(resolve, reject) {
      if (s.length && s.length > limit) {
        return reject("polis_fail_parse_string_too_long");
      }
      // strip leading/trailing spaces
      s = s.replace(/^ */, "").replace(/ *$/, "");
      resolve(s);
    });
  };
}

function getStringLimitLength(min, max) {
  if (_.isUndefined(max)) {
    max = min;
    min = 1;
  }
  return function(s) {
    return new Promise(function(resolve, reject) {
      if (typeof s !== "string") {
        return reject("polis_fail_parse_string_missing");
      }
      if (s.length && s.length > max) {
        return reject("polis_fail_parse_string_too_long");
      }
      if (s.length && s.length < min) {
        return reject("polis_fail_parse_string_too_short");
      }
      // strip leading/trailing spaces
      s = s.replace(/^ */, "").replace(/ *$/, "");
      resolve(s);
    });
  };
}

function getUrlLimitLength(limit) {
  return function(s) {
    getStringLimitLength(limit)(s).then(function(s) {
      return new Promise(function(resolve, reject) {
        if (isValidUrl(s)) {
          return resolve(s);
        } else {
          return reject("polis_fail_parse_url_invalid");
        }
      });
    });
  };
}


function getBool(s) {
  return new Promise(function(resolve, reject) {
    let type = typeof s;
    if ("boolean" === type) {
      return resolve(s);
    }
    if ("number" === type) {
      if (s === 0) {
        return resolve(false);
      }
      return resolve(true);
    }
    s = s.toLowerCase();
    if (s === 't' || s === 'true' || s === 'on' || s === '1') {
      return resolve(true);
    } else if (s === 'f' || s === 'false' || s === 'off' || s === '0') {
      return resolve(false);
    }
    reject("polis_fail_parse_boolean");
  });
}

function getInt(s) {
  return new Promise(function(resolve, reject) {
    if (_.isNumber(s) && s >> 0 === s) {
      return resolve(s);
    }
    let x = parseInt(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_int " + s);
    }
    resolve(x);
  });
}


const conversationIdToZidCache = new LruCache({
  max: 1000,
});
const reportIdToRidCache = new LruCache({
  max: 1000,
});

// NOTE: currently conversation_id is stored as zinvite
function getZidFromConversationId(conversation_id) {
  return new MPromise("getZidFromConversationId", function(resolve, reject) {
    let cachedZid = conversationIdToZidCache.get(conversation_id);
    if (cachedZid) {
      resolve(cachedZid);
      return;
    }
    pgQuery_readOnly("select zid from zinvites where zinvite = ($1);", [conversation_id], function(err, results) {
      if (err) {
        return reject(err);
      } else if (!results || !results.rows || !results.rows.length) {
        console.error("polis_err_fetching_zid_for_conversation_id " + conversation_id);
        return reject("polis_err_fetching_zid_for_conversation_id");
      } else {
        let zid = results.rows[0].zid;
        conversationIdToZidCache.set(conversation_id, zid);
        return resolve(zid);
      }
    });
  });
}
function getRidFromReportId(report_id) {
  return new MPromise("getRidFromReportId", function(resolve, reject) {
    let cachedRid = reportIdToRidCache.get(report_id);
    if (cachedRid) {
      resolve(cachedRid);
      return;
    }
    pgQuery_readOnly("select rid from reports where report_id = ($1);", [report_id], function(err, results) {
      if (err) {
        return reject(err);
      } else if (!results || !results.rows || !results.rows.length) {
        console.error("polis_err_fetching_rid_for_report_id " + report_id);
        return reject("polis_err_fetching_rid_for_report_id");
      } else {
        let rid = results.rows[0].rid;
        reportIdToRidCache.set(report_id, rid);
        return resolve(rid);
      }
    });
  });
}

// conversation_id is the client/ public API facing string ID
const parseConversationId = getStringLimitLength(1, 100);

function getConversationIdFetchZid(s) {
  return parseConversationId(s).then(function(conversation_id) {
    return getZidFromConversationId(conversation_id).then(function(zid) {
      return Number(zid);
    });
  });
}

const parseReportId = getStringLimitLength(1, 100);
function getReportIdFetchRid(s) {
  return parseReportId(s).then(function(report_id) {
    console.log(report_id);
    return getRidFromReportId(report_id).then(function(rid) {
      console.log(rid);
      return Number(rid);
    });
  });
}



function getNumber(s) {
  return new Promise(function(resolve, reject) {
    if (_.isNumber(s)) {
      return resolve(s);
    }
    let x = parseFloat(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_number");
    }
    resolve(x);
  });
}

function getNumberInRange(min, max) {
  return function(s) {
    return getNumber(s).then(function(x) {
      if (x < min || max < x) {
        throw "polis_fail_parse_number_out_of_range";
      }
      return x;
    });
  };
}

function getArrayOfString(a, maxStrings, maxLength) {
  return new Promise(function(resolve, reject) {
    if (_.isString(a)) {
      a = a.split(',');
    }
    if (!_.isArray(a)) {
      return reject("polis_fail_parse_int_array");
    }
    resolve(a);
  });
}

function getArrayOfStringNonEmpty(a, maxStrings, maxLength) {
  if (!a || !a.length) {
    return Promise.reject("polis_fail_parse_string_array_empty");
  }
  return getArrayOfString(a);
}

function getArrayOfStringLimitLength(maxStrings, maxLength) {
  return function(a) {
    return getArrayOfString(a, maxStrings||999999999, maxLength);
  };
}

function getArrayOfStringNonEmptyLimitLength(maxStrings, maxLength) {
  return function(a) {
    return getArrayOfStringNonEmpty(a, maxStrings||999999999, maxLength);
  };
}

function getArrayOfInt(a) {
  if (_.isString(a)) {
    a = a.split(',');
  }
  if (!_.isArray(a)) {
    return Promise.reject("polis_fail_parse_int_array");
  }

  function integer(i) {
    return Number(i) >> 0;
  }
  return Promise.resolve(a.map(integer));
}

function getIntInRange(min, max) {
  return function(s) {
    return getInt(s).then(function(x) {
      if (x < min || max < x) {
        throw "polis_fail_parse_int_out_of_range";
      }
      return x;
    });
  };
}

function assignToP(req, name, x) {
  req.p = req.p || {};
  if (!_.isUndefined(req.p[name])) {
    let s = "clobbering " + name;
    console.error(s);
    yell(s);
  }
  req.p[name] = x;
}

function assignToPCustom(name) {
  return function(req, ignoredName, x) {
    assignToP(req, name, x);
  };
}


function extractFromBody(req, name) {
  if (!req.body) {
    return void 0;
  }
  return req.body[name];
}

function extractFromCookie(req, name) {
  if (!req.cookies) {
    return void 0;
  }
  return req.cookies[name];
}

function extractFromHeader(req, name) {
  if (!req.headers) {
    return void 0;
  }
  return req.headers[name.toLowerCase()];
}


const prrrams = (function() {
  function buildCallback(config) {
    let name = config.name;
    let parserWhichReturnsPromise = config.parserWhichReturnsPromise;
    let assigner = config.assigner;
    let required = config.required;
    let defaultVal = config.defaultVal;
    let extractor = config.extractor;

    if (typeof assigner !== "function") {
      throw "bad arg for assigner";
    }
    if (typeof parserWhichReturnsPromise !== "function") {
      throw "bad arg for parserWhichReturnsPromise";
    }

    let f = function(req, res, next) {
      let val = extractor(req, name);
      if (!_.isUndefined(val) && !_.isNull(val)) {
        parserWhichReturnsPromise(val).then(function(parsed) {
          assigner(req, name, parsed);
          next();
        }, function(e) {
          let s = "polis_err_param_parse_failed_" + name;
          console.error(s);
          console.error(e);
          yell(s);
          res.status(400);
          next(s);
          return;
        }).catch(function(err) {
          fail(res, "polis_err_misc", err);
          return;
        });
      } else if (!required) {
        if (typeof defaultVal !== "undefined") {
          assigner(req, name, defaultVal);
        }
        next();
      } else {
        // winston.log("info",req);
        let s = "polis_err_param_missing_" + name;
        console.error(s);
        yell(s);
        res.status(400);
        next(s);
      }
    };
    return f;
  }

  return {
    need: function(name, parserWhichReturnsPromise, assigner) {
      return buildCallback({
        name: name,
        extractor: extractFromBody,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: true,
      });
    },
    want: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
      return buildCallback({
        name: name,
        extractor: extractFromBody,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: false,
        defaultVal: defaultVal,
      });
    },
    needCookie: function(name, parserWhichReturnsPromise, assigner) {
      return buildCallback({
        name: name,
        extractor: extractFromCookie,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: true,
      });
    },
    wantCookie: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
      return buildCallback({
        name: name,
        extractor: extractFromCookie,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: false,
        defaultVal: defaultVal,
      });
    },
    needHeader: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
      return buildCallback({
        name: name,
        extractor: extractFromHeader,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: true,
        defaultVal: defaultVal,
      });
    },
    wantHeader: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
      return buildCallback({
        name: name,
        extractor: extractFromHeader,
        parserWhichReturnsPromise: parserWhichReturnsPromise,
        assigner: assigner,
        required: false,
        defaultVal: defaultVal,
      });
    },
  };
}());
const need = prrrams.need;
const want = prrrams.want;
// let needCookie = prrrams.needCookie;
const wantCookie = prrrams.wantCookie;
const needHeader = prrrams.needHeader;
const wantHeader = prrrams.wantHeader;

const COOKIES = {
  COOKIE_TEST: 'ct',
  HAS_EMAIL: 'e',
  TOKEN: 'token2',
  UID: 'uid2',
  REFERRER: 'ref',
  PARENT_REFERRER: 'referrer',
  PARENT_URL: 'parent_url',
  USER_CREATED_TIMESTAMP: 'uc',
  PERMANENT_COOKIE: 'pc',
  TRY_COOKIE: 'tryCookie',
  PLAN_NUMBER: 'plan', // not set if trial user
};
const COOKIES_TO_CLEAR = {
  e: true,
  token2: true,
  uid2: true,
  uc: true,
  plan: true,
  referrer: true,
  parent_url: true,
};



function initializePolisHelpers() {

  let polisTypes = {
    reactions: {
      push: 1,
      pull: -1,
      see: 0,
      pass: 0,
    },
    staractions: {
      unstar: 0,
      star: 1,
    },
    mod: {
      ban: -1,
      unmoderated: 0,
      ok: 1,
    },
  };
  polisTypes.reactionValues = _.values(polisTypes.reactions);
  polisTypes.starValues = _.values(polisTypes.staractions);


  // // If there are any comments which have no votes by the owner, create a PASS vote by the owner.
  // pg.queryP("select * from comments", [], function(err, comments) {
  //     pg.queryP("select * from votes", [], function(err, votes) {
  //         comments = comments.rows;
  //         votes = votes.rows;

  //         let exists = {};
  //         votes.forEach(function(v) {
  //             exists[v.zid +"_"+ v.tid] = true;
  //         });
  //         let missing = [];
  //         for (var i = 0 ; i < comments.length; i++) {
  //             let c = comments[i];
  //             if (!exists[c.zid + "_" + c.tid]) {
  //                 missing.push(c);
  //             }
  //         }
  //         async.series(
  //             missing.map(function(c) {
  //                 return function(callback) {
  //                     votesPost(uid, c.pid, c.zid, c.tid, 0)
  //                         .then(function() {
  //                             winston.log("info","ok " + c.txt);
  //                             callback(null);
  //                         })
  //                         .catch(function() {
  //                             winston.log("info","failedd " + c.txt);
  //                             callback(1);
  //                         });
  //                 };
  //             }),
  //             function(err, results) {
  //                 winston.log("info",err);
  //             });


  //         winston.log("info",missing);
  //         winston.log("info",missing.length);
  //         winston.log("info",comments.length);
  //     });
  // });



  let oneYear = 1000 * 60 * 60 * 24 * 365;

  function setCookie(req, res, setOnPolisDomain, name, value, options) {
    let o = _.clone(options || {});
    o.path = _.isUndefined(o.path) ? '/' : o.path;
    o.maxAge = _.isUndefined(o.maxAge) ? oneYear : o.maxAge;
    if (setOnPolisDomain) {
      o.secure = _.isUndefined(o.secure) ? true : o.secure;
      o.domain = _.isUndefined(o.domain) ? '.pol.is' : o.domain;
      // if (/pol.is/.test(req.headers.host)) {
      //   o.domain = '.pol.is';
      // }
    }
    res.cookie(name, value, o);
  }

  function setParentReferrerCookie(req, res, setOnPolisDomain, referrer) {
    setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_REFERRER, referrer, {
      httpOnly: true,
    });
  }

  function setParentUrlCookie(req, res, setOnPolisDomain, parent_url) {
    setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_URL, parent_url, {
      httpOnly: true,
    });
  }

  function setPlanCookie(req, res, setOnPolisDomain, planNumber) {
    if (planNumber > 0) {
      setCookie(req, res, setOnPolisDomain, COOKIES.PLAN_NUMBER, planNumber, {
        // not httpOnly - needed by JS
      });
    }
    // else falsy

  }

  function setHasEmailCookie(req, res, setOnPolisDomain, email) {
    if (email) {
      setCookie(req, res, setOnPolisDomain, COOKIES.HAS_EMAIL, 1, {
        // not httpOnly - needed by JS
      });
    }
    // else falsy
  }

  function setUserCreatedTimestampCookie(req, res, setOnPolisDomain, timestamp) {
    setCookie(req, res, setOnPolisDomain, COOKIES.USER_CREATED_TIMESTAMP, timestamp, {
      // not httpOnly - needed by JS
    });
  }

  function setTokenCookie(req, res, setOnPolisDomain, token) {
    setCookie(req, res, setOnPolisDomain, COOKIES.TOKEN, token, {
      httpOnly: true,
    });
  }

  function setUidCookie(req, res, setOnPolisDomain, uid) {
    setCookie(req, res, setOnPolisDomain, COOKIES.UID, uid, {
      // not httpOnly - needed by JS
    });
  }

  function setPermanentCookie(req, res, setOnPolisDomain, token) {
    setCookie(req, res, setOnPolisDomain, COOKIES.PERMANENT_COOKIE, token, {
      httpOnly: true,
    });
  }

  function setCookieTestCookie(req, res, setOnPolisDomain) {
    setCookie(req, res, setOnPolisDomain, COOKIES.COOKIE_TEST, 1, {
      // not httpOnly - needed by JS
    });
  }

  function shouldSetCookieOnPolisDomain(req) {
    let setOnPolisDomain = !domainOverride;
    let origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }
    return setOnPolisDomain;
  }

  function addCookies(req, res, token, uid) {
    return getUserInfoForUid2(uid).then(function(o) {
      let email = o.email;
      let created = o.created;
      let plan = o.plan;

      let setOnPolisDomain = shouldSetCookieOnPolisDomain(req);

      setTokenCookie(req, res, setOnPolisDomain, token);
      setUidCookie(req, res, setOnPolisDomain, uid);
      setPlanCookie(req, res, setOnPolisDomain, plan);
      setHasEmailCookie(req, res, setOnPolisDomain, email);
      setUserCreatedTimestampCookie(req, res, setOnPolisDomain, created);
      if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
        setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
      }
      res.header("x-polis", token);
    });
  }

  function getPermanentCookieAndEnsureItIsSet(req, res) {
    let setOnPolisDomain = shouldSetCookieOnPolisDomain(req);
    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      let token = makeSessionToken();
      setPermanentCookie(req, res, setOnPolisDomain, token);
      return token;
    } else {
      return req.cookies[COOKIES.PERMANENT_COOKIE];
    }
  }

  function generateHashedPassword(password, callback) {
    bcrypt.genSalt(12, function(errSalt, salt) {
      if (errSalt) {
        return callback("polis_err_salt");
      }
      bcrypt.hash(password, salt, function(errHash, hashedPassword) {
        if (errHash) {
          return callback("polis_err_hash");
        }
        callback(null, hashedPassword);
      });
    });
  }

  let pidCache = new LruCache({
    max: 9000,
  });

  // returns a pid of -1 if it's missing
  function getPid(zid, uid, callback) {
    let cacheKey = zid + "_" + uid;
    let cachedPid = pidCache.get(cacheKey);
    if (!_.isUndefined(cachedPid)) {
      callback(null, cachedPid);
      return;
    }
    pgQuery_readOnly("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, docs) {
      let pid = -1;
      if (docs && docs.rows && docs.rows[0]) {
        pid = docs.rows[0].pid;
        pidCache.set(cacheKey, pid);
      }
      callback(err, pid);
    });
  }

  // returns a pid of -1 if it's missing
  function getPidPromise(zid, uid, usePrimary) {
    let cacheKey = zid + "_" + uid;
    let cachedPid = pidCache.get(cacheKey);
    return new MPromise("getPidPromise", function(resolve, reject) {
      if (!_.isUndefined(cachedPid)) {
        resolve(cachedPid);
        return;
      }
      const f = usePrimary ? pgQuery : pgQuery_readOnly;
      f("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, results) {
        if (err) {
          return reject(err);
        }
        if (!results || !results.rows || !results.rows.length) {
          resolve(-1);
          return;
        }
        let pid = results.rows[0].pid;
        pidCache.set(cacheKey, pid);
        resolve(pid);
      });
    });
  }


  function resolve_pidThing(pidThingStringName, assigner, loggingString) {
    if (_.isUndefined(loggingString)) {
      loggingString = "";
    }
    return function(req, res, next) {
      if (!req.p) {
        fail(res, 500, "polis_err_this_middleware_should_be_after_auth_and_zid");
        next("polis_err_this_middleware_should_be_after_auth_and_zid");
      }
      console.dir(req.p);

      let existingValue = extractFromBody(req, pidThingStringName) || extractFromCookie(req, pidThingStringName);

      if (existingValue === "mypid" && req.p.zid && req.p.uid) {
        getPidPromise(req.p.zid, req.p.uid).then(function(pid) {
          if (pid >= 0) {
            assigner(req, pidThingStringName, pid);
          }
          next();
        }).catch(function(err) {
          fail(res, 500, "polis_err_mypid_resolve_error", err);
          next(err);
        });
      } else if (existingValue === "mypid") {
        // don't assign anything, since we have no uid to look it up.
        next();
      } else if (!_.isUndefined(existingValue)) {
        getInt(existingValue).then(function(pidNumber) {
          assigner(req, pidThingStringName, pidNumber);
          next();
        }).catch(function(err) {
          fail(res, 500, "polis_err_pid_error", err);
          next(err);
        });
      } else {
        next();
      }
    };
  }


  // must follow auth and need('zid'...) middleware
  function getPidForParticipant(assigner, cache) {
    return function(req, res, next) {
      let zid = req.p.zid;
      let uid = req.p.uid;

      function finish(pid) {
        assigner(req, "pid", pid);
        next();
      }
      getPidPromise(zid, uid).then(function(pid) {
        if (pid === -1) {
          let msg = "polis_err_get_pid_for_participant_missing";
          yell(msg);

          winston.log("info", zid);
          winston.log("info", uid);
          winston.log("info", req.p);
          next(msg);
        }
        finish(pid);
      }, function(err) {
        yell("polis_err_get_pid_for_participant");
        next(err);
      });
    };
  }


  function recordPermanentCookieZidJoin(permanentCookieToken, zid) {
    function doInsert() {
      return pg.queryP("insert into permanentCookieZidJoins (cookie, zid) values ($1, $2);", [permanentCookieToken, zid]);
    }
    return pg.queryP("select zid from permanentCookieZidJoins where cookie = ($1) and zid = ($2);", [permanentCookieToken, zid]).then(
      function(rows) {
        if (rows && rows.length) {
          // already there
        } else {
          return doInsert();
        }
      },
      function(err) {
        console.error(err);
        // hmm, weird, try inserting anyway
        return doInsert();
      });
  }

  function detectLanguage(txt) {
    if (useTranslateApi) {
      return translateClient.detect(txt);
    }
    return Promise.resolve([{
      confidence: null,
      language: null,
    }]);
  }


  if (isTrue(process.env.BACKFILL_COMMENT_LANG_DETECTION)) {
    pg.queryP("select tid, txt, zid from comments where lang is null;", []).then((comments) => {
      let i = 0;
      function doNext() {
        if (i < comments.length) {
          let c = comments[i];
          i += 1;
          detectLanguage(c.txt).then((x) => {
            x = x[0];
            console.log("backfill", x.language + "\t\t" + c.txt);
            pg.queryP("update comments set lang = ($1), lang_confidence = ($2) where zid = ($3) and tid = ($4)",[
              x.language,
              x.confidence,
              c.zid,
              c.tid,
            ]).then(() => {
              doNext();
            });
          });
        }
      }
      doNext();
    });
  }




  function translateString(txt, target_lang) {
    if (useTranslateApi) {
      // Let traditional Chinese has higher priority
      if (target_lang == 'zh') {
        target_lang = 'zh-TW';
      }
      return translateClient.translate(txt, target_lang);
    }
    return Promise.resolve(null);
  }


  function doVotesPost(uid, pid, conv, tid, voteType, weight, shouldNotify) {
    let zid = conv.zid;
    weight = weight || 0;
    let weight_x_32767 = Math.trunc(weight * 32767); // weight is stored as a SMALLINT, so convert from a [-1,1] float to [-32767,32767] int
    return new Promise(function(resolve, reject) {
      let query = "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, created) VALUES ($1, $2, $3, $4, $5, default) RETURNING *;";
      let params = [pid, zid, tid, voteType, weight_x_32767];
      pg.queryP(query, params, function(err, result) {
        if (err) {
          if (isDuplicateKey(err)) {
            reject("polis_err_vote_duplicate");
          } else {
            console.dir(err);
            reject("polis_err_vote_other");
          }
          return;
        }

        const vote = result.rows[0];

        if (shouldNotify && conv && conv.is_slack) {
          sendSlackEvent({
            type: "vote",
            data: Object.assign({
              uid: uid,
            }, vote),
          });
        }

        resolve({
          conv: conv,
          vote: vote,
        });
      });
    });
  }

  function votesPost(uid, pid, zid, tid, voteType, weight, shouldNotify) {
    return pg.queryP_readOnly("select * from conversations where zid = ($1);", [zid]).then(function(rows) {
      if (!rows || !rows.length) {
        throw "polis_err_unknown_conversation";
      }
      let conv = rows[0];
      if (!conv.is_active) {
        throw "polis_err_conversation_is_closed";
      }
      if (conv.auth_needed_to_vote) {

        return isModerator(zid, uid).then((is_mod) => {
          if (is_mod) {
            return conv;
          }
          return Promise.all([
            pg.queryP("select * from xids where owner = ($1) and uid = ($2);", [conv.owner, uid]),
            getSocialInfoForUsers([uid], zid),
          ]).then(([
            xids,
            info,
          ]) => {
            var socialAccountIsLinked = info.length > 0;
            var hasXid = xids.length > 0;
            if (socialAccountIsLinked || hasXid) {
              return conv;
            } else {
              throw "polis_err_post_votes_social_needed";
            }
          });
        });
      }
      return conv;
    }).then(function(conv) {
      return doVotesPost(uid, pid, conv, tid, voteType, weight, shouldNotify);
    });
  }


  function getVotesForSingleParticipant(p) {
    if (_.isUndefined(p.pid)) {
      return Promise.resolve([]);
    }
    return votesGet(p);
  }

  function votesGet(p) {
    return new MPromise("votesGet", function(resolve, reject) {
      let q = sql_votes_latest_unique.select(sql_votes_latest_unique.star())
        .where(sql_votes_latest_unique.zid.equals(p.zid));

      if (!_.isUndefined(p.pid)) {
        q = q.where(sql_votes_latest_unique.pid.equals(p.pid));
      }
      if (!_.isUndefined(p.tid)) {
        q = q.where(sql_votes_latest_unique.tid.equals(p.tid));
      }
      pgQuery_readOnly(q.toString(), function(err, results) {
        if (err) {
          reject(err);
        } else {
          resolve(results.rows);
        }
      });
    });
  } // End votesGet

  function writeDefaultHead(req, res, next) {
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      //    'Access-Control-Allow-Origin': '*',
      //    'Access-Control-Allow-Credentials': 'true'
    });
    next();
  }

  function redirectIfNotHttps(req, res, next) {

    let exempt = devMode;

    // IE is picky, so use HTTP.
    // TODO figure out IE situation, (proxy static files in worst-case)
    // exempt = exempt || /MSIE/.test(req.headers['user-agent']); // TODO test IE11

    if (exempt) {
      return next();
    }

    if (!/https/.test(req.headers["x-forwarded-proto"])) { // assuming we're running on Heroku, where we're behind a proxy.
      res.writeHead(302, {
        Location: "https://" + req.headers.host + req.url,
      });
      return res.end();
    }
    return next();
  }

  function redirectIfApiDomain(req, res, next) {
    if (/api.pol.is/.test(req.headers.host)) {
      if (req.url === "/" || req.url === "") {
        res.writeHead(302, {
          Location: "https://pol.is/docs/api",
        });
        return res.end();
      } else if (!req.url.match(/^\/?api/)) {
        res.writeHead(302, {
          Location: "https://pol.is/" + req.url,
        });
        return res.end();
      }
    }
    return next();
  }

  // function createDummyUsersBatch(n) {
  //     let query = "insert into users (created) values ";
  //     let values = [];
  //     for (var i = 0; i < n; i++) {
  //         values.push("(default)");
  //     }
  //     values = values.join(",");
  //     query += values;
  //     query += " returning uid;";

  //     return new MPromise("createDummyUser", function(resolve, reject) {
  //         pg.queryP(query,[], function(err, results) {
  //             if (err || !results || !results.rows || !results.rows.length) {
  //                 console.error(err);
  //                 reject(new Error("polis_err_create_empty_user"));
  //                 return;
  //             }
  //             let uids = results.rows.map(function(row) {
  //                 return row.uid;
  //             });
  //             resolve(uids);
  //         });
  //     });
  // }

  function doXidConversationIdAuth(assigner, xid, conversation_id, isOptional, req, res, onDone) {
    return getConversationInfoByConversationId(conversation_id).then((conv) => {
      return getXidRecordByXidOwnerId(
        xid,
        conv.org_id,
        conv.zid,
        req.body.x_profile_image_url || req.query.x_profile_image_url,
        req.body.x_name || req.query.x_name || null,
        req.body.x_email || req.query.x_email || null,
        !!req.body.agid || !!req.query.agid || null)
      .then((rows) => {
        if (!rows || !rows.length) {
          if (isOptional) {
            return onDone();
          } else {
            res.status(403);
            onDone("polis_err_auth_no_such_xid_for_this_apikey_11");
            return;
          }
        }
        let uidForCurrentUser = Number(rows[0].uid);
        assigner(req, "uid", uidForCurrentUser);
        onDone();
      });
    }).catch((err) => {
      console.log(err);
      onDone(err);
    });
  }


  function _auth(assigner, isOptional) {

    function getKey(req, key) {
      return req.body[key] || req.headers[key] || req.query[key];
    }

    function doAuth(req, res) {
      //var token = req.body.token;
      let token = req.cookies[COOKIES.TOKEN];
      let xPolisToken = req.headers["x-polis"];

      return new Promise(function(resolve, reject) {
        function onDone(err) {
          if (err) {
            reject(err);
          }
          if ((!req.p || !req.p.uid) && !isOptional) {
            reject("polis_err_mandatory_auth_unsuccessful");
          }
          resolve(req.p && req.p.uid);
        }
        if (xPolisToken && isPolisLtiToken(xPolisToken)) {
          console.log("authtype", "doPolisLtiTokenHeaderAuth");
          doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, onDone);
        } else if (xPolisToken && isPolisSlackTeamUserToken(xPolisToken)) {
          console.log("authtype", "doPolisSlackTeamUserTokenHeaderAuth");
          doPolisSlackTeamUserTokenHeaderAuth(assigner, isOptional, req, res, onDone);
        } else if (xPolisToken) {
          console.log("authtype", "doHeaderAuth");
          doHeaderAuth(assigner, isOptional, req, res, onDone);
        } else if (getKey(req, "polisApiKey") && getKey(req, "ownerXid")) {
          console.log("authtype", "doXidApiKeyAuth");
          doXidApiKeyAuth(assigner, getKey(req, "polisApiKey"), getKey(req, "ownerXid"), isOptional, req, res, onDone);
        } else if (getKey(req, "polisApiKey") && getKey(req, "xid")) {
          console.log("authtype", "doXidApiKeyAuth");
          doXidApiKeyAuth(assigner, getKey(req, "polisApiKey"), getKey(req, "xid"), isOptional, req, res, onDone);
        // } else if (req.headers["x-sandstorm-app-polis-apikey"] && req.headers["x-sandstorm-app-polis-xid"] && req.headers["x-sandstorm-app-polis-owner-xid"]) {
        //   doXidApiKeyAuth(
        //     assigner,
        //     req.headers["x-sandstorm-app-polis-apikey"],
        //     req.headers["x-sandstorm-app-polis-owner-xid"],
        //     req.headers["x-sandstorm-app-polis-xid"],
        //     isOptional, req, res, onDone);
        } else if (getKey(req, "xid") && getKey(req, "conversation_id")) {
          console.log("authtype", "doXidConversationIdAuth");
          doXidConversationIdAuth(assigner, getKey(req, "xid"), getKey(req, "conversation_id"), isOptional, req, res, onDone);
        } else if (req.headers["x-sandstorm-app-polis-apikey"]) {
          console.log("authtype", "doApiKeyAuth");
          doApiKeyAuth(assigner, req.headers["x-sandstorm-app-polis-apikey"], isOptional, req, res, onDone);
        } else if (req.body["polisApiKey"]) {
          console.log("authtype", "doApiKeyAuth");
          doApiKeyAuth(assigner, getKey(req, "polisApiKey"), isOptional, req, res, onDone);
        } else if (token) {
          console.log("authtype", "doCookieAuth");
          doCookieAuth(assigner, isOptional, req, res, onDone);
        } else if (req.headers.authorization) {
          console.log("authtype", "doApiKeyBasicAuth");
          doApiKeyBasicAuth(assigner, req.headers.authorization, isOptional, req, res, onDone);
        } else if (req.body.agid) { // Auto Gen user  ID
          console.log("authtype", "no auth but agid");
          createDummyUser().then(function(uid) {
            let shouldAddCookies = _.isUndefined(req.body.xid);
            if (!shouldAddCookies) {
              req.p = req.p || {};
              req.p.uid = uid;
              return onDone();
            }
            return startSessionAndAddCookies(req, res, uid).then(function() {
              req.p = req.p || {};
              req.p.uid = uid;
              onDone();
            }, function(err) {
              res.status(500);
              console.error(err);
              onDone("polis_err_auth_token_error_2343");
            });
          }, function(err) {
            res.status(500);
            console.error(err);
            onDone("polis_err_auth_token_error_1241");
          }).catch(function(err) {
            res.status(500);
            console.error(err);
            onDone("polis_err_auth_token_error_5345");
          });
        } else if (isOptional) {
          onDone(); // didn't create user
        } else {
          res.status(401);
          onDone("polis_err_auth_token_not_supplied");
        }
      });
    }


    return function(req, res, next) {

      doAuth(req, res).then(() => {
        return next();
      }).catch((err) => {
        res.status(500);
        console.error(err);
        next(err || "polis_err_auth_error_432");
      });
    };

    //   let xid = req.body.xid;
    //   let hasXid = !_.isUndefined(xid);

    //   if (hasXid) {
    //     console.log('weee 0');
    //     req.p = req.p || {};
    //     req.p.xid = xid;
    //     console.log('xidflow has');
    //     getConversationIdFetchZid(req.body.conversation_id).then((zid) => {
    //       console.log('xidflow got zid', zid);

    //       return getXidStuff(xid, zid).then((xidRecord) => {
    //         console.log('xidflow got xidRecord', xidRecord);
    //         let foundXidRecord = xidRecord !== "noXidRecord";
    //         if (foundXidRecord) {
    //           console.log('xidflow !shouldCreateXidRecord');
    //           assigner(req, "uid", Number(xidRecord.uid));
    //           return next();
    //         }
    //         console.log('xidflow before doAuth');
    //         // try other auth methods, and once those are done, use req.p.uid to create new xid record.
    //         doAuth(req, res).then(() => {
    //           console.log('xidflow after doAuth');
    //           if (req.p.uid && !isOptional) { // req.p.uid might be set now.
    //             console.log('xidflow uid', req.p.uid);
    //             return createXidRecordByZid(zid, req.p.uid, xid, req.body.x_profile_image_url, req.body.x_name, req.body.x_email);
    //           } else if (!isOptional) {
    //             console.log('xidflow no uid, but mandatory', req.p.uid);
    //             throw "polis_err_missing_non_optional_uid";
    //           }
    //           console.log('xidflow was optional, doing nothing');
    //         }).then(() => {
    //           console.log('xidflow ok');
    //           return next();
    //         }).catch((err) => {
    //           res.status(500);
    //           console.error(err);
    //           return next("polis_err_auth_xid_error_423423");
    //         });
    //       });
    //     });
    //   } else {
    //     doAuth(req, res).then(() => {
    //       return next();
    //     }).catch((err) => {
    //       res.status(500);
    //       console.error(err);
    //       next("polis_err_auth_error_432");
    //     });
    //   }
    // };
  }


  // input token from body or query, and populate req.body.u with userid.
  function authOptional(assigner) {
    return _auth(assigner, true);
  }

  function auth(assigner) {
    return _auth(assigner, false);
  }

  function enableAgid(req, res, next) {
    req.body.agid = 1;
    next();
  }


  let whitelistedCrossDomainRoutes = [
    /^\/api\/v[0-9]+\/launchPrep/,
    /^\/api\/v[0-9]+\/setFirstCookie/,
  ];

  let whitelistedDomains = [
    "pol.is",
    process.env.DOMAIN_WHITELIST_ITEM_01,
    process.env.DOMAIN_WHITELIST_ITEM_02,
    process.env.DOMAIN_WHITELIST_ITEM_03,
    process.env.DOMAIN_WHITELIST_ITEM_04,
    process.env.DOMAIN_WHITELIST_ITEM_05,
    process.env.DOMAIN_WHITELIST_ITEM_06,
    process.env.DOMAIN_WHITELIST_ITEM_07,
    process.env.DOMAIN_WHITELIST_ITEM_08,
    "localhost:5001",
    "localhost:5002",
    "canvas.instructure.com", // LTI
    "canvas.uw.edu", // LTI
    "canvas.shoreline.edu", // LTI
    "shoreline.instructure.com", // LTI
    "facebook.com",
    "api.twitter.com",
    "connect.stripe.com",
    "", // for API
  ];



  let whitelistedBuckets = {
    "pol.is": "pol.is",
    "embed.pol.is": "pol.is",
    "survey.pol.is": "survey.pol.is",
    "preprod.pol.is": "preprod.pol.is",
  };


  function hasWhitelistMatches(host) {

    let hostWithoutProtocol = host;
    if (host.startsWith("http://")) {
      hostWithoutProtocol = host.slice(7);
    } else if (host.startsWith("https://")) {
      hostWithoutProtocol = host.slice(8);
    }

    for (let i = 0; i < whitelistedDomains.length; i++) {
      let w = whitelistedDomains[i];
      if (hostWithoutProtocol.endsWith(w)) {
        // ok, the ending matches, now we need to make sure it's the same, or a subdomain.
        if (hostWithoutProtocol === w) {
          return true;
        }
        if (hostWithoutProtocol[hostWithoutProtocol.length-(w.length + 1)] === ".") {
          // separated by a dot, so it's a subdomain.
          return true;
        }
      }
    }
    return false;
  }

  function addCorsHeader(req, res, next) {

    let host = "";
    if (domainOverride) {
      host = req.protocol + "://" + domainOverride;
    } else {
      // TODO does it make sense for this middleware to look
      // at origin || referer? is Origin for CORS preflight?
      // or for everything?
      // Origin was missing from FF, so added Referer.
      host = req.get("Origin") || req.get("Referer") || "";
    }

    // Somehow the fragment identifier is being sent by IE10????
    // Remove unexpected fragment identifier
    host = host.replace(/#.*$/, "");

    // Remove characters starting with the first slash following the double slash at the beginning.
    let result = /^[^\/]*\/\/[^\/]*/.exec(host);
    if (result && result[0]) {
      host = result[0];
    }


    // check if the route is on a special list that allows it to be called cross domain (by polisHost.js for example)
    let routeIsWhitelistedForAnyDomain = _.some(whitelistedCrossDomainRoutes, function(regex) {
      return regex.test(req.path);
    });




    if (!domainOverride && !hasWhitelistMatches(host) && !routeIsWhitelistedForAnyDomain) {
      winston.log("info", 'not whitelisted');
      // winston.log("info",req);
      winston.log("info", req.headers);
      winston.log("info", req.path);
      return next("unauthorized domain: " + host);
    }
    if (host === "") {
      // API
    } else {
      res.header("Access-Control-Allow-Origin", host);
      res.header("Access-Control-Allow-Headers", "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With");
      res.header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Credentials", true);
    }
    return next();
  }



  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  //
  //             BEGIN ROUTES
  //
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////
  ////////////////////////////////////////////

  function strToHex(str) {
    let hex, i;
    // let str = "\u6f22\u5b57"; // "\u6f22\u5b57" === "漢字"
    let result = "";
    for (i = 0; i < str.length; i++) {
      hex = str.charCodeAt(i).toString(16);
      result += ("000" + hex).slice(-4);
    }
    return result;
  }

  function hexToStr(hexString) {
    let j;
    let hexes = hexString.match(/.{1,4}/g) || [];
    let str = "";
    for (j = 0; j < hexes.length; j++) {
      str += String.fromCharCode(parseInt(hexes[j], 16));
    }
    return str;
  }



  function handle_GET_launchPrep(req, res) {


    let setOnPolisDomain = !domainOverride;
    let origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
    }
    setCookieTestCookie(req, res, setOnPolisDomain);

    setCookie(req, res, setOnPolisDomain, "top", "ok", {
      httpOnly: false, // not httpOnly - needed by JS
    });

    // using hex since it doesn't require escaping like base64.
    let dest = hexToStr(req.p.dest);
    res.redirect(dest);
  }


  // function handle_GET_setFirstCookie(req, res) {


  //     let setOnPolisDomain = !domainOverride;
  //     let origin = req.headers.origin || "";
  //     if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
  //         setOnPolisDomain = false;
  //     }

  //     if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
  //         setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
  //     }
  //     setCookie(req, res, setOnPolisDomain, "top", "ok", {
  //         httpOnly: false,            // not httpOnly - needed by JS
  //     });
  //     res.status(200).json({});
  // });

  function handle_GET_tryCookie(req, res) {


    let setOnPolisDomain = !domainOverride;
    let origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.TRY_COOKIE]) {
      setCookie(req, res, setOnPolisDomain, COOKIES.TRY_COOKIE, "ok", {
        httpOnly: false, // not httpOnly - needed by JS
      });
    }
    res.status(200).json({});
  }


  let pcaCacheSize = (process.env.CACHE_MATH_RESULTS === "true") ? 300 : 1;
  let pcaCache = new LruCache({
    max: pcaCacheSize,
  });

  let lastPrefetchedMathTick = -1;

  // this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
  function fetchAndCacheLatestPcaData() {
    let lastPrefetchPollStartTime = Date.now();

    function waitTime() {
      let timePassed = Date.now() - lastPrefetchPollStartTime;
      return Math.max(0, 2500 - timePassed);
    }


    // cursor.sort([["math_tick", "asc"]]);
    pg.queryP_readOnly("select * from math_main where caching_tick > ($1) order by caching_tick limit 10;", [lastPrefetchedMathTick]).then((rows) => {

      if (!rows || !rows.length) {
        // call again
        INFO("mathpoll done");
        setTimeout(fetchAndCacheLatestPcaData, waitTime());
        return;
      }

      let results = rows.map((row) => {
        let item = row.data;

        if (row.math_tick) {
          item.math_tick = Number(row.math_tick);
        }
        if (row.caching_tick) {
          item.caching_tick = Number(row.caching_tick);
        }

        INFO("mathpoll updating", item.caching_tick, item.zid);

        // let prev = pcaCache.get(item.zid);
        if (item.caching_tick > lastPrefetchedMathTick) {
          lastPrefetchedMathTick = item.caching_tick;
        }

        processMathObject(item);

        return updatePcaCache(item.zid, item);
      });
      Promise.all(results).then((a) => {
        setTimeout(fetchAndCacheLatestPcaData, waitTime());
      });
    }).catch((err) => {
      INFO("mathpoll error", err);
      setTimeout(fetchAndCacheLatestPcaData, waitTime());
    });

  }

  // don't start immediately, let other things load first.
  // setTimeout(fetchAndCacheLatestPcaData, 5000);
  fetchAndCacheLatestPcaData; // TODO_DELETE

  function processMathObject(o) {

    function remapSubgroupStuff(g) {
      if (_.isArray(g.val)) {
        g.val = g.val.map((x) => {
          return {id: Number(x.id), val: x};
        });
      } else {
        g.val = _.keys(g.val).map((id) => {
          return {id: Number(id), val: g.val[id]};
        });
      }
      return g;
    }

    // Normalize so everything is arrays of objects (group-clusters is already in this format, but needs to have the val: subobject style too).

    if (_.isArray(o['group-clusters'])) {
      // NOTE this is different since group-clusters is already an array.
      o['group-clusters'] = o['group-clusters'].map((g) => {
        return {id: Number(g.id), val: g};
      });
    }

    if (!_.isArray(o['repness'])) {
      o['repness'] = _.keys(o['repness']).map((gid) => {
        return {id: Number(gid), val: o['repness'][gid]};
      });
    }
    if (!_.isArray(o['group-votes'])) {
      o['group-votes'] = _.keys(o['group-votes']).map((gid) => {
        return {id: Number(gid), val: o['group-votes'][gid]};
      });
    }
    if (!_.isArray(o['subgroup-repness'])) {
      o['subgroup-repness'] = _.keys(o['subgroup-repness']).map((gid) => {
        return {id: Number(gid), val: o['subgroup-repness'][gid]};
      });
      o['subgroup-repness'].map(remapSubgroupStuff);
    }
    if (!_.isArray(o['subgroup-votes'])) {
      o['subgroup-votes'] = _.keys(o['subgroup-votes']).map((gid) => {
        return {id: Number(gid), val: o['subgroup-votes'][gid]};
      });
      o['subgroup-votes'].map(remapSubgroupStuff);
    }
    if (!_.isArray(o['subgroup-clusters'])) {
      o['subgroup-clusters'] = _.keys(o['subgroup-clusters']).map((gid) => {
        return {id: Number(gid), val: o['subgroup-clusters'][gid]};
      });
      o['subgroup-clusters'].map(remapSubgroupStuff);
    }

    // Edge case where there are two groups and one is huge, split the large group.
    // Once we have a better story for h-clust in the participation view, then we can just show the h-clust instead.
    // var groupVotes = o['group-votes'];
    // if (_.keys(groupVotes).length === 2 && o['subgroup-votes'] && o['subgroup-clusters'] && o['subgroup-repness']) {
    //   var s0 = groupVotes[0].val['n-members'];
    //   var s1 = groupVotes[1].val['n-members'];
    //   const scaleRatio = 1.1;
    //   if (s1 * scaleRatio < s0) {
    //     console.log('splitting 0', s0, s1, s1*scaleRatio);
    //     o = splitTopLevelGroup(o, groupVotes[0].id);
    //   } else if (s0 * scaleRatio < s1) {
    //     console.log('splitting 1', s0, s1, s0*scaleRatio);
    //     o = splitTopLevelGroup(o, groupVotes[1].id);
    //   }
    // }

    // // Gaps in the gids are not what we want to show users, and they make client development difficult.
    // // So this guarantees that the gids are contiguous. TODO look into Darwin.
    // o = packGids(o);

    // Un-normalize to maintain API consistency.
    // This could removed in a future API version.
    function toObj(a) {
      let obj = {};
      if (!a) {
        return obj;
      }
      for (let i = 0; i < a.length; i++) {
        obj[a[i].id] = a[i].val;
        obj[a[i].id].id = a[i].id;
      }
      return obj;
    }
    function toArray(a) {
      if (!a) {
        return [];
      }
      return a.map((g) => {
        let id = g.id;
        g = g.val;
        g.id = id;
        return g;
      });
    }
    o['repness'] = toObj(o['repness']);
    o['group-votes'] = toObj(o['group-votes']);
    o['group-clusters'] = toArray(o['group-clusters']);

    delete o['subgroup-repness'];
    delete o['subgroup-votes'];
    delete o['subgroup-clusters'];
    return o;
  }

  function getPca(zid, math_tick) {
    let cached = pcaCache.get(zid);
    if (cached && cached.expiration < Date.now()) {
      cached = null;
    }
    let cachedPOJO = cached && cached.asPOJO;
    if (cachedPOJO) {
      if (cachedPOJO.math_tick <= math_tick) {
        INFO("mathpoll related", "math was cached but not new: zid=", zid, "cached math_tick=",cachedPOJO.math_tick, "query math_tick=",math_tick);
        return Promise.resolve(null);
      } else {
        INFO("mathpoll related", "math from cache", zid, math_tick);
        return Promise.resolve(cached);
      }
    }

    INFO("mathpoll cache miss", zid, math_tick);

    // NOTE: not caching results from this query for now, think about this later.
    // not caching these means that conversations without new votes might not be cached. (closed conversations may be slower to load)
    // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down with the poll.

    let queryStart = Date.now();

    return pg.queryP_readOnly("select * from math_main where zid = ($1) and math_env = ($2);", [zid, process.env.MATH_ENV]).then((rows) => {

      let queryEnd = Date.now();
      let queryDuration = queryEnd - queryStart;
      addInRamMetric("pcaGetQuery", queryDuration);

      if (!rows || !rows.length) {
        INFO("mathpoll related; after cache miss, unable to find data for", {zid, math_tick, math_env: process.env.MATH_ENV});
        return null;
      }
      let item = rows[0].data;

      if (rows[0].math_tick) {
        item.math_tick = Number(rows[0].math_tick);
      }

      if (item.math_tick <= math_tick) {
        INFO("mathpoll related", "after cache miss, unable to find newer item", zid, math_tick);
        return null;
      }
      INFO("mathpoll related", "after cache miss, found item, adding to cache", zid, math_tick);

      processMathObject(item);

      return updatePcaCache(zid, item).then(function(o) {
        return o;
      }, function(err) {
        return err;
      });
    });
  }

  function updatePcaCache(zid, item) {
    return new Promise(function(resolve, reject) {
      delete item.zid; // don't leak zid
      let asJSON = JSON.stringify(item);
      let buf = new Buffer(asJSON, 'utf-8');
      zlib.gzip(buf, function(err, jsondGzipdPcaBuffer) {
        if (err) {
          return reject(err);
        }

        let o = {
          asPOJO: item,
          asJSON: asJSON,
          asBufferOfGzippedJson: jsondGzipdPcaBuffer,
          expiration: Date.now() + 3000,
        };
        // save in LRU cache, but don't update the lastPrefetchedMathTick
        pcaCache.set(zid, o);
        resolve(o);
      });
    });
  }


  function redirectIfHasZidButNoConversationId(req, res, next) {
    if (req.body.zid && !req.body.conversation_id) {
      winston.log("info", "redirecting old zid user to about page");
      res.writeHead(302, {
        Location: "https://pol.is/about",
      });
      return res.end();
    }
    return next();
  }



  function handle_GET_math_pca(req, res) {
    // migrated off this path, old clients were causing timeout issues by polling repeatedly without waiting for a result for a previous poll.
    res.status(304).end();
  }

  // Cache the knowledge of whether there are any pca results for a given zid.
  // Needed to determine whether to return a 404 or a 304.
  // zid -> boolean
  let pcaResultsExistForZid = {};


  function handle_GET_math_pca2(req, res) {
    let zid = req.p.zid;
    let math_tick = req.p.math_tick;

    let ifNoneMatch = req.p.ifNoneMatch;
    if (ifNoneMatch) {
      if (!_.isUndefined(math_tick)) {
        return fail(res, 400, "Expected either math_tick param or If-Not-Match header, but not both.");
      }
      if (ifNoneMatch.includes("*")) {
        math_tick = 0;
      } else {
        let entries = ifNoneMatch.split(/ *, */).map((x) => {
          return Number(x.replace(/^[wW]\//,'').replace(/^"/,'').replace(/"$/,''));
        });
        math_tick = _.min(entries); // supporting multiple values for the ifNoneMatch header doesn't really make sense, so I've arbitrarily chosen _.min to decide on one.
      }
    } else if (_.isUndefined(math_tick)) {
      math_tick = -1;
    }


    function finishWith304or404() {
      if (pcaResultsExistForZid[zid]) {
        res.status(304).end();
      } else {
        // Technically, this should probably be a 404, but
        // the red errors make it hard to see other errors
        // in Chrome Developer Tools.
        res.status(304).end();
        // res.status(404).end();
      }
    }

    getPca(zid, math_tick).then(function(data) {
      if (data) {
        // The buffer is gzipped beforehand to cut down on server effort in re-gzipping the same json string for each response.
        // We can't cache this endpoint on Cloudflare because the response changes too freqently, so it seems like the best way
        // is to cache the gzipped json'd buffer here on the server.
        res.set({
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Etag': '"' + data.asPOJO.math_tick + '"',
        });
        res.send(data.asBufferOfGzippedJson);
      } else {
        // check whether we should return a 304 or a 404
        if (_.isUndefined(pcaResultsExistForZid[zid])) {
          // This server doesn't know yet if there are any PCA results in the DB
          // So try querying from -1
          return getPca(zid, -1).then(function(data) {
            let exists = !!data;
            pcaResultsExistForZid[zid] = exists;
            finishWith304or404();
          });
        } else {
          finishWith304or404();
        }
      }
    }).catch(function(err) {
      fail(res, 500, err);
    });
  }


  function getZidForRid(rid) {
    return pg.queryP("select zid from reports where rid = ($1);", [rid]).then((row) => {
      if (!row || !row.length) {
        return null;
      }
      return row[0].zid;
    });
  }

  function handle_POST_math_update(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let math_env = process.env.MATH_ENV;
    let math_update_type = req.p.math_update_type;

    isModerator(zid, uid).then((hasPermission) => {
      if (!hasPermission) {
        return fail(res, 500, "handle_POST_math_update_permission");
      }
      return pg.queryP("insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('update_math', $1, $2, $3);", [
        JSON.stringify({
          zid: zid,
          math_update_type: math_update_type,
        }),
        zid,
        math_env,
      ]).then(() => {
        res.status(200).json({});
      }).catch((err) => {
        return fail(res, 500, "polis_err_POST_math_update", err);
      });
    });
  }

  function handle_GET_math_correlationMatrix(req, res) {
    let rid = req.p.rid;
    let math_env = process.env.MATH_ENV;
    let math_tick = req.p.math_tick;

    console.log(req.p);
    function finishAsPending() {
      res.status(202).json({
        status: "pending",
      });
    }

    function hasCommentSelections() {
      return pg.queryP("select * from report_comment_selections where rid = ($1) and selection = 1;", [rid]).then((rows) => {
        return rows.length > 0;
      });
    }

    let requestExistsPromise = pg.queryP(
      "select * from worker_tasks where task_type = 'generate_report_data' and math_env=($2) "+
        "and task_bucket = ($1) " +
        // "and attempts < 3 " +
        "and (task_data->>'math_tick')::int >= ($3) " +
        "and finished_time is NULL;", [rid, math_env, math_tick]);

    let resultExistsPromise = pg.queryP(
      "select * from math_report_correlationmatrix where rid = ($1) and math_env = ($2) and math_tick >= ($3);", [rid, math_env, math_tick]);

    Promise.all([
      resultExistsPromise,
      getZidForRid(rid),
    ]).then((a) => {
      let rows = a[0];
      let zid = a[1];
      if (!rows || !rows.length) {
        return requestExistsPromise.then((requests_rows) => {

          const shouldAddTask = !requests_rows || !requests_rows.length;
          // const shouldAddTask = true;

          if (shouldAddTask) {
            return hasCommentSelections().then((hasSelections) => {
              if (!hasSelections) {
                return res.status(202).json({
                  status: "polis_report_needs_comment_selection",
                });
              }
              return pg.queryP("insert into worker_tasks (task_type, task_data, task_bucket, math_env) values ('generate_report_data', $1, $2, $3);", [
                JSON.stringify({
                  rid: rid,
                  zid: zid,
                  math_tick: math_tick,
                }),
                rid,
                math_env,
              ]).then(finishAsPending);
            });
          }
          finishAsPending();
        });
      }
      res.json(rows[0].data);
    }).catch((err) => {
      return fail(res, 500, "polis_err_GET_math_correlationMatrix", err);
    });


  }



  function doAddDataExportTask(math_env, email, zid, atDate, format, task_bucket) {
    return pg.queryP("insert into worker_tasks (math_env, task_data, task_type, task_bucket) values ($1, $2, 'generate_export_data', $3);", [
      math_env,
      {
        'email': email,
        'zid': zid,
        'at-date': atDate,
        'format': format,
      },
      task_bucket, // TODO hash the params to get a consistent number?
    ]);
  }


  if (process.env.RUN_PERIODIC_EXPORT_TESTS && !devMode && process.env.MATH_ENV === "preprod") {
    let runExportTest = () => {
      let math_env = "prod";
      let email = adminEmailDataExportTest;
      let zid = 12480;
      let atDate = Date.now();
      let format = "csv";
      let task_bucket = Math.abs(Math.random() * 999999999999 >> 0);
      doAddDataExportTask(math_env, email, zid, atDate, format, task_bucket).then(() => {
        setTimeout(() => {
          pg.queryP("select * from worker_tasks where task_type = 'generate_export_data' and task_bucket = ($1);", [task_bucket]).then((rows) => {
            let ok = rows && rows.length;
            if (ok) {
              ok = rows[0].finished_time > 0;
            }
            if (ok) {
              console.log('runExportTest success');
            } else {
              console.log('runExportTest failed');
              emailBadProblemTime("Math export didn't finish.");
            }
          });
        }, 10 * 60 * 1000); // wait 10 minutes before verifying
      });
    }
    setInterval(runExportTest, 6 * 60 * 60 * 1000); // every 6 hours
  }

  function handle_GET_dataExport(req, res) {
    getUserInfoForUid2(req.p.uid).then((user) => {
      pg.queryP("SELECT tid, pid, uid, txt FROM comments WHERE zid=($1)", [req.p.zid], function (err, results) {
        let comments = {};
        let tids = [];
        let parts = [];
        for (let i in results.rows) {
          let row = results.rows[i];
          comments[row.tid] = {}; 
          comments[row.tid].txt = row.txt;
          comments[row.tid].uid = row.uid;
          comments[row.tid].agree = 0;
          comments[row.tid].disagree = 0;
          comments[row.tid].skip = 0;
          if (!(row.pid in parts)) {
            parts[row.pid] = {};
            parts[row.pid].n_comments = 0;
            parts[row.pid].n_votes = 0;
            parts[row.pid].n_agree = 0;
            parts[row.pid].n_disagree = 0;
            parts[row.pid].detail = {};
          }
          parts[row.pid].n_comments++;
        }
        pg.queryP("SELECT tid, pid, vote FROM votes WHERE zid=($1);", [req.p.zid], function (err, results) {
          for (let i in results.rows) {
            let row = results.rows[i];
            parts[row.pid].n_votes++;
            parts[row.pid].detail[row.tid] = row.vote;
            switch (row.vote) {
            case 0:
              comments[row.tid].skip++;
              break;
            case 1:
              comments[row.tid].agree++;
              parts[row.pid].n_agree++;
              break;
            case -1:
              comments[row.tid].disagree++;
              parts[row.pid].n_disagree++;
              break;
            }
          }
          // Fix to CSV
          let csv = '';
          let csv2 = '';
          csv += 'comment_body,id,idx,n_agree,n_disagree,percentage\n';
          csv2 += 'participant,group-id,n-comments,n-votes,n-agree,n-disagree';
          for (let tid in comments) {
            tids.push(tid);
            let c = comments[tid];
            csv += c.txt + ',';
            csv += tid + ',';
            csv += c.uid + ',';
            csv += c.agree + ',';
            csv += c.disagree + ',';
            if (c.agree + c.disagree === 0) {
              csv += '0';
            } else {
              csv += (100 * c.agree / (c.agree + c.disagree)).toFixed(2);
            }
            csv += '\n';
          }
          tids.sort((a,b)=>{return a-b;});
          for (let i in tids) {
            csv2 += ',' + tids[i];
          }
          csv2 += '\n';
          for (let pid in parts) {
            let p = parts[pid];
            csv2 += pid + ',';
            csv2 += ','; // group_id
            csv2 += p.n_comments + ',';
            csv2 += p.n_votes + ',';
            csv2 += p.n_agree + ',';
            csv2 += p.n_disagree;
            for (let i in tids) {
              let tid = tids[i];
              if (tid in p.detail) {
                csv2 += ',' + p.detail[tid];
              }
            }
            csv2 += '\n';
          }

          let tallyPath = path.join(__dirname, 'tally.csv');
          let pvPath = path.join(__dirname, 'participant-votes.csv');
          fs.writeFile(tallyPath, csv, (err) => {
            fs.writeFile(pvPath, csv2, (err) => {
              let mailgun = new Mailgun({apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN});
              let data = {
                from: POLIS_FROM_ADDRESS,
                to: user.email,
                subject: 'Polis exported data',
                text: 'This is polis, your requesting CSV file is attached.',
                attachment: [tallyPath, pvPath],
              };
              mailgun.messages().send(data, (error, body) => {
                if (error) {
                  console.log('Mailgun error:');
                  console.log(error);
                }
                console.log('Data export mail sent');
                console.log(body);
              });
              res.json({});
            });
          });
        });
      });
    });
  }

  function handle_GET_dataExport_results(req, res) {

    var url = s3Client.getSignedUrl('getObject', {
      Bucket: 'polis-datadump',
      Key: process.env.MATH_ENV + "/" + req.p.filename,
      Expires: 60*60*24*7,
    });
    res.redirect(url);

    // res.writeHead(302, {
    //   Location: protocol + "://" + req.headers.host + path,
    // });
    // return res.end();
  }


  function getBidIndexToPidMapping(zid, math_tick) {
    math_tick = math_tick || -1;


    return pg.queryP_readOnly("select * from math_bidtopid where zid = ($1) and math_env = ($2);", [zid, process.env.MATH_ENV]).then((rows) => {

      if (zid === 12480) {
        console.log("bidToPid", rows[0].data);
      }
      if (!rows || !rows.length) {
        // Could actually be a 404, would require more work to determine that.
        return new Error("polis_err_get_pca_results_missing");
      } else if (rows[0].data.math_tick <= math_tick) {
        return new Error("polis_err_get_pca_results_not_new");
      } else {
        return rows[0].data;
      }
    });
  }


  function handle_GET_bidToPid(req, res) {
    let zid = req.p.zid;
    let math_tick = req.p.math_tick;
    getBidIndexToPidMapping(zid, math_tick).then(function(doc) {
      let b2p = doc.bidToPid;
      res.json({
        bidToPid: b2p,
      });
    }, function(err) {
      res.status(304).end();
    });
  }

  function getXids(zid) {
    return new MPromise("getXids", function(resolve, reject) {
      pgQuery_readOnly("select pid, xid from xids inner join " +
        "(select * from participants where zid = ($1)) as p on xids.uid = p.uid " +
        " where owner in (select org_id from conversations where zid = ($1));", [zid],
        function(err, result) {
          if (err) {
            reject("polis_err_fetching_xids");
            return;
          }
          resolve(result.rows);
        });
    });
  }


  function handle_GET_xids(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;

    isOwner(zid, uid).then(function(owner) {
      if (owner) {
        getXids(zid).then(function(xids) {
          res.status(200).json(xids);
        }, function(err) {
          fail(res, 500, "polis_err_get_xids", err);
        });
      } else {
        fail(res, 403, "polis_err_get_xids_not_authorized");
      }
    }, function(err) {
      fail(res, 500, "polis_err_get_xids", err);
    });
  }


  function handle_POST_xidWhitelist(req, res) {
    const xid_whitelist = req.p.xid_whitelist;
    const len = xid_whitelist.length;
    const owner = req.p.uid;
    const entries = [];
    try {
      for (var i = 0; i < len; i++) {
        entries.push("(" + escapeLiteral(xid_whitelist[i]) + "," + owner + ")");
      }
    } catch (err) {
      return fail(res, 400, "polis_err_bad_xid", err);
    }

    pg.queryP("insert into xid_whitelist (xid, owner) values " + entries.join(",") + " on conflict do nothing;", []).then((result) => {
      res.status(200).json({});
    }).catch((err) => {
      return fail(res, 500, "polis_err_POST_xidWhitelist", err);
    });
  }


  function getBidsForPids(zid, math_tick, pids) {
    let dataPromise = getBidIndexToPidMapping(zid, math_tick);
    let mathResultsPromise = getPca(zid, math_tick);

    return Promise.all([dataPromise, mathResultsPromise]).then(function(items) {
      let b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
      let mathResults = items[1].asPOJO;


      function findBidForPid(pid) {
        let yourBidi = -1;
        // if (!b2p) {
        //     return yourBidi;
        // }
        for (var bidi = 0; bidi < b2p.length; bidi++) {
          let pids = b2p[bidi];
          if (pids.indexOf(pid) !== -1) {
            yourBidi = bidi;
            break;
          }
        }

        let yourBid = indexToBid[yourBidi];

        if (yourBidi >= 0 && _.isUndefined(yourBid)) {
          console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
          yell("polis_err_math_index_mapping_mismatch");
          yourBid = -1;
        }
        return yourBid;
      }

      let indexToBid = mathResults["base-clusters"].id;
      let bids = pids.map(findBidForPid);
      let pidToBid = _.object(pids, bids);
      return pidToBid;
    });
  }

  // function getClusters(zid, math_tick) {
  //   return getPca(zid, math_tick).then(function(pcaData) {
  //     return pcaData.asPOJO["group-clusters"];
  //   });
  // }


  function handle_GET_bid(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let math_tick = req.p.math_tick;

    let dataPromise = getBidIndexToPidMapping(zid, math_tick);
    let pidPromise = getPidPromise(zid, uid);
    let mathResultsPromise = getPca(zid, math_tick);

    Promise.all([dataPromise, pidPromise, mathResultsPromise]).then(function(items) {
      let b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
      let pid = items[1];
      let mathResults = items[2].asPOJO;


      if (pid < 0) {
        // NOTE: this API should not be called in /demo mode
        fail(res, 500, "polis_err_get_bid_bad_pid");
        return;
      }

      let indexToBid = mathResults["base-clusters"].id;

      let yourBidi = -1;
      for (var bidi = 0; bidi < b2p.length; bidi++) {
        let pids = b2p[bidi];
        if (pids.indexOf(pid) !== -1) {
          yourBidi = bidi;
          break;
        }
      }

      let yourBid = indexToBid[yourBidi];

      if (yourBidi >= 0 && _.isUndefined(yourBid)) {
        console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
        yell("polis_err_math_index_mapping_mismatch");
        yourBid = -1;
      }

      res.json({
        bid: yourBid, // The user's current bid
      });

    }, function(err) {
      res.status(304).end();
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_bid_misc", err);
    });
  }

  function handle_POST_auth_password(req, res) {
    let pwresettoken = req.p.pwresettoken;
    let newPassword = req.p.newPassword;

    getUidForPwResetToken(pwresettoken, function(err, userParams) {
      if (err) {
        console.error(err);
        fail(res, 500, "Password Reset failed. Couldn't find matching pwresettoken.", err);
        return;
      }
      let uid = Number(userParams.uid);
      generateHashedPassword(newPassword, function(err, hashedPassword) {
        return pg.queryP("insert into jianiuevyew (uid, pwhash) values "+
          "($1, $2) on conflict (uid) "+
          "do update set pwhash = excluded.pwhash;", [
            uid,
            hashedPassword,
          ]).then((rows) => {
            res.status(200).json("Password reset successful.");
            clearPwResetToken(pwresettoken, function(err) {
              if (err) {
                yell(err);
                console.error("polis_err_auth_pwresettoken_clear_fail");
              }
            });
          }, (err) => {
            console.error(err);
            fail(res, 500, "Couldn't reset password.", err);
          });
      });
    });
  }


  function getServerNameWithProtocol(req) {
    let serviceUrl = config.get('SERVICE_URL');
	if (serviceUrl) {
	  return serviceUrl;
	}
    let server = "https://pol.is";
    if (devMode) {
      // usually localhost:5000
      server = "http://" + req.headers.host;
    }

    if (req.headers.host.includes("preprod.pol.is")) {
      server = "https://preprod.pol.is";
    }
    if (req.headers.host.includes("embed.pol.is")) {
      server = "https://embed.pol.is";
    }
    if (req.headers.host.includes("survey.pol.is")) {
      server = "https://survey.pol.is";
    }
    return server;
  }

  function handle_POST_auth_slack_redirect_uri(req, res) {
    const code = req.p.code;
    // const state = req.p.state;
    console.log("handle_POST_auth_slack_redirect_uri 1");

    console.log(process.env.POLIS_SLACK_APP_CLIENT_ID);

    request.get("https://slack.com/api/oauth.access?" + querystring.stringify({
      client_id: process.env.POLIS_SLACK_APP_CLIENT_ID,
      client_secret: process.env.POLIS_SLACK_APP_CLIENT_SECRET,
      code: code,
      redirect_uri:  getServerNameWithProtocol(req) + "/api/v3/auth/slack/redirect_uri",
    }))
    // request.post("https://slack.com/api/oauth.access", {
    //   method: "POST",
    //   type: "application/json",
    //   contentType: "application/json; charset=utf-8",
    //   headers: {
    //     // "Authorization": "Basic " + new Buffer(key + ":" + secret, "utf8").toString("base64"),
    //     // "Cache-Control": "max-age=0",
    //   },
    //   json: {
    //     client_id: process.env.POLIS_SLACK_APP_CLIENT_ID,
    //     client_secret: process.env.POLIS_SLACK_APP_CLIENT_SECRET,
    //     code: code,
    //     redirect_uri:  getServerNameWithProtocol(req) + "/api/v3/auth/slack/redirect_uri",
    //   }
    // })
    .then((slack_response) => {
      slack_response = JSON.parse(slack_response);
      if (slack_response && slack_response.ok === false) {
        fail(res, 500, "polis_err_slack_oauth 3", slack_response);
        return;
      }
      console.log("handle_POST_auth_slack_redirect_uri 2");
      console.log(slack_response);
      return pg.queryP("insert into slack_oauth_access_tokens (slack_access_token, slack_scope, slack_auth_response) values ($1, $2, $3);", [
        slack_response.access_token,
        slack_response.scope,
        slack_response,
        // state,
      ]).then(() => {
        res.status(200).send("");
      });
    }).catch((err) => {
      fail(res, 500, "polis_err_slack_oauth", err);
    });
  }


  function handle_POST_auth_pwresettoken(req, res) {
    let email = req.p.email;

    let server = getServerNameWithProtocol(req);

    // let's clear the cookies here, in case something is borked.
    clearCookies(req, res);

    function finish() {
      res.status(200).json("Password reset email sent, please check your email.");
    }

    getUidByEmail(email).then(function(uid) {

      setupPwReset(uid, function(err, pwresettoken) {

        sendPasswordResetEmail(uid, pwresettoken, server, function(err) {
          if (err) {
            console.error(err);
            fail(res, 500, "Error: Couldn't send password reset email.");
            return;
          }
          finish();
        });
      });
    }, function() {
      sendPasswordResetEmailFailure(email, server);
      finish();
    });
  }

  function sendPasswordResetEmailFailure(email, server) {
    let body =
`We were unable to find a pol.is account registered with the email address: ${email}

You may have used another email address to create your account.

If you need to create a new account, you can do that here ${server}/home

Feel free to reply to this email if you need help.`;

    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      "Password Reset Failed",
      body);
  }

  function getUidByEmail(email) {
    email = email.toLowerCase();
    return pg.queryP_readOnly("SELECT uid FROM users where LOWER(email) = ($1);", [email]).then(function(rows) {
      if (!rows || !rows.length) {
        throw new Error("polis_err_no_user_matching_email");
      }
      return rows[0].uid;
    });
  }



  function clearCookie(req, res, cookieName) {
    let origin = req.headers.origin || "";
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      res.clearCookie(cookieName, {
        path: "/",
      });
    } else {
      res.clearCookie(cookieName, {
        path: "/",
        domain: ".pol.is",
      });
      //         res.clearCookie(cookieName, {path: "/", domain: "www.pol.is"});
    }
  }

  function clearCookies(req, res) {
    let origin = req.headers.origin || "";
    let cookieName;
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      for (cookieName in req.cookies) {
        if (COOKIES_TO_CLEAR[cookieName]) {
          res.clearCookie(cookieName, {
            path: "/",
          });
        }
      }
    } else {
      for (cookieName in req.cookies) {
        if (COOKIES_TO_CLEAR[cookieName]) {
          res.clearCookie(cookieName, {
            path: "/",
            domain: ".pol.is",
          });
        }
      }
      // for (cookieName in req.cookies) {
      //     if (COOKIES_TO_CLEAR[cookieName]) {
      //         res.clearCookie(cookieName, {path: "/", domain: "www.pol.is"});
      //     }
      // }
    }
    winston.log("info", "after clear res set-cookie: " + JSON.stringify(res._headers["set-cookie"]));
  }


  function doCookieAuth(assigner, isOptional, req, res, next) {

    let token = req.cookies[COOKIES.TOKEN];

    //if (req.body.uid) { next(401); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
    getUserInfoForSessionToken(token, res, function(err, uid) {

      if (err) {
        clearCookies(req, res); // TODO_MULTI_DATACENTER_CONSIDERATION
        if (isOptional) {
          next();
        } else {
          res.status(403);
          next("polis_err_auth_no_such_token");
        }
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


  function handle_POST_auth_deregister(req, res) {
    req.p = req.p || {};
    let token = req.cookies[COOKIES.TOKEN];

    // clear cookies regardless of auth status
    clearCookies(req, res);

    function finish() {
      if (!req.p.showPage) {
        res.status(200).end();
      } else if (req.p.showPage === "canvas_assignment_deregister") {
        res.set({
          'Content-Type': 'text/html',
        });
        let html =
`<!DOCTYPE html><html lang='en'>
<body>
<h1>You are now signed out of pol.is</h1>
<p>Please return to the 'setup pol.is' assignment to sign in as another user.</p>
</body></html>`;
        res.status(200).send(html);
      }
    }
    if (!token) {
      // nothing to do
      return finish();
    }
    endSession(token, function(err, data) {
      if (err) {
        fail(res, 500, "couldn't end session", err);
        return;
      }
      finish();
    });
  }

  function hashStringToInt32(s) {
    let h = 1;
    if (typeof s !== "string" || !s.length) {
      return 99;
    }
    for (var i = 0; i < s.length; i++) {
      h = h * s.charCodeAt(i) * 31;
    }
    if (h < 0) {
      h = -h;
    }
    // fit in 32 bit signed
    while (h > 2147483648) {
      h = h / 2;
    }
    return h;
  }

  function handle_POST_metrics(req, res) {
    var enabled = false;
    if (!enabled) {
      return res.status(200).json({});
    }

    const pc = req.cookies[COOKIES.PERMANENT_COOKIE];
    const hashedPc = hashStringToInt32(pc);

    const uid = req.p.uid || null;
    const durs = req.p.durs.map(function(dur) {
      if (dur === -1) {
        dur = null;
      }
      return dur;
    });
    const clientTimestamp = req.p.clientTimestamp;
    const ages = req.p.times.map(function(t) {
      return clientTimestamp - t;
    });
    const now = Date.now();
    const timesInTermsOfServerTime = ages.map(function(a) {
      return now - a;
    });
    const len = timesInTermsOfServerTime.length;
    const entries = [];
    for (var i = 0; i < len; i++) {
      entries.push("(" + [
        uid || "null",
        req.p.types[i],
        durs[i],
        hashedPc,
        timesInTermsOfServerTime[i],
      ].join(',') + ")");
    }

    pg.queryP("insert into metrics (uid, type, dur, hashedPc, created) values "+ entries.join(",") +";", []).then(function(result) {
      res.json({});
    }).catch(function(err) {
      fail(res, 500, "polis_err_metrics_post", err);
    });
  }



  function handle_GET_zinvites(req, res) {
    // if uid is not conversation owner, fail
    pgQuery_readOnly('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
      if (err) {
        fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner", err);
        return;
      }
      if (!results || !results.rows) {
        res.writeHead(404);
        res.json({
          status: 404,
        });
        return;
      }
      pgQuery_readOnly('SELECT * FROM zinvites WHERE zid = ($1);', [req.p.zid], function(err, results) {
        if (err) {
          fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something", err);
          return;
        }
        if (!results || !results.rows) {
          res.writeHead(404);
          res.json({
            status: 404,
          });
          return;
        }
        res.status(200).json({
          codes: results.rows, // _.pluck(results.rows[0],"code");
        });
      });
    });
  }

  function generateConversationURLPrefix() {
    // not 1 or 0 since they look like "l" and "O"
    return "" + _.random(2, 9);
  }

  function generateSUZinvites(numTokens) {
    return new Promise(function(resolve, reject) {
      generateToken(
        31 * numTokens,
        true, // For now, pseodorandom bytes are probably ok. Anticipating API call will generate lots of these at once, possibly draining the entropy pool. Revisit this if the otzinvites really need to be unguessable.
        function(err, longStringOfTokens) {
          if (err) {
            reject(new Error("polis_err_creating_otzinvite"));
            return;
          }
          winston.log("info", longStringOfTokens);
          let otzinviteArray = longStringOfTokens.match(/.{1,31}/g);
          otzinviteArray = otzinviteArray.slice(0, numTokens); // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
          otzinviteArray = otzinviteArray.map(function(suzinvite) {
            return generateConversationURLPrefix() + suzinvite;
          });
          winston.log("info", otzinviteArray);
          resolve(otzinviteArray);
        });
    });
  }

  function generateTokenP(len, pseudoRandomOk) {
    return new Promise(function(resolve, reject) {
      generateToken(len, pseudoRandomOk, function(err, token) {
        if (err) {
          reject(err);
        } else {
          resolve(token);
        }
      });
    });
  }

  function generateToken(len, pseudoRandomOk, callback) {
    // TODO store up a buffer of random bytes sampled at random times to reduce predictability. (or see if crypto module does this for us)
    // TODO if you want more readable tokens, see ReadableIds
    let gen;
    if (pseudoRandomOk) {
      gen = crypto.pseudoRandomBytes;
    } else {
      gen = crypto.randomBytes;
    }
    gen(len, function(err, buf) {
      if (err) {
        return callback(err);
      }

      let prettyToken = buf.toString('base64')
        .replace(/\//g, 'A').replace(/\+/g, 'B') // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)
        .replace(/l/g, 'C') // looks like '1'
        .replace(/L/g, 'D') // looks like '1'
        .replace(/o/g, 'E') // looks like 0
        .replace(/O/g, 'F') // looks lke 0
        .replace(/1/g, 'G') // looks like 'l'
        .replace(/0/g, 'H') // looks like 'O'
        .replace(/I/g, 'J') // looks like 'l'
        .replace(/g/g, 'K') // looks like 'g'
        .replace(/G/g, 'M') // looks like 'g'
        .replace(/q/g, 'N') // looks like 'q'
        .replace(/Q/g, 'R') // looks like 'q'
      ;
      // replace first character with a number between 2 and 9 (avoiding 0 and 1 since they look like l and O)
      prettyToken = _.random(2, 9) + prettyToken.slice(1);
      prettyToken = prettyToken.toLowerCase();
      prettyToken = prettyToken.slice(0, len); // in case it's too long

      callback(0, prettyToken);
    });
  }

  // function generateApiKeyForUser(uid, optionalPrefix) {
  //   let parts = ["pkey"];
  //   let len = 32;
  //   if (!_.isUndefined(optionalPrefix)) {
  //     parts.push(optionalPrefix);
  //   }
  //   len -= parts[0].length;
  //   len -= (parts.length - 1); // the underscores
  //   parts.forEach(function(part) {
  //     len -= part.length;
  //   });
  //   return generateTokenP(len, false).then(function(token) {
  //     parts.push(token);
  //     let apikey = parts.join("_");
  //     return apikey;
  //   });
  // }

  // function addApiKeyForUser(uid, optionalPrefix) {
  //   return generateApiKeyForUser(uid, optionalPrefix).then(function(apikey) {
  //     return pg.queryP("insert into apikeysndvweifu (uid, apikey)  VALUES ($1, $2);", [uid, apikey]);
  //   });
  // }


  // function getApiKeysTruncated(uid) {
  //   return pg.queryP_readOnly("select * from apikeysndvweifu WHERE uid = ($1);", [uid]).then(function(rows) {
  //     if (!rows || !rows.length) {
  //       return [];
  //     }
  //     return rows.map(function(row) {
  //       return {
  //         apikeyTruncated: row.apikey.slice(0, 10) + "...",
  //         created: row.created,
  //       };
  //     });
  //   });
  // }

  // function createApiKey(uid) {
  //   return generateTokenP(17, false).then(function(token) {
  //     let apikey = "pkey_" + token;
  //     return pg.queryP("insert into apikeysndvweifu (uid, apikey) values ($1, $2) returning *;", [uid, apikey]).then(function(row) {
  //       return {
  //         apikey: apikey,
  //         created: row.created,
  //       };
  //     });
  //   });
  // }

  // function deleteApiKey(uid, apikeyTruncated) {
  //   // strip trailing "..."
  //   apikeyTruncated = apikeyTruncated.slice(0, apikeyTruncated.indexOf("."));
  //   // basic sanitizing - replace unexpected characters with x's.
  //   apikeyTruncated = apikeyTruncated.replace(/[^a-zA-Z0-9_]/g, 'x');
  //   return pg.queryP("delete from apikeysndvweifu where uid = ($1) and apikey ~ '^" + apikeyTruncated + "';", [uid]);
  // }



  // function addApiKeyForUsersBulk(uids, optionalPrefix) {
  //     let promises = uids.map(function(uid) {
  //         return generateApiKeyForUser(uid, optionalPrefix);
  //     });
  //     return Promise.all(promises).then(function(apikeys) {
  //         let query = "insert into apikeysndvweifu (uid, apikey)  VALUES ";
  //         let pairs = [];
  //         for (var i = 0; i < uids.length; i++) {
  //             let uid = uids[i];
  //             let apikey = apikeys[i];
  //             pairs.push("(" + uid + ', \'' + apikey + '\')');
  //         }
  //         query += pairs.join(',');
  //         query += 'returning uid;';
  //         return pg.queryP(query, []);
  //     });
  // }

  // let uidsX = [];
  // for (var i = 200200; i < 300000; i++) {
  //     uidsX.push(i);
  // }
  // addApiKeyForUsersBulk(uidsX, "test23").then(function(uids) {
  //     console.log("hihihihi", uids.length);
  //     setTimeout(function() { process.exit();}, 3000);
  // });

  // // let time1 = Date.now();
  // createDummyUsersBatch(3 * 1000).then(function(uids) {
  //         // let time2 = Date.now();
  //         // let dt = time2 - time1;
  //         // console.log("time foo" , dt);
  //         // console.dir(uids);
  //         uids.forEach(function(uid) {
  //             console.log("hihihihi", uid);
  //         });
  //         process.exit(0);

  // }).catch(function(err) {
  //     console.error("errorfooooo");
  //     console.error(err);
  // });


  function generateAndRegisterZinvite(zid, generateShort) {
    let len = 10;
    if (generateShort) {
      len = 6;
    }
    return generateTokenP(len, false).then(function(zinvite) {
      return pg.queryP('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite]).then(function(rows) {
        return zinvite;
      });
    });
  }



  function handle_POST_zinvites(req, res) {
    let generateShortUrl = req.p.short_url;

    pg.queryP('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
      if (err) {
        fail(res, 500, "polis_err_creating_zinvite_invalid_conversation_or_owner", err);
        return;
      }

      generateAndRegisterZinvite(req.p.zid, generateShortUrl).then(function(zinvite) {
        res.status(200).json({
          zinvite: zinvite,
        });
      }).catch(function(err) {
        fail(res, 500, "polis_err_creating_zinvite", err);
      });
    });
  }

  function checkZinviteCodeValidity(zid, zinvite, callback) {
    pgQuery_readOnly('SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);', [zid, zinvite], function(err, results) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    });
  }

  let zidToConversationIdCache = new LruCache({
    max: 1000,
  });

  function getZinvite(zid, dontUseCache) {
    let cachedConversationId = zidToConversationIdCache.get(zid);
    if (!dontUseCache && cachedConversationId) {
      return Promise.resolve(cachedConversationId);
    }
    return pg.queryP_metered("getZinvite", "select * from zinvites where zid = ($1);", [zid]).then(function(rows) {
      let conversation_id = rows && rows[0] && rows[0].zinvite || void 0;
      if (conversation_id) {
        zidToConversationIdCache.set(zid, conversation_id);
      }
      return conversation_id;
    });
  }

  function getZinvites(zids) {
    if (!zids.length) {
      return Promise.resolve(zids);
    }
    zids = _.map(zids, function(zid) {
      return Number(zid); // just in case
    });
    zids = _.uniq(zids);

    let uncachedZids = zids.filter(function(zid) {
      return !zidToConversationIdCache.get(zid);
    });
    let zidsWithCachedConversationIds = zids.filter(function(zid) {
      return !!zidToConversationIdCache.get(zid);
    }).map(function(zid) {
      return {
        zid: zid,
        zinvite: zidToConversationIdCache.get(zid),
      };
    });

    function makeZidToConversationIdMap(arrays) {
      let zid2conversation_id = {};
      arrays.forEach(function(a) {
        a.forEach(function(o) {
          zid2conversation_id[o.zid] = o.zinvite;
        });
      });
      return zid2conversation_id;
    }

    return new MPromise("getZinvites", function(resolve, reject) {
      if (uncachedZids.length === 0) {
        resolve(makeZidToConversationIdMap([zidsWithCachedConversationIds]));
        return;
      }
      pgQuery_readOnly("select * from zinvites where zid in (" + uncachedZids.join(",") + ");", [], function(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(makeZidToConversationIdMap([result.rows, zidsWithCachedConversationIds]));
        }
      });
    });
  }

  function addConversationId(o, dontUseCache) {
    if (!o.zid) {
      // if no zid, resolve without fetching zinvite.
      return Promise.resolve(o);
    }
    return getZinvite(o.zid, dontUseCache).then(function(conversation_id) {
      o.conversation_id = conversation_id;
      return o;
    });
  }

  function addConversationIds(a) {
    let zids = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i].zid) {
        zids.push(a[i].zid);
      }
    }
    if (!zids.length) {
      return Promise.resolve(a);
    }
    return getZinvites(zids).then(function(zid2conversation_id) {
      return a.map(function(o) {
        o.conversation_id = zid2conversation_id[o.zid];
        return o;
      });
    });
  }

  function finishOne(res, o, dontUseCache, altStatusCode) {
    addConversationId(o, dontUseCache).then(function(item) {
      // ensure we don't expose zid
      if (item.zid) {
        delete item.zid;
      }
      let statusCode = altStatusCode || 200;
      res.status(statusCode).json(item);
    }, function(err) {
      fail(res, 500, "polis_err_finishing_responseA", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_finishing_response", err);
    });
  }

  function finishArray(res, a) {
    addConversationIds(a).then(function(items) {
      // ensure we don't expose zid
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].zid) {
            delete items[i].zid;
          }
        }
      }
      res.status(200).json(items);
    }, function(err) {
      fail(res, 500, "polis_err_finishing_response2A", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_finishing_response2", err);
    });
  }

  function checkSuzinviteCodeValidity(zid, suzinvite, callback) {
    pg.queryP('SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);', [zid, suzinvite], function(err, results) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    });
  }

  function getSUZinviteInfo(suzinvite) {
    return new Promise(function(resolve, reject) {
      pg.queryP('SELECT * FROM suzinvites WHERE suzinvite = ($1);', [suzinvite], function(err, results) {
        if (err) {
          return reject(err);
        }
        if (!results || !results.rows || !results.rows.length) {
          return reject(new Error("polis_err_no_matching_suzinvite"));
        }
        resolve(results.rows[0]);
      });
    });
  }

  function deleteSuzinvite(suzinvite) {
    return new Promise(function(resolve, reject) {
      pg.queryP("DELETE FROM suzinvites WHERE suzinvite = ($1);", [suzinvite], function(err, results) {
        if (err) {
          // resolve, but complain
          yell("polis_err_removing_suzinvite");
        }
        resolve();
      });
    });
  }

  function xidExists(xid, owner, uid) {
    return pg.queryP("select * from xids where xid = ($1) and owner = ($2) and uid = ($3);", [xid, owner, uid]).then(function(rows) {
      return rows && rows.length;
    });
  }

  function createXidEntry(xid, owner, uid) {
    return new Promise(function(resolve, reject) {
      pg.queryP("INSERT INTO xids (uid, owner, xid) VALUES ($1, $2, $3);", [uid, owner, xid], function(err, results) {
        if (err) {
          console.error(err);
          reject(new Error("polis_err_adding_xid_entry"));
          return;
        }
        resolve();
      });
    });
  }

  function saveParticipantMetadataChoicesP(zid, pid, answers) {
    return new Promise(function(resolve, reject) {
      saveParticipantMetadataChoices(zid, pid, answers, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(0);
        }
      });
    });
  }

  function saveParticipantMetadataChoices(zid, pid, answers, callback) {
    // answers is a list of pmaid
    if (!answers || !answers.length) {
      // nothing to save
      return callback(0);
    }

    let q = "select * from participant_metadata_answers where zid = ($1) and pmaid in (" +
      answers.join(",") +
      ");";

    pg.queryP(q, [zid], function(err, qa_results) {
      if (err) {
        winston.log("info", "adsfasdfasd");
        return callback(err);
      }

      qa_results = qa_results.rows;
      qa_results = _.indexBy(qa_results, "pmaid");
      // construct an array of params arrays
      answers = answers.map(function(pmaid) {
        let pmqid = qa_results[pmaid].pmqid;
        return [zid, pid, pmaid, pmqid];
      });
      // make simultaneous requests to insert the choices
      async.map(
        answers,
        function(x, cb) {
          // ...insert()
          //     .into("participant_metadata_choices")
          //     .
          pg.queryP(
            "INSERT INTO participant_metadata_choices (zid, pid, pmaid, pmqid) VALUES ($1,$2,$3,$4);",
            x,
            function(err, results) {
              if (err) {
                winston.log("info", "sdkfuhsdu");
                return cb(err);
              }
              cb(0);
            }
          );
        },
        function(err) {
          if (err) {
            winston.log("info", "ifudshf78ds");
            return callback(err);
          }
          // finished with all the inserts
          callback(0);
        }
      );
    });
  }

  function createParticpantLocationRecord(
    zid, uid, pid, lat, lng, source) {
    return pg.queryP("insert into participant_locations (zid, uid, pid, lat, lng, source) values ($1,$2,$3,$4,$5,$6);", [
      zid,
      uid,
      pid,
      lat,
      lng,
      source,
    ]);
  }

  let LOCATION_SOURCES = {
    Twitter: 400,
    Facebook: 300,
    HTML5: 200,
    IP: 100,
    manual_entry: 1,
  };

  function getUsersLocationName(uid) {
    return Promise.all([
      pg.queryP_readOnly("select * from facebook_users where uid = ($1);", [uid]),
      pg.queryP_readOnly("select * from twitter_users where uid = ($1);", [uid]),
    ]).then(function(o) {
      let fb = o[0] && o[0][0];
      let tw = o[1] && o[1][0];
      if (fb && _.isString(fb.location)) {
        return {
          location: fb.location,
          source: LOCATION_SOURCES.Facebook,
        };
      } else if (tw && _.isString(tw.location)) {
        return {
          location: tw.location,
          source: LOCATION_SOURCES.Twitter,
        };
      }
      return null;
    });
  }

  function populateParticipantLocationRecordIfPossible(zid, uid, pid) {
    INFO("asdf1", zid, uid, pid);
    getUsersLocationName(uid).then(function(locationData) {
      if (!locationData) {
        INFO("asdf1.nope");
        return;
      }
      INFO(locationData);
      geoCode(locationData.location).then(function(o) {
        createParticpantLocationRecord(zid, uid, pid, o.lat, o.lng, locationData.source).catch(function(err) {
          if (!isDuplicateKey(err)) {
            yell("polis_err_creating_particpant_location_record");
            console.error(err);
          }
        });
      }).catch(function(err) {
        yell("polis_err_geocoding_01");
        console.error(err);
      });
    }).catch(function(err) {
      yell("polis_err_fetching_user_location_name");
      console.error(err);
    });
  }

  function updateLastInteractionTimeForConversation(zid, uid) {
    return pg.queryP("update participants set last_interaction = now_as_millis(), nsli = 0 where zid = ($1) and uid = ($2);", [zid, uid]);
  }


  function populateGeoIpInfo(zid, uid, ipAddress) {
    var userId = process.env.MAXMIND_USERID;
    var licenseKey = process.env.MAXMIND_LICENSEKEY;

    var url = "https://geoip.maxmind.com/geoip/v2.1/city/";
    var contentType = "application/vnd.maxmind.com-city+json; charset=UTF-8; version=2.1";

    // "city" is     $0.0004 per query
    // "insights" is $0.002  per query
    var insights = false;

    if (insights) {
      url = "https://geoip.maxmind.com/geoip/v2.1/insights/";
      contentType = "application/vnd.maxmind.com-insights+json; charset=UTF-8; version=2.1";
    }


    return request.get(url + ipAddress, {
      method: "GET",
      contentType: contentType,
      headers: {
        "Authorization": "Basic " + new Buffer(userId + ":" + licenseKey, "utf8").toString("base64"),
      },
    }).then(function(response) {
      var parsedResponse = JSON.parse(response);
      console.log('BEGIN MAXMIND RESPONSE');
      console.log(response);
      console.log('END MAXMIND RESPONSE');

      return pg.queryP("update participants_extended set modified=now_as_millis(), country_iso_code=($4), encrypted_maxmind_response_city=($3), "+
        "location=ST_GeographyFromText('SRID=4326;POINT("+
        parsedResponse.location.latitude+" "+ parsedResponse.location.longitude+")'), latitude=($5), longitude=($6) where zid = ($1) and uid = ($2);",[
          zid,
          uid,
          encrypt(response),
          parsedResponse.country.iso_code,
          parsedResponse.location.latitude,
          parsedResponse.location.longitude,
        ]);

    });
  }



  function addExtendedParticipantInfo(zid, uid, data) {
    if (!data || !_.keys(data).length) {
      return Promise.resolve();
    }

    let params = Object.assign({}, data, {
      zid: zid,
      uid: uid,
      modified: 9876543212345, // hacky string, will be replaced with the word "default".
    });
    let qUpdate = sql_participants_extended.update(params)
      .where(sql_participants_extended.zid.equals(zid))
      .and(sql_participants_extended.uid.equals(uid));
    let qString = qUpdate.toString();
    qString = qString.replace("9876543212345", "now_as_millis()");
    return pg.queryP(qString, []);
  }

  function tryToJoinConversation(zid, uid, info, pmaid_answers) {
    console.log("tryToJoinConversation");
    console.dir(arguments);

    function doAddExtendedParticipantInfo() {
      if (info && _.keys(info).length > 0) {
        addExtendedParticipantInfo(zid, uid, info);
      }
    }

    function saveMetadataChoices(pid) {
      if (pmaid_answers && pmaid_answers.length) {
        saveParticipantMetadataChoicesP(zid, pid, pmaid_answers);
      }
    }

    // there was no participant row, so create one
    return addParticipant(zid, uid).then(function(rows) {
      let pid = rows && rows[0] && rows[0].pid;
      let ptpt = rows[0];

      doAddExtendedParticipantInfo();

      if (pmaid_answers && pmaid_answers.length) {
        saveMetadataChoices();
      }
      populateParticipantLocationRecordIfPossible(zid, uid, pid);
      return ptpt;
    });
  }

  function addParticipantAndMetadata(zid, uid, req, permanent_cookie) {
    let info = {};
    let parent_url = req.cookies[COOKIES.PARENT_URL] || req.p.parent_url;
    let referer = req.cookies[COOKIES.PARENT_REFERRER] || req.headers["referer"] || req.headers["referrer"];
    if (parent_url) {
      info.parent_url = parent_url;
    }
    console.log('mike foo');
    if (referer) {
      info.referrer = referer;
    }
    let x_forwarded_for = req.headers["x-forwarded-for"];
    let ip = null;
    if (x_forwarded_for) {
      let ips = x_forwarded_for;
      ips = ips && ips.split(", ");
      ip = ips.length && ips[0];
      info.encrypted_ip_address = encrypt(ip);
      info.encrypted_x_forwarded_for = encrypt(x_forwarded_for);
      console.log('mike encrypt');
    }
    if (permanent_cookie) {
      info.permanent_cookie = permanent_cookie;
    }
    if (req.headers["origin"]) {
      info.origin = req.headers["origin"];
    }
    return addParticipant(zid, uid).then((rows) => {
      let ptpt = rows[0];
      let pid = ptpt.pid;
      populateParticipantLocationRecordIfPossible(zid, uid, pid);
      addExtendedParticipantInfo(zid, uid, info);
      if (ip) {
        populateGeoIpInfo(zid, uid, ip);
      }
      return rows;
    });
  }

  function joinConversation(zid, uid, info, pmaid_answers) {
    function tryJoin() {
      return tryToJoinConversation(zid, uid, info, pmaid_answers);
    }

    function doJoin() {
      // retry up to 10 times
      // NOTE: Shouldn't be needed, since we have an advisory lock in the insert trigger.
      //       However, that doesn't seem to be preventing duplicate pid constraint errors.
      //       Doing this retry in JS for now since it's quick and easy, rather than try to
      //       figure what's wrong with the postgres locks.
      let promise = tryJoin()
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin)
        .catch(tryJoin);
      return promise;
    }

    return getPidPromise(zid, uid).then(function(pid) {
      if (pid >= 0) {
        // already a ptpt, so don't create another
        return;
      } else {
        return doJoin();
      }
    }, doJoin);
  }

  function isOwnerOrParticipant(zid, uid, callback) {
    // TODO should be parallel.
    // look into bluebird, use 'some' https://github.com/petkaantonov/bluebird
    getPid(zid, uid, function(err, pid) {
      if (err || pid < 0) {
        isConversationOwner(zid, uid, function(err) {
          callback(err);
        });
      } else {
        callback(null);
      }
    });
  }

  function isConversationOwner(zid, uid, callback) {
    // if (true) {
    //     callback(null); // TODO remove!
    //     return;
    // }
    pgQuery_readOnly("SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);", [zid, uid], function(err, docs) {
      if (!docs || !docs.rows || docs.rows.length === 0) {
        err = err || 1;
      }
      callback(err);
    });
  }

  function isOwner(zid, uid) {
    return getConversationInfo(zid).then(function(info) {
      winston.log("info", 39847534987 + " isOwner " + uid);
      winston.log("info", info);
      winston.log("info", info.owner === uid);
      return info.owner === uid;
    });
  }

  function isModerator(zid, uid) {
    if (isPolisDev(uid)) {
      return Promise.resolve(true);
    }
    return pg.queryP_readOnly("select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1);", [zid, uid]).then(function(rows) {
      return rows[0].count >= 1;
    });
  }

  // returns null if it's missing
  function getParticipant(zid, uid) {
    return new MPromise("getParticipant", function(resolve, reject) {
      pgQuery_readOnly("SELECT * FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, results) {
        if (err) {
          return reject(err);
        }
        if (!results || !results.rows) {
          return reject(new Error("polis_err_getParticipant_failed"));
        }
        resolve(results.rows[0]);
      });
    });
  }


  function getAnswersForConversation(zid, callback) {
    pgQuery_readOnly("SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;", [zid], function(err, x) {
      if (err) {
        callback(err);
        return;
      }
      callback(0, x.rows);
    });
  }

  function getChoicesForConversation(zid) {
    return new Promise(function(resolve, reject) {
      pgQuery_readOnly("select * from participant_metadata_choices where zid = ($1) and alive = TRUE;", [zid], function(err, x) {
        if (err) {
          reject(err);
          return;
        }
        if (!x || !x.rows) {
          resolve([]);
          return;
        }
        resolve(x.rows);
      });
    });
  }


  function getUserInfoForUid(uid, callback) {
    pgQuery_readOnly("SELECT email, hname from users where uid = $1", [uid], function(err, results) {
      if (err) {
        return callback(err);
      }
      if (!results.rows || !results.rows.length) {
        return callback(null);
      }
      callback(null, results.rows[0]);
    });
  }

  function getUserInfoForUid2(uid) {
    return new MPromise("getUserInfoForUid2", function(resolve, reject) {
      pgQuery_readOnly("SELECT * from users where uid = $1", [uid], function(err, results) {
        if (err) {
          return reject(err);
        }
        if (!results.rows || !results.rows.length) {
          return reject(null);
        }
        let o = results.rows[0];
        resolve(o);
      });
    });
  }



  function emailFeatureRequest(message) {
    const body =
`Somebody clicked a dummy button!

${message}`;

    return sendMultipleTextEmails(
      POLIS_FROM_ADDRESS, admin_emails,
      "Dummy button clicked!!!",
      body)
    .catch(function(err) {
      yell("polis_err_failed_to_email_for_dummy_button");
      yell(message);
    });
  }

  function emailTeam(subject, body) {
    return sendMultipleTextEmails(
      POLIS_FROM_ADDRESS, admin_emails,
      subject,
      body).catch(function(err) {
        yell("polis_err_failed_to_email_team");
        yell(message);
      });
  }

  function emailBadProblemTime(message) {
    const body =
`Yo, there was a serious problem. Here's the message:

${message}`;

    return emailTeam("Polis Bad Problems!!!", body);
  }


  function sendPasswordResetEmail(uid, pwresettoken, serverName, callback) {
    getUserInfoForUid(uid, function(err, userInfo) {
      if (err) {
        return callback(err);
      }
      if (!userInfo) {
        return callback('missing user info');
      }
      let body =

`Hi ${userInfo.hname},

We have just received a password reset request for ${userInfo.email}

To reset your password, visit this page:
${serverName}/pwreset/${pwresettoken}

"Thank you for using Polis`;

      sendTextEmail(
        POLIS_FROM_ADDRESS,
        userInfo.email,
        "Polis Password Reset",
        body).then(function() {
          callback();
        }).catch(function(err) {
          yell("polis_err_failed_to_email_password_reset_code");
          callback(err);
        });
    });
  }




  // function sendTextEmailWithPostmark(sender, recipient, subject, text) {
  //   winston.log("info", "sending email with postmark: " + [sender, recipient, subject, text].join(" "));
  //   return new Promise(function(resolve, reject) {
  //     postmark.send({
  //       "From": sender,
  //       "To": recipient,
  //       "Subject": subject,
  //       "TextBody": text,
  //     }, function(error, success) {
  //       if (error) {
  //         console.error("Unable to send email via postmark to " + recipient + " " + error.message);
  //         yell("polis_err_postmark_email_send_failed");
  //         reject(error);
  //       } else {
  //         winston.log("info", "sent email with postmark to " + recipient);
  //         resolve();
  //       }
  //     });
  //   });
  // }


  function sendMultipleTextEmails(sender, recipientArray, subject, text) {
    recipientArray = recipientArray || [];
    return Promise.all(recipientArray.map(function(email) {
      let promise = sendTextEmail(
        sender,
        email,
        subject,
        text);
      promise.catch(function(err) {
        yell("polis_err_failed_to_email_for_user " + email);
      });
      return promise;
    }));
  }

  function sendEinviteEmail(req, email, einvite) {
    let serverName = getServerNameWithProtocol(req);
    const body = i18n.__('WelcomeToPolis', serverName, einvite);
    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      i18n.__("Get Started with Polis"),
      body);
  }

  function sendVerificaionEmail(req, email, einvite) {
    let serverName = getServerNameWithProtocol(req);
    let body = i18n.__("PolisVerification", serverName, einvite);
    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      i18n.__("Polis verification"),
      body);
  }

  function isEmailVerified(email) {
    return pg.queryP("select * from email_validations where email = ($1);", [email]).then(function(rows) {
      return rows.length > 0;
    });
  }

  function handle_GET_verification(req, res) {
    let einvite = req.p.e;
    pg.queryP("select * from einvites where einvite = ($1);", [einvite]).then(function(rows) {
      if (!rows.length) {
        fail(res, 500, "polis_err_verification_missing");
      }
      let email = rows[0].email;
      return pg.queryP("select email from email_validations where email = ($1);", [email]).then(function(rows) {
        if (rows && rows.length > 0) {
          return true;
        }
        return pg.queryP("insert into email_validations (email) values ($1);", [email]);
      });
    }).then(function() {
      res.set('Content-Type', 'text/html');
      res.send(
`<html><body>
<div style='font-family: Futura, Helvetica, sans-serif;'>
Email verified! You can close this tab or hit the back button.
</div>
</body></html>`);
    }).catch(function(err) {
      fail(res, 500, "polis_err_verification", err);
    });
  }

  function paramsToStringSortedByName(params) {
    let pairs = _.pairs(params).sort(function(a, b) {
      return a[0] > b[0];
    });
    pairs = pairs.map(function(pair) {
      return pair.join("=");
    });
    return pairs.join("&");
  }

  // // units are seconds
  // let expirationPolicies = {
  //     pwreset_created : 60 * 60 * 2,
  // };

  let HMAC_SIGNATURE_PARAM_NAME = "signature";

  function createHmacForQueryParams(path, params) {
    path = path.replace(/\/$/, ""); // trim trailing "/"
    let s = path + "?" + paramsToStringSortedByName(params);
    let hmac = crypto.createHmac("sha1", "G7f387ylIll8yuskuf2373rNBmcxqWYFfHhdsd78f3uekfs77EOLR8wofw");
    hmac.setEncoding('hex');
    hmac.write(s);
    hmac.end();
    let hash = hmac.read();
    return hash;
  }

  function verifyHmacForQueryParams(path, params) {
    return new Promise(function(resolve, reject) {
      params = _.clone(params);
      let hash = params[HMAC_SIGNATURE_PARAM_NAME];
      delete params[HMAC_SIGNATURE_PARAM_NAME];
      let correctHash = createHmacForQueryParams(path, params);
      // To thwart timing attacks, add some randomness to the response time with setTimeout.
      setTimeout(function() {
        winston.log("info", "comparing", correctHash, hash);
        if (correctHash === hash) {
          resolve();
        } else {
          reject();
        }
      });
    });
  }

  function sendEmailByUid(uid, subject, body) {
    return getUserInfoForUid2(uid).then(function(userInfo) {
      return sendTextEmail(
        POLIS_FROM_ADDRESS,
        userInfo.hname ? (`${userInfo.hname} <${userInfo.email}>`) : userInfo.email,
        subject,
        body);
    });
  }



  function handle_GET_participants(req, res) {
    // let pid = req.p.pid;
    let uid = req.p.uid;
    let zid = req.p.zid;

    pg.queryP_readOnly("select * from participants where uid = ($1) and zid = ($2)", [uid, zid]).then(function(rows) {
      let ptpt = rows && rows.length && rows[0] || null;
      res.status(200).json(ptpt);
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_participant", err);
    });

    // function fetchOne() {
    //     pg.queryP("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
    //         if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
    //         let ptpt = result.rows[0];
    //         let data = {};
    //         // choose which fields to expose
    //         data.hname = ptpt.hname;

    //         res.status(200).json(data);
    //     });
    // }
    // function fetchAll() {
    //     // NOTE: it's important to return these in order by pid, since the array index indicates the pid.
    //     pg.queryP("SELECT users.hname, users.email, participants.pid FROM users INNER JOIN participants ON users.uid = participants.uid WHERE zid = ($1) ORDER BY participants.pid;", [zid], function(err, result) {
    //         if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
    //         res.json(result.rows);
    //     });
    // }
    // pg.queryP("SELECT is_anon FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
    //     if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
    //     if (result.rows[0].is_anon) {
    //         fail(res, 403, "polis_err_fetching_participant_info_conversation_is_anon");
    //         return;
    //     }
    //     // if (pid !== undefined) {
    //         fetchOne();
    //     // } else {
    //         // fetchAll();
    //     // }

    // });
  }


  function handle_GET_dummyButton(req, res) {
    let message = req.p.button + " " + req.p.uid;
    emailFeatureRequest(message);
    res.status(200).end();
  }


  function doGetConversationsRecent(req, res, field) {
    if (!isPolisDev(req.p.uid)) {
      fail(res, 403, "polis_err_no_access_for_this_user");
      return;
    }
    var time = req.p.sinceUnixTimestamp;
    if (_.isUndefined(time)) {
      time = Date.now() - 1000*60*60*24*7;
    } else {
      time *= 1000;
    }
    time = parseInt(time);
    pg.queryP_readOnly("select * from conversations where "+field+" >= ($1);", [time]).then((rows) => {
      res.json(rows);
    }).catch((err) => {
      fail(res, 403, "polis_err_conversationsRecent", err);
    });
  }

  function handle_GET_conversationsRecentlyStarted(req, res) {
    doGetConversationsRecent(req, res, "created");
  }

  function handle_GET_conversationsRecentActivity(req, res) {
    doGetConversationsRecent(req, res, "modified");
  }



  function userHasAnsweredZeQuestions(zid, answers) {
    return new MPromise("userHasAnsweredZeQuestions", function(resolve, reject) {
      getAnswersForConversation(zid, function(err, available_answers) {
        if (err) {
          reject(err);
          return;
        }

        let q2a = _.indexBy(available_answers, 'pmqid');
        let a2q = _.indexBy(available_answers, 'pmaid');
        for (var i = 0; i < answers.length; i++) {
          let pmqid = a2q[answers[i]].pmqid;
          delete q2a[pmqid];
        }
        let remainingKeys = _.keys(q2a);
        let missing = remainingKeys && remainingKeys.length > 0;
        if (missing) {
          return reject(new Error('polis_err_metadata_not_chosen_pmqid_' + remainingKeys[0]));
        } else {
          return resolve();
        }
      });
    });
  }

  function handle_POST_participants(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let answers = req.p.answers;
    let info = {};

    let parent_url = req.cookies[COOKIES.PARENT_URL] || req.p.parent_url;
    let referrer = req.cookies[COOKIES.PARENT_REFERRER] || req.p.referrer;

    if (parent_url) {
      info.parent_url = parent_url;
    }
    if (referrer) {
      info.referrer = referrer;
    }

    function finish(ptpt) {
      // Probably don't need pid cookies..?
      // function getZidToPidCookieKey(zid) {
      //     return zid + "p";
      // }
      // addCookie(res, getZidToPidCookieKey(zid), pid);

      clearCookie(req, res, COOKIES.PARENT_URL);
      clearCookie(req, res, COOKIES.PARENT_REFERRER);

      setTimeout(function() {
        updateLastInteractionTimeForConversation(zid, uid);
      }, 0);
      res.status(200).json(ptpt);
    }

    function doJoin() {



      userHasAnsweredZeQuestions(zid, answers).then(function() {
        joinConversation(zid, uid, info, answers).then(function(ptpt) {
          finish(ptpt);
        }, function(err) {
          fail(res, 500, "polis_err_add_participant", err);
        });
      }, function(err) {
        userFail(res, 400, err.message, err);
      });
    }

    // Check if already in the conversation
    getParticipant(zid, req.p.uid).then(function(ptpt) {
      if (ptpt) {
        finish(ptpt);

        // populate their location if needed - no need to wait on this.
        populateParticipantLocationRecordIfPossible(zid, req.p.uid, ptpt.pid);
        addExtendedParticipantInfo(zid, req.p.uid, info);
        return;
      }

      getConversationInfo(zid).then(function(conv) {
        if (conv.lti_users_only) {
          if (uid) {
            pg.queryP("select * from lti_users where uid = ($1)", [uid]).then(function(rows) {
              if (rows && rows.length) {
                // found a record in lti_users
                doJoin();
              } else {
                userFail(res, 403, "polis_err_post_participants_missing_lti_user_for_uid_1");
              }
            }).catch(function(err) {
              fail(res, 500, "polis_err_post_participants_missing_lti_user_for_uid_2", err);
            });
          } else {
            userFail(res, 403, "polis_err_post_participants_need_uid_to_check_lti_users_3");
          }
        } else {
          // no LTI stuff to worry about
          doJoin();
        }
      }).catch(function(err) {
        fail(res, 500, "polis_err_post_participants_need_uid_to_check_lti_users_4", err);
      });
    }, function(err) {
      fail(res, 500, "polis_err_post_participants_db_err", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_post_participants_misc", err);
    });
  }

  function addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) {
    lti_user_image = lti_user_image || null;
    return pg.queryP("select * from lti_users where lti_user_id = ($1) and tool_consumer_instance_guid = ($2);", [lti_user_id, tool_consumer_instance_guid]).then(function(rows) {
      if (!rows || !rows.length) {
        return pg.queryP("insert into lti_users (uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) values ($1, $2, $3, $4);", [uid, lti_user_id, tool_consumer_instance_guid, lti_user_image]);
      }
    });
  }

  function addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) {
    return pg.queryP("select * from lti_context_memberships where uid = $1 and lti_context_id = $2 and tool_consumer_instance_guid = $3;", [uid, lti_context_id, tool_consumer_instance_guid]).then(function(rows) {
      if (!rows || !rows.length) {
        return pg.queryP("insert into lti_context_memberships (uid, lti_context_id, tool_consumer_instance_guid) values ($1, $2, $3);", [uid, lti_context_id, tool_consumer_instance_guid]);
      }
    });
  }

  function checkPassword(uid, password) {
    return pg.queryP_readOnly_wRetryIfEmpty("select pwhash from jianiuevyew where uid = ($1);", [uid]).then(function(rows) {
      if (!rows || !rows.length) {
        return null;
      } else if (!rows[0].pwhash) {
        return void 0;
      }
      let hashedPassword = rows[0].pwhash;
      return new Promise(function(resolve, reject) {
        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
          if (errCompare) {
            reject(errCompare);
          } else {
            resolve(result ? "ok" : 0);
          }
        });
      });
    });
  }

  function subscribeToNotifications(zid, uid, email) {
    let type = 1; // 1 for email
    winston.log("info", "subscribeToNotifications", zid, uid);
    return pg.queryP("update participants_extended set subscribe_email = ($3) where zid = ($1) and uid = ($2);", [zid, uid, email]).then(function() {
      return pg.queryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
        return type;
      });
    });
  }

  function unsubscribeFromNotifications(zid, uid) {
    let type = 0; // 1 for nothing
    return pg.queryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
      return type;
    });
  }

  function addNotificationTask(zid) {
    return pg.queryP("insert into notification_tasks (zid) values ($1) on conflict (zid) do update set modified = now_as_millis();", [zid]);
  }

  function maybeAddNotificationTask(zid, timeInMillis) {
    return pg.queryP("insert into notification_tasks (zid, modified) values ($1, $2) on conflict (zid) do nothing;", [zid, timeInMillis]);
  }

  function claimNextNotificationTask() {
    return pg.queryP("delete from notification_tasks where zid = (select zid from notification_tasks order by random() for update skip locked limit 1) returning *;").then((rows) => {
      if (!rows || !rows.length) {
        return null;
      }
      return rows[0];
    });
  }

  function getDbTime() {
    return pg.queryP("select now_as_millis();",[]).then((rows) => {
      return rows[0].now_as_millis;
    });
  }

  function doNotificationsForZid(zid, timeOfLastEvent) {

    let shouldTryAgain = false;

    return pg.queryP("select * from participants where zid = ($1) and last_notified < ($2) and subscribed > 0;", [zid, timeOfLastEvent]).then((candidates) => {
      if (!candidates || !candidates.length) {
        return null;
      }
      candidates = candidates.map((ptpt) => {
        ptpt.last_notified = Number(ptpt.last_notified);
        ptpt.last_interaction = Number(ptpt.last_interaction);
        return ptpt;
      });
      return Promise.all([
        getDbTime(),
        getConversationInfo(zid),
        getZinvite(zid),
      ]).then((a) => {
        let dbTimeMillis = a[0];
        let conv = a[1];
        let conversation_id = a[2];

        let url = conv.parent_url || "https://pol.is/" + conversation_id;

        let pid_to_ptpt = {};
        candidates.forEach((c) => {
          pid_to_ptpt[c.pid] = c;
        });
        return Promise.mapSeries(candidates, (item, index, length) => {
          return getNumberOfCommentsRemaining(item.zid, item.pid).then((rows) => {
            return rows[0];
          });
        }).then((results) => {
          const needNotification = results.filter((result) => {
            let ptpt = pid_to_ptpt[result.pid];
            let needs = true;

            needs = needs && result.remaining > 0;

            // if (needs && result.remaining < 5) {
            //   // no need to try again for this user since new comments will create new tasks
            //   console.log('doNotificationsForZid', 'not enough remaining');
            //   needs = false;
            // }

            let waitTime = 60*60*1000;

            // notifications since last interation
            if (ptpt.nsli === 0) {
              // first notification since last interaction
              waitTime = 60*60*1000; // 1 hour
            } else if (ptpt.nsli === 1) {
              // second notification since last interaction
              waitTime = 2*60*60*1000; // 4 hours
            } else if (ptpt.nsli === 2) {
              // third notification since last interaction
              waitTime = 24*60*60*1000; // 24 hours
            } else if (ptpt.nsli === 3) {
              // third notification since last interaction
              waitTime = 48*60*60*1000; // 48 hours
            } else {
              // give up, if they vote again nsli will be set to zero again.
              console.log('doNotificationsForZid', 'nsli');
              needs = false;
            }

            if (needs && dbTimeMillis < ptpt.last_notified + waitTime) { // Limit to one per hour.
              console.log('doNotificationsForZid', 'shouldTryAgain', 'last_notified');
              shouldTryAgain = true;
              needs = false;
            }
            if (needs && dbTimeMillis < ptpt.last_interaction + 5*60*1000) { // Wait until 5 minutes after their last interaction.
              console.log('doNotificationsForZid', 'shouldTryAgain', 'last_interaction');
              shouldTryAgain = true;
              needs = false;
            }

            if (devMode) {
              needs = needs && isPolisDev(ptpt.uid);
            }
            return needs;
          });

          if (needNotification.length === 0) {
            return null;
          }
          const pids = _.pluck(needNotification, "pid");

          // return pg.queryP("select p.uid, p.pid, u.email from participants as p left join users as u on p.uid = u.uid where p.pid in (" + pids.join(",") + ")", []).then((rows) => {

          // })
          return pg.queryP("select uid, subscribe_email from participants_extended where uid in (select uid from participants where pid in (" + pids.join(",") + "));", []).then((rows) => {
            let uidToEmail = {};
            rows.forEach((row) => {
              uidToEmail[row.uid] = row.subscribe_email;
            });

            return Promise.each(needNotification, (item, index, length) => {
              const uid = pid_to_ptpt[item.pid].uid;
              return sendNotificationEmail(uid, url, conversation_id, uidToEmail[uid], item.remaining).then(() => {
                return pg.queryP("update participants set last_notified = now_as_millis(), nsli = nsli + 1 where uid = ($1) and zid = ($2);", [uid, zid]);
              });
            });
          });
        });
      });
    }).then(() => {
      return shouldTryAgain;
    });
  }

  function doNotificationBatch() {
    return claimNextNotificationTask().then((task) => {
      if (!task) {
        return Promise.resolve();
      }
      console.log('doNotificationsForZid', task.zid);
      return doNotificationsForZid(task.zid, task.modified).then((shouldTryAgain) => {
        console.log('doNotificationsForZid', task.zid, "shouldTryAgain", shouldTryAgain);
        if (shouldTryAgain) {
          // Since we claimed the task above, there will be no record, so we need to
          // put it back to trigger a retry - unless there's a new one there, in which case we should
          // leave the new one.
          maybeAddNotificationTask(task.zid, task.modified);
        }
      });
    });
  }

  function doNotificationLoop() {
    console.log('doNotificationLoop');
    doNotificationBatch().then(() => {
      setTimeout(doNotificationLoop, 10000);
    });
  }

  function sendNotificationEmail(uid, url, conversation_id, email, remaining) {
    let subject = "New statements to vote on (conversation " + conversation_id + ")"; // Not sure if putting the conversation_id is ideal, but we need some way to ensure that the notifications for each conversation appear in separte threads.
    let body = "There are new statements available for you to vote on here:\n";
    body += "\n";
    body += url + "\n";
    body += "\n";
    body += "You're receiving this message because you're signed up to receive Polis notifications for this conversation. You can unsubscribe from these emails by clicking this link:\n";
    body += createNotificationsUnsubscribeUrl(conversation_id, email) + "\n";
    body += "\n";
    body += "If for some reason the above link does not work, please reply directly to this email with the message 'Unsubscribe' and we will remove you within 24 hours.";
    body += "\n";
    body += "Thanks for your participation";
    return sendEmailByUid(uid, subject, body);
  }

  let shouldSendNotifications = !devMode;
  if (shouldSendNotifications) {
    doNotificationLoop();
  }

  function createNotificationsUnsubscribeUrl(conversation_id, email) {
    let params = {
      conversation_id: conversation_id,
      email: email,
    };
    let path = "api/v3/notifications/unsubscribe";
    params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

    let server = "http://localhost:5000";
    if (!devMode) {
      server = "https://" + process.env.PRIMARY_POLIS_URL;
    }
    return server + "/" + path + "?" + paramsToStringSortedByName(params);
  }

  function createNotificationsSubscribeUrl(conversation_id, email) {
    let params = {
      conversation_id: conversation_id,
      email: email,
    };
    let path = "api/v3/notifications/subscribe";
    params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

    let server = "http://localhost:5000";
    if (!devMode) {
      server = "https://" + process.env.PRIMARY_POLIS_URL;
    }
    return server + "/" + path + "?" + paramsToStringSortedByName(params);
  }



  function handle_GET_notifications_subscribe(req, res) {
    let zid = req.p.zid;
    let email = req.p.email;
    let params = {
      conversation_id: req.p.conversation_id,
      email: req.p.email,
    };
    params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
    verifyHmacForQueryParams("api/v3/notifications/subscribe", params).then(function() {
      return pg.queryP("update participants set subscribed = 1 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
        res.set('Content-Type', 'text/html');
        res.send(
`<h1>Subscribed!</h1>
<p>
<a href="${createNotificationsUnsubscribeUrl(req.p.conversation_id, req.p.email)}">oops, unsubscribe me.</a>
</p>`
        );
      });
    }, function() {
      fail(res, 403, "polis_err_subscribe_signature_mismatch");
    }).catch(function(err) {
      fail(res, 500, "polis_err_subscribe_misc", err);
    });
  }


  function handle_GET_notifications_unsubscribe(req, res) {
    let zid = req.p.zid;
    let email = req.p.email;
    let params = {
      conversation_id: req.p.conversation_id,
      email: email,
    };
    params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
    verifyHmacForQueryParams("api/v3/notifications/unsubscribe", params).then(function() {
      return pg.queryP("update participants set subscribed = 0 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
        res.set('Content-Type', 'text/html');
        res.send(
`<h1>Unsubscribed.</h1>
<p>
<a href="${createNotificationsSubscribeUrl(req.p.conversation_id, req.p.email)}">oops, subscribe me again.</a>
</p>`
        );
      });
    }, function() {
      fail(res, 403, "polis_err_unsubscribe_signature_mismatch");
    }).catch(function(err) {
      fail(res, 500, "polis_err_unsubscribe_misc", err);
    });
  }

  function handle_POST_convSubscriptions(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let type = req.p.type;

    let email = req.p.email;

    function finish(type) {
      res.status(200).json({
        subscribed: type,
      });
    }

    if (type === 1) {
      subscribeToNotifications(zid, uid, email).then(finish).catch(function(err) {
        fail(res, 500, "polis_err_sub_conv " + zid + " " + uid, err);
      });
    } else if (type === 0) {
      unsubscribeFromNotifications(zid, uid).then(finish).catch(function(err) {
        fail(res, 500, "polis_err_unsub_conv " + zid + " " + uid, err);
      });
    } else {
      fail(res, 400, "polis_err_bad_subscription_type", new Error("polis_err_bad_subscription_type"));
    }
  }



  function handle_POST_auth_login(req, res) {
    let password = req.p.password;
    let email = req.p.email || "";
    let lti_user_id = req.p.lti_user_id;
    let lti_user_image = req.p.lti_user_image;
    let lti_context_id = req.p.lti_context_id;
    let tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    let afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    email = email.toLowerCase();
    if (!_.isString(password) || !password.length) {
      fail(res, 403, "polis_err_login_need_password");
      return;
    }
    pg.queryP("SELECT * FROM users WHERE LOWER(email) = ($1);", [email], function(err, docs) {
      docs = docs.rows;
      if (err) {
        fail(res, 403, "polis_err_login_unknown_user_or_password", err);
        console.error("polis_err_login_unknown_user_or_password_err");
        return;
      }
      if (!docs || docs.length === 0) {
        fail(res, 403, "polis_err_login_unknown_user_or_password_noresults");
        console.error("polis_err_login_unknown_user_or_password_noresults");
        return;
      }

      let uid = docs[0].uid;

      pg.queryP("select pwhash from jianiuevyew where uid = ($1);", [uid], function(err, results) {
        results = results.rows;
        if (err) {
          fail(res, 403, "polis_err_login_unknown_user_or_password", err);
          console.error("polis_err_login_unknown_user_or_password_err");
          return;
        }
        if (!results || results.length === 0) {
          fail(res, 403, "polis_err_login_unknown_user_or_password");
          console.error("polis_err_login_unknown_user_or_password_noresults");
          return;
        }

        let hashedPassword = results[0].pwhash;

        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
          winston.log("info", "errCompare, result", errCompare, result);
          if (errCompare || !result) {
            fail(res, 403, "polis_err_login_unknown_user_or_password");
            console.error("polis_err_login_unknown_user_or_password_badpassword");
            return;
          }

          startSession(uid, function(errSess, token) {
            let response_data = {
              uid: uid,
              email: email,
              token: token,
            };
            addCookies(req, res, token, uid).then(function() {
              winston.log("info", "uid", uid);
              winston.log("info", "lti_user_id", lti_user_id);
              winston.log("info", "lti_context_id", lti_context_id);
              let ltiUserPromise = lti_user_id ?
                addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) :
                Promise.resolve();
              let ltiContextMembershipPromise = lti_context_id ?
                addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) :
                Promise.resolve();
              Promise.all([ltiUserPromise, ltiContextMembershipPromise]).then(function() {
                if (lti_user_id) {
                  if (afterJoinRedirectUrl) {
                    res.redirect(afterJoinRedirectUrl);
                  } else {
                    renderLtiLinkageSuccessPage(req, res, {
                      // may include token here too
                      context_id: lti_context_id,
                      uid: uid,
                      // hname: hname,
                      email: email,
                    });
                  }
                } else {
                  res.json(response_data);
                }
              }).catch(function(err) {
                fail(res, 500, "polis_err_adding_associating_with_lti_user", err);
              });

            }).catch(function(err) {
              fail(res, 500, "polis_err_adding_cookies", err);
            });
          }); // startSession
        }); // compare
      }); // pwhash query
    }); // users query
  } // /api/v3/auth/login



  function handle_POST_joinWithInvite(req, res) {

    // if they're already in the conv
    //     this shouldn't get called
    // else
    //     not in conv.
    //     need to join
    //     has their permanentCookieToken already joined?
    //         do they have an email attached?
    //              hmm weird.. what to do?
    //         else
    //              force them to create a full account
    //     else
    //         let them join without forcing a sign in (assuming conversation allows that)



    return joinWithZidOrSuzinvite({
      answers: req.p.answers,
      existingAuth: !!req.p.uid,
      suzinvite: req.p.suzinvite,
      permanentCookieToken: req.p.permanentCookieToken,
      uid: req.p.uid,
      zid: req.p.zid, // since the zid is looked up using the conversation_id, it's safe to use zid as an invite token. TODO huh?
      referrer: req.p.referrer,
      parent_url: req.p.parent_url,
    })
    .then(function(o) {
      let uid = o.uid;
      winston.log("info", "startSessionAndAddCookies " + uid + " existing " + o.existingAuth);
      // TODO check for possible security implications
      if (!o.existingAuth) {
        return startSessionAndAddCookies(req, res, uid).then(function() {
          return o;
        });
      }
      return Promise.resolve(o);
    })
    .then(function(o) {
      winston.log("info", "permanentCookieToken", o.permanentCookieToken);
      if (o.permanentCookieToken) {
        return recordPermanentCookieZidJoin(o.permanentCookieToken, o.zid).then(function() {
          return o;
        }, function() {
          return o;
        });
      } else {
        return o;
      }
    })
    .then(function(o) {
      let pid = o.pid;
      res.status(200).json({
        pid: pid,
        uid: req.p.uid,
      });
    })
    .catch(function(err) {
      if (err && err.message && err.message.match(/polis_err_need_full_user/)) {
        userFail(res, 403, err.message, err);
      } else if (err && err.message) {
        fail(res, 500, err.message, err);
      } else if (err) {
        fail(res, 500, "polis_err_joinWithZidOrSuzinvite", err);
      } else {
        fail(res, 500, "polis_err_joinWithZidOrSuzinvite");
      }
    });
  }


  // Test for deadlock condition
  // _.times(2, function() {
  // setInterval(function() {
  //         winston.log("info","foobar test call begin");
  //         joinWithZidOrSuzinvite({
  //             answers: [],
  //             existingAuth: false,
  //             zid: 11580,
  //             // uid: req.p.uid,
  //         }).then(function() {
  //             winston.log("info",'foobar test ok');
  //         }).catch(function(err) {
  //             winston.log("info",'foobar test failed');
  //             winston.log("info",err);
  //         });

  // }, 10);
  // });


  function joinWithZidOrSuzinvite(o) {
    return Promise.resolve(o)
      .then(function(o) {
        if (o.suzinvite) {
          return getSUZinviteInfo(o.suzinvite).then(function(suzinviteInfo) {
            return Object.assign(o, suzinviteInfo);
          });
        } else if (o.zid) {
          return o;
        } else {
          throw new Error("polis_err_missing_invite");
        }
      })
      .then(function(o) {
        winston.log("info", "joinWithZidOrSuzinvite convinfo begin");
        return getConversationInfo(o.zid).then(function(conv) {
          winston.log("info", "joinWithZidOrSuzinvite convinfo done");
          o.conv = conv;
          return o;
        });
      })
      .then(function(o) {
        if (o.lti_users_only) {
          if (o.uid) {
            return pg.queryP("select * from lti_users where uid = ($1)", [o.uid]).then(function(rows) {
              if (rows && rows.length) {
                return o;
              } else {
                throw new Error("polis_err_missing_lti_user_for_uid");
              }
            });
          } else {
            throw new Error("polis_err_need_uid_to_check_lti_users");
          }
        } else {
          return o;
        }
      })
      .then(function(o) {
        winston.log("info", "joinWithZidOrSuzinvite userinfo begin");
        if (!o.uid) {
          winston.log("info", "joinWithZidOrSuzinvite userinfo nope");
          return o;
        }
        return getUserInfoForUid2(o.uid).then(function(user) {
          winston.log("info", "joinWithZidOrSuzinvite userinfo done");
          o.user = user;
          return o;
        });
      })
      // Commenting out for now until we have proper workflow for user.
      // .then(function(o) {
      //   winston.log("info","joinWithZidOrSuzinvite check email");
      // if (o.conv.owner_sees_participation_stats) {
      //   // User stats can be provided either by having the users sign in with polis
      //   // or by having them join via suurls.
      //   if (!(o.user && o.user.email) && !o.suzinvite) { // may want to inspect the contenst of the suzinvite info object instead of just the suzinvite
      //     throw new Error("polis_err_need_full_user_for_zid_" + o.conv.zid + "_and_uid_" + (o.user&&o.user.uid));
      //   }
      // }
      // return o;
      // })
      .then(function(o) {
        // winston.log("info","joinWithZidOrSuzinvite check email done");
        if (o.uid) {
          return o;
        } else {
          return createDummyUser().then(function(uid) {
            return Object.assign(o, {
              uid: uid,
            });
          });
        }
      })
      .then(function(o) {
        return userHasAnsweredZeQuestions(o.zid, o.answers).then(function() {
          // looks good, pass through
          return o;
        });
      })
      .then(function(o) {
        let info = {};
        if (o.referrer) {
          info.referrer = o.referrer;
        }
        if (o.parent_url) {
          info.parent_url = o.parent_url;
        }
        // TODO_REFERRER add info as third arg
        return joinConversation(o.zid, o.uid, info, o.answers).then(function(ptpt) {
          return Object.assign(o, ptpt);
        });
      })
      .then(function(o) {
        if (o.xid) {
          // used for suzinvite case

          return xidExists(o.xid, o.conv.org_id, o.uid).then(function(exists) {
            if (exists) {
              // skip creating the entry (workaround for posgres's lack of upsert)
              return o;
            }
            var shouldCreateXidEntryPromise = o.conv.use_xid_whitelist ?
              isXidWhitelisted(o.conv.owner, o.xid) :
              Promise.resolve(true);
            shouldCreateXidEntryPromise.then((should) => {
              if (should) {
                return createXidEntry(o.xid, o.conv.org_id, o.uid).then(function() {
                  return o;
                });
              } else {
                throw new Error("polis_err_xid_not_whitelisted");
              }
            });
          });
        } else {
          return o;
        }
      })
      .then(function(o) {
        if (o.suzinvite) {
          return deleteSuzinvite(o.suzinvite).then(function() {
            return o;
          });
        } else {
          return o;
        }
      });
  }


  function startSessionAndAddCookies(req, res, uid) {
    return new Promise(function(resolve, reject) {
      startSession(uid, function(err, token) {
        if (err) {
          reject(new Error("polis_err_reg_failed_to_start_session"));
          return;
        }
        resolve(addCookies(req, res, token, uid));
      });
    });
  }

  function renderLtiLinkageSuccessPage(req, res, o) {
    res.set({
      'Content-Type': 'text/html',
    });
    let html = "" +
      "<!DOCTYPE html><html lang='en'>" +
      '<head>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
      '</head>' +
      "<body style='max-width:320px'>" +
      "<p>You are signed in as polis user " + o.email + "</p>" +
      // "<p><a href='https://pol.is/user/logout'>Change pol.is users</a></p>" +
      // "<p><a href='https://preprod.pol.is/inbox/context="+ o.context_id +"'>inbox</a></p>" +
      // "<p><a href='https://preprod.pol.is/2demo' target='_blank'>2demo</a></p>" +
      // "<p><a href='https://preprod.pol.is/conversation/create/context="+ o.context_id +"'>create</a></p>" +

      // form for sign out
      '<p><form role="form" class="FormVertical" action="' + getServerNameWithProtocol(req) + '/api/v3/auth/deregister" method="POST">' +
      '<input type="hidden" name="showPage" value="canvas_assignment_deregister">' +
      '<button type="submit" class="Btn Btn-primary">Change pol.is users</button>' +
      '</form></p>' +

      // "<p style='background-color: yellow;'>" +
      //     JSON.stringify(req.body)+
      //     (o.user_image ? "<img src='"+o.user_image+"'></img>" : "") +
      // "</p>"+
      "</body></html>";
    res.status(200).send(html);
  }

  function deleteFacebookUserRecord(o) {
    if (!isPolisDev(o.uid)) {
      // limit to test accounts for now
      return Promise.reject("polis_err_not_implemented");
    }
    return pg.queryP("delete from facebook_users where uid = ($1);", [o.uid]);
  }

  function createFacebookUserRecord(o) {
    winston.log("info", "createFacebookUserRecord");
    winston.log("info", "createFacebookUserRecord", JSON.stringify(o));
    winston.log("info", o);
    winston.log("info", "end createFacebookUserRecord");
    let profileInfo = o.fb_public_profile;
    winston.log("info", "createFacebookUserRecord profileInfo");
    winston.log("info", profileInfo);
    winston.log("info", "end createFacebookUserRecord profileInfo");
    // Create facebook user record
    return pg.queryP("insert into facebook_users (uid, fb_user_id, fb_name, fb_link, fb_public_profile, fb_login_status, fb_access_token, fb_granted_scopes, fb_location_id, location, fb_friends_response, response) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);", [
      o.uid,
      o.fb_user_id,
      profileInfo.name,
      profileInfo.link,
      JSON.stringify(o.fb_public_profile),
      o.fb_login_status,
      // o.fb_auth_response,
      o.fb_access_token,
      o.fb_granted_scopes,
      profileInfo.locationInfo && profileInfo.locationInfo.id,
      profileInfo.locationInfo && profileInfo.locationInfo.name,
      o.fb_friends_response || "",
      o.response,
    ]);
  }

  function updateFacebookUserRecord(o) {
    let profileInfo = o.fb_public_profile;
    let fb_public_profile_string = JSON.stringify(o.fb_public_profile);
    // Create facebook user record
    return pg.queryP("update facebook_users set modified=now_as_millis(), fb_user_id=($2), fb_name=($3), fb_link=($4), fb_public_profile=($5), fb_login_status=($6), fb_access_token=($7), fb_granted_scopes=($8), fb_location_id=($9), location=($10), fb_friends_response=($11), response=($12) where uid = ($1);", [
      o.uid,
      o.fb_user_id,
      profileInfo.name,
      profileInfo.link,
      fb_public_profile_string,
      o.fb_login_status,
      // o.fb_auth_response,
      o.fb_access_token,
      o.fb_granted_scopes,
      profileInfo.locationInfo && profileInfo.locationInfo.id,
      profileInfo.locationInfo && profileInfo.locationInfo.name,
      o.fb_friends_response || "",
      o.response,
    ]);
  }

  function addFacebookFriends(uid, fb_friends_response) {
    let fbFriendIds = fb_friends_response.map(function(friend) {
      return friend.id + '';
    }).filter(function(id) {
      // NOTE: would just store facebook IDs as numbers, but they're too big for JS numbers.
      let hasNonNumericalCharacters = /[^0-9]/.test(id);
      if (hasNonNumericalCharacters) {
        emailBadProblemTime("found facebook ID with non-numerical characters " + id);
      }
      return !hasNonNumericalCharacters;
    }).map(function(id) {
      return '\'' + id + '\''; // wrap in quotes to force pg to treat them as strings
    });
    if (!fbFriendIds.length) {
      return Promise.resolve();
    } else {
      // add friends to the table
      // TODO periodically remove duplicates from the table, and pray for postgres upsert to arrive soon.
      return pg.queryP("insert into facebook_friends (uid, friend) select ($1), uid from facebook_users where fb_user_id in (" + fbFriendIds.join(",") + ");", [
        uid,
      ]);
    }
  }



  function handle_GET_perfStats(req, res) {
    res.json(METRICS_IN_RAM);
  }

  function getFirstForPid(votes) {
    let seen = {};
    let len = votes.length;
    let firstVotes = [];
    for (var i = 0; i < len; i++) {
      let vote = votes[i];
      if (!seen[vote.pid]) {
        firstVotes.push(vote);
        seen[vote.pid] = true;
      }
    }
    return firstVotes;
  }


  function isParentDomainWhitelisted(domain, zid, isWithinIframe, domain_whitelist_override_key) {
    return pg.queryP_readOnly(
        "select * from site_domain_whitelist where site_id = " +
        "(select site_id from users where uid = " +
        "(select owner from conversations where zid = ($1)));", [zid])
      .then(function(rows) {
        console.log('isParentDomainWhitelisted', domain, zid, isWithinIframe);
        if (!rows || !rows.length || !rows[0].domain_whitelist.length) {
          // there is no whitelist, so any domain is ok.
          console.log('isParentDomainWhitelisted', 'no whitelist');
          return true;
        }
        let whitelist = rows[0].domain_whitelist;
        let wdomains = whitelist.split(',');
        if (!isWithinIframe && wdomains.indexOf('*.pol.is') >= 0) {
          // if pol.is is in the whitelist, then it's ok to show the conversation outside of an iframe.
          console.log('isParentDomainWhitelisted', '*.pol.is');
          return true;
        }
        if (domain_whitelist_override_key && (rows[0].domain_whitelist_override_key === domain_whitelist_override_key)) {
          return true;
        }
        let ok = false;
        console.log('isParentDomainWhitelisted', 1);
        for (var i = 0; i < wdomains.length; i++) {
          let w = wdomains[i];
          let wParts = w.split('.');

          // example: domain might be blogs.nytimes.com, and whitelist entry might be *.nytimes.com, and that should be a match
          let parts = domain.split('.');

          console.log('isParentDomainWhitelisted', 2, wParts, parts);
          if (wParts.length && wParts[0] === "*") {
            // wild card case
            // check for a match on each part following the '*'
            let bad = false;

            wParts = wParts.reverse();
            parts = parts.reverse();
            console.log('isParentDomainWhitelisted', 3, parts, wParts);
            for (var p = 0; p < wParts.length - 1; p++) {
              console.log('isParentDomainWhitelisted', 33, parts[p], wParts[p]);
              if (wParts[p] !== parts[p]) {
                bad = true;
                console.log('isParentDomainWhitelisted', 4);
                break;
              }
            }
            ok = !bad;
          } else {
            // no wild card
            let bad2 = false;
            console.log('isParentDomainWhitelisted', 5);
            if (wParts.length !== parts.length) {
              console.log('isParentDomainWhitelisted', 6);
              bad2 = true;
            }
            console.log('isParentDomainWhitelisted', 61, parts, wParts);
            // check for a match on each part
            for (var p2 = 0; p2 < wParts.length; p2++) {
              console.log('isParentDomainWhitelisted', 66, parts[p2], wParts[p2]);
              if (wParts[p2] !== parts[p2]) {
                bad2 = true;
                console.log('isParentDomainWhitelisted', 7);
                break;
              }
            }
            ok = !bad2;
          }

          if (ok) {
            break;
          }

        }
        console.log('isParentDomainWhitelisted', 8, ok);
        return ok;
      });
  }


  function denyIfNotFromWhitelistedDomain(req, res, next) {

    let isWithinIframe = req.headers && req.headers.referer && req.headers.referer.includes('parent_url');


    // res.status(403);
    // next("polis_err_domain");
    // return;

    let ref = req.headers.referer;
    if (isWithinIframe) {
      if (ref) {
        ref = decodeURIComponent(ref.replace(/.*parent_url=/, '').replace(/&.*/, ''));

        ref = ref && ref.length && ref.split('/');
        ref = ref && ref.length >= 3 && ref[2];
        ref = ref || "";
      }
    } else {
      ref = ref && ref.length && ref.split('/');
      ref = ref && ref.length >= 3 && ref[2];
      ref = ref || "";
    }


    // let path = req.path;
    // path = path && path.split('/');
    // let conversation_id = path && path.length >= 2 && path[1];
    let zid = req.p.zid;



    isParentDomainWhitelisted(ref, zid, isWithinIframe, req.p.domain_whitelist_override_key).then(function(isOk) {
      if (isOk) {
        next();
      } else {
        res.send(403, "polis_err_domain");
        next("polis_err_domain");
      }
    }).catch(function(err) {
      console.error(err);
      res.send(403, "polis_err_domain");
      next("polis_err_domain_misc");
    });
  }

  function setDomainWhitelist(uid, newWhitelist) {
    // TODO_UPSERT
    return pg.queryP("select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));", [uid])
      .then(function(rows) {
        if (!rows || !rows.length) {
          return pg.queryP("insert into site_domain_whitelist (site_id, domain_whitelist) values ((select site_id from users where uid = ($1)), $2);", [uid, newWhitelist]);
        } else {
          return pg.queryP("update site_domain_whitelist set domain_whitelist = ($2) where site_id = (select site_id from users where uid = ($1));", [uid, newWhitelist]);
        }
      });
  }

  function getDomainWhitelist(uid) {
    return pg.queryP("select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));", [uid]).then(function(rows) {
      if (!rows || !rows.length) {
        return "";
      }
      return rows[0].domain_whitelist;
    });
  }


  function handle_GET_domainWhitelist(req, res) {
    getDomainWhitelist(req.p.uid).then(function(whitelist) {
      res.json({
        domain_whitelist: whitelist,
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_domainWhitelist_misc", err);
    });
  }


  function handle_POST_domainWhitelist(req, res) {
    setDomainWhitelist(req.p.uid, req.p.domain_whitelist).then(function() {
      res.json({
        domain_whitelist: req.p.domain_whitelist,
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_post_domainWhitelist_misc", err);
    });
  }


  function handle_GET_conversationStats(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let until = req.p.until;

    let hasPermission = req.p.rid ? Promise.resolve(!!req.p.rid) : isModerator(zid, uid);

    hasPermission.then(function(ok) {
      if (!ok) {
        fail(res, 403, "polis_err_conversationStats_need_report_id_or_moderation_permission");
        return;
      }

      let args = [zid];

      let q0 = until ?
        "select created, pid, mod from comments where zid = ($1) and created < ($2) order by created;" :
        "select created, pid, mod from comments where zid = ($1) order by created;";

      let q1 = until ?
        "select created, pid from votes where zid = ($1) and created < ($2) order by created;" :
        "select created, pid from votes where zid = ($1) order by created;";

      if (until) {
        args.push(until);
      }

      return Promise.all([
        pg.queryP_readOnly(q0, args),
        pg.queryP_readOnly(q1, args),
        // pg.queryP_readOnly("select created from participants where zid = ($1) order by created;", [zid]),

        // pg.queryP_readOnly("with pidvotes as (select pid, count(*) as countForPid from votes where zid = ($1)"+
        //     " group by pid order by countForPid desc) select countForPid as n_votes, count(*) as n_ptpts "+
        //     "from pidvotes group by countForPid order by n_ptpts asc;", [zid]),

        // pg.queryP_readOnly("with all_social as (select uid from facebook_users union select uid from twitter_users), "+
        //     "ptpts as (select created, uid from participants where zid = ($1)) "+
        //     "select ptpts.created from ptpts inner join all_social on ptpts.uid = all_social.uid;", [zid]),
      ]).then(function(a) {
        function castTimestamp(o) {
          o.created = Number(o.created);
          return o;
        }
        let comments = _.map(a[0], castTimestamp);
        let votes = _.map(a[1], castTimestamp);
        // let uniqueHits = _.map(a[2], castTimestamp); // participants table
        // let votesHistogram = a[2];
        // let socialUsers = _.map(a[4], castTimestamp);

        let votesGroupedByPid = _.groupBy(votes, "pid");
        let votesHistogramObj = {};
        _.each(votesGroupedByPid, function(votesByParticipant, pid) {
          votesHistogramObj[votesByParticipant.length] = (votesHistogramObj[votesByParticipant.length] + 1) || 1;
        });
        let votesHistogram = [];
        _.each(votesHistogramObj, function(ptptCount, voteCount) {
          votesHistogram.push({
            n_votes: voteCount,
            n_ptpts: ptptCount,
          });
        });
        votesHistogram.sort(function(a, b) {
          return a.n_ptpts - b.n_ptpts;
        });

        let burstsForPid = {};
        let interBurstGap = 10 * 60 * 1000; // a 10 minute gap between votes counts as a gap between bursts
        _.each(votesGroupedByPid, function(votesByParticipant, pid) {
          burstsForPid[pid] = 1;
          let prevCreated = votesByParticipant.length ? votesByParticipant[0] : 0;
          for (var v = 1; v < votesByParticipant.length; v++) {
            let vote = votesByParticipant[v];
            if (interBurstGap + prevCreated < vote.created) {
              burstsForPid[pid] += 1;
            }
            prevCreated = vote.created;
          }
        });
        let burstHistogramObj = {};
        _.each(burstsForPid, function(bursts, pid) {
          burstHistogramObj[bursts] = (burstHistogramObj[bursts] + 1) || 1;
        });
        let burstHistogram = [];
        _.each(burstHistogramObj, function(ptptCount, burstCount) {
          burstHistogram.push({
            n_ptpts: ptptCount,
            n_bursts: Number(burstCount),
          });
        });
        burstHistogram.sort(function(a, b) {
          return a.n_bursts - b.n_bursts;
        });

        let actualParticipants = getFirstForPid(votes); // since an agree vote is submitted for each comment's author, this includes people who only wrote a comment, but didn't explicitly vote.
        actualParticipants = _.pluck(actualParticipants, "created");
        let commenters = getFirstForPid(comments);
        commenters = _.pluck(commenters, "created");

        let totalComments = _.pluck(comments, "created");
        let totalVotes = _.pluck(votes, "created");
        // let viewTimes = _.pluck(uniqueHits, "created");
        // let totalSocialUsers = _.pluck(socialUsers, "created");

        votesHistogram = _.map(votesHistogram, function(x) {
          return {
            n_votes: Number(x.n_votes),
            n_ptpts: Number(x.n_ptpts),
          };
        });

        res.status(200).json({
          voteTimes: totalVotes,
          firstVoteTimes: actualParticipants,
          commentTimes: totalComments,
          firstCommentTimes: commenters,
          // viewTimes: viewTimes,
          votesHistogram: votesHistogram,
          burstHistogram: burstHistogram,
          // socialUsers: totalSocialUsers,
        });
      });

    }).catch(function(err) {
      fail(res, 500, "polis_err_conversationStats_misc", err);
    });
  }


  function handle_GET_snapshot(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;

    if (true) {
      throw new Error("TODO Needs to clone participants_extended and any other new tables as well.");
    }


    if (isPolisDev(uid)) {
      // is polis developer
    } else {
      fail(res, 403, "polis_err_permissions");
      return;
    }

    pg.queryP(
      "insert into conversations (topic, description, link_url, owner, modified, created, participant_count) " +
      "(select '(SNAPSHOT) ' || topic, description, link_url, $2, now_as_millis(), created, participant_count from conversations where zid = $1) returning *;", [
        zid,
        uid,
      ],
      function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_cloning_conversation", err);
          return;
        }
        // winston.log("info",rows);
        let conv = result.rows[0];

        // let conv = rows[0];
        let newZid = conv.zid;
        return pg.queryP(
          "insert into participants (pid, zid, uid, created, mod, subscribed) " +
          "select pid, ($2), uid, created, mod, 0 from participants where zid = ($1);", [
            zid,
            newZid,
          ]).then(function() {
            return pg.queryP(
              "insert into comments (pid, tid, zid, txt, velocity, mod, uid, active, lang, lang_confidence, created) " +
              "select pid, tid, ($2), txt, velocity, mod, uid, active, lang, lang_confidence, created from comments where zid = ($1);", [
                zid,
                newZid,
              ]).then(function() {
                return pg.queryP("select * from votes where zid = ($1);", [zid]).then((votes) => {
                  // insert votes one at a time.
                  return Promise.all(votes.map(function(v) {
                    let q = "insert into votes (zid, pid, tid, vote, created) values ($1, $2, $3, $4, $5);";
                    return pg.queryP(q, [newZid, v.pid, v.tid, v.vote, v.created]);
                  })).then(function() {
                    return generateAndRegisterZinvite(newZid, true).then(function(zinvite) {
                      res.status(200).json({
                        zid: newZid,
                        zinvite: zinvite,
                        url: getServerNameWithProtocol(req) + "/" + zinvite,
                      });
                    });
                  });
                });
              });
          }).catch(function(err) {
            fail(res, 500, "polis_err_cloning_conversation_misc", err);
          });
      });
  }


  function handle_GET_facebook_delete(req, res) {
    deleteFacebookUserRecord(req.p).then(function() {
      res.json({});
    }).catch(function(err) {
      fail(res, 500, err);
    });
  }


  function getFriends(fb_access_token) {
    function getMoreFriends(friendsSoFar, urlForNextCall) {
      // urlForNextCall includes access token
      return request.get(urlForNextCall).then(function(response) {
        let len = response.data.length;
        if (len) {
          for (var i = 0; i < len; i++) {
            friendsSoFar.push(response.data[i]);
          }
          if (response.paging.next) {
            return getMoreFriends(friendsSoFar, response.paging.next);
          }
          return friendsSoFar;
        } else {
          return friendsSoFar;
        }
      }, function(err) {
        emailBadProblemTime("getMoreFriends failed");
        return friendsSoFar;
      });
    }
    return new Promise(function(resolve, reject) {
      FB.setAccessToken(fb_access_token);
      FB.api('/me/friends', function(response) {
        if (response && !response.error) {
          let friendsSoFar = response.data;
          if (response.data.length && response.paging.next) {
            getMoreFriends(friendsSoFar, response.paging.next).then(
              resolve,
              reject);
          } else {
            resolve(friendsSoFar || []);
          }
        } else {
          reject(response);
        }
      });
    });
  } // end getFriends

  function getLocationInfo(fb_access_token, location) {
    return new Promise(function(resolve, reject) {
      if (location && location.id) {
        FB.setAccessToken(fb_access_token);
        FB.api('/' + location.id, function(locationResponse) {
          resolve(locationResponse);
        });
      } else {
        resolve({});
      }
    });
  }


  function handle_POST_auth_facebook(req, res) {
    let response = JSON.parse(req.p.response);
    let fb_access_token = response && response.authResponse && response.authResponse.accessToken;
    if (!fb_access_token) {
      emailBadProblemTime("polis_err_missing_fb_access_token " + req.headers.referer + "\n\n" + req.p.response);
      console.log(req.p.response);
      console.log(JSON.stringify(req.headers));
      fail(res, 500, "polis_err_missing_fb_access_token");
      return;
    }
    let fields = [
      'email',
      'first_name',
      'friends',
      'gender',
      'id',
      'is_verified',
      'last_name',
      'link',
      'locale',
      'location',
      'name',
      'timezone',
      'updated_time',
      'verified',
    ];

    FB.setAccessToken(fb_access_token);
    FB.api('me', {
      fields: fields,
    }, function(fbRes) {
      if (!fbRes || fbRes.error) {
        fail(res, 500, "polis_err_fb_auth_check", fbRes && fbRes.error);
        return;
      }

      const friendsPromise = (fbRes && fbRes.friends && fbRes.friends.length ?
        getFriends(fb_access_token) :
        Promise.resolve([]));

      Promise.all([
        getLocationInfo(fb_access_token, fbRes.location),
        friendsPromise,
      ]).then(function(a) {
        let locationResponse = a[0];
        let friends = a[1];

        if (locationResponse) {
          req.p.locationInfo = locationResponse;
        }
        if (friends) {
          req.p.fb_friends_response = JSON.stringify(friends);
        }
        response.locationInfo = locationResponse;
        do_handle_POST_auth_facebook(req, res, {
          locationInfo: locationResponse,
          friends: friends,
          info: _.pick(fbRes, fields),
        });
      });
    });
  }


  function do_handle_POST_auth_facebook(req, res, o) {

    // If a pol.is user record exists, and someone logs in with a facebook account that has the same email address, we should bind that facebook account to the pol.is account, and let the user sign in.
    let TRUST_FB_TO_VALIDATE_EMAIL = true;
    let email = o.info.email;
    let hname = o.info.name;
    let fb_friends_response = o.friends;
    let fb_user_id = o.info.id;
    let response = JSON.parse(req.p.response);
    let fb_public_profile = o.info;
    let fb_login_status = response.status;
    // let fb_auth_response = response.authResponse.
    let fb_access_token = response.authResponse.accessToken;
    // verified field is deprecated
		let verified = new Boolean(fb_user_id);

    // let existingUid = req.p.existingUid;
    let referrer = req.cookies[COOKIES.REFERRER];
    let password = req.p.password;
    let uid = req.p.uid;

    console.log("fb_data"); // TODO_REMOVE
    console.dir(o); // TODO_REMOVE

    let shouldAddToIntercom = req.p.owner;
    if (req.p.conversation_id) {
      // TODO needed now that we have "owner" param?
      shouldAddToIntercom = false;
    }

    let fbUserRecord = {
      // uid provided later
      fb_user_id: fb_user_id,
      fb_public_profile: fb_public_profile,
      fb_login_status: fb_login_status,
      // fb_auth_response: fb_auth_response,
      fb_access_token: fb_access_token,
      fb_granted_scopes: req.p.fb_granted_scopes,
      fb_friends_response: req.p.fb_friends_response || "",
      response: req.p.response,
    };


    function doFbUserHasAccountLinked(user) {
      if (user.fb_user_id === fb_user_id) {
        updateFacebookUserRecord(Object.assign({}, {
          uid: user.uid,
        }, fbUserRecord)).then(function() {
          let friendsAddedPromise = fb_friends_response ? addFacebookFriends(user.uid, fb_friends_response) : Promise.resolve();
          return friendsAddedPromise.then(function() {
            startSessionAndAddCookies(req, res, user.uid)
              .then(function() {
                res.json({
                  uid: user.uid,
                  hname: user.hname,
                  email: user.email,
                  // token: token
                });
              }).catch(function(err) {
                fail(res, 500, "polis_err_reg_fb_start_session2", err);
              });
          }, function(err) {
            fail(res, 500, "polis_err_linking_fb_friends2", err);
          });
        }, function(err) {
          fail(res, 500, "polis_err_updating_fb_info", err);
        }).catch(function(err) {
          fail(res, 500, "polis_err_fb_auth_misc", err);
        });
      } else {
        // the user with that email has a different FB account attached
        // so clobber the old facebook_users record and add the new one.
        deleteFacebookUserRecord(user).then(function() {
          doFbNotLinkedButUserWithEmailExists(user);
        }, function(err) {
          emailBadProblemTime("facebook auth where user exists with different facebook account " + user.uid);
          fail(res, 500, "polis_err_reg_fb_user_exists_with_different_account");
        });
      }
    } // doFbUserHasAccountLinked

    function doFbNotLinkedButUserWithEmailExists(user) {
      // user for this email exists, but does not have FB account linked.
      // user will be prompted for their password, and client will repeat the call with password
      // fail(res, 409, "polis_err_reg_user_exits_with_email_but_has_no_facebook_linked")
      if (!TRUST_FB_TO_VALIDATE_EMAIL && !password) {
        fail(res, 403, "polis_err_user_with_this_email_exists " + email);
      } else {
        let pwPromise = TRUST_FB_TO_VALIDATE_EMAIL ? Promise.resolve(true) : checkPassword(user.uid, password || "");
        pwPromise.then(function(ok) {
          if (ok) {
            createFacebookUserRecord(Object.assign({}, {
              uid: user.uid,
            }, fbUserRecord)).then(function() {
              let friendsAddedPromise = fb_friends_response ? addFacebookFriends(user.uid, fb_friends_response) : Promise.resolve();
              return friendsAddedPromise.then(function() {
                return startSessionAndAddCookies(req, res, user.uid).then(function() {
                  return user;
                });
              }, function(err) {
                fail(res, 500, "polis_err_linking_fb_friends", err);
              })
              .then(function(user) {
                res.status(200).json({
                  uid: user.uid,
                  hname: user.hname,
                  email: user.email,
                  // token: token,
                });
              }, function(err) {
                fail(res, 500, "polis_err_linking_fb_misc", err);
              });
            }, function(err) {
              fail(res, 500, "polis_err_linking_fb_to_existing_polis_account", err);
            }).catch(function(err) {
              fail(res, 500, "polis_err_linking_fb_to_existing_polis_account_misc", err);
            });
          } else {
            fail(res, 403, "polis_err_password_mismatch");
          }
        }, function(err) {
          fail(res, 500, "polis_err_password_check");
        });
      }
    } // end doFbNotLinkedButUserWithEmailExists

    function doFbNoUserExistsYet(user) {
      let promise;
      if (uid) {
        winston.log("info", "fb1 5a...");
        // user record already exists, so populate that in case it has missing info
        promise = Promise.all([
          pg.queryP("select * from users where uid = ($1);", [uid]),
          pg.queryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, hname]),
          pg.queryP("update users set email = ($2) where uid = ($1) and email is NULL;", [uid, email]),
        ]).then(function(o) {
          let user = o[0][0];
          winston.log("info", "fb1 5a");
          winston.log("info", user);
          winston.log("info", "end fb1 5a");
          return user;
        });
        winston.log("info", "fb1 5a....");
      } else {
        winston.log("info", "fb1 5b...");
        let query = "insert into users " +
          "(email, hname) VALUES " +
          "($1, $2) " +
          "returning *;";
        promise = pg.queryP(query, [email, hname])
          .then(function(rows) {
            let user = rows && rows.length && rows[0] || null;
            winston.log("info", "fb1 5b");
            winston.log("info", user);
            winston.log("info", "end fb1 5b");
            return user;
          });
      }
      // Create user record
      promise
        .then(function(user) {
          winston.log("info", "fb1 4");
          winston.log("info", user);
          winston.log("info", "end fb1 4");
          return createFacebookUserRecord(Object.assign({}, user, fbUserRecord)).then(function() {
            return user;
          });
        })
        .then(function(user) {
          winston.log("info", "fb1 3");
          winston.log("info", user);
          winston.log("info", "end fb1 3");
          if (fb_friends_response) {
            return addFacebookFriends(user.uid, fb_friends_response).then(function() {
              return user;
            });
          } else {
            // no friends, or this user is first polis user among his/her friends.
            return user;
          }
        }, function(err) {
          fail(res, 500, "polis_err_reg_fb_user_creating_record2", err);
        })
        .then(function(user) {
          winston.log("info", "fb1 2");
          winston.log("info", user);
          winston.log("info", "end fb1 2");
          let uid = user.uid;
          return startSessionAndAddCookies(req, res, uid).then(function() {
            return user;
          }, function(err) {
            fail(res, 500, "polis_err_reg_fb_user_creating_record3", err);
          });
        }, function(err) {
          fail(res, 500, "polis_err_reg_fb_user_creating_record", err);
        })
        .then(function(user) {
          winston.log("info", "fb1");
          winston.log("info", user);
          winston.log("info", "end fb1");
          res.json({
            uid: user.uid,
            hname: user.hname,
            email: user.email,
            // token: token
          });
          if (shouldAddToIntercom) {
            let params = {
              "email": user.email,
              "name": user.hname,
              "user_id": user.uid,
            };
            let customData = {};
            if (referrer) {
              customData.referrer = referrer;
            }
            // if (organization) {
            //     customData.org = organization;
            // }
            customData.fb = true; // mark this user as a facebook auth user
            customData.uid = user.uid;
            if (_.keys(customData).length) {
              params.custom_data = customData;
            }
            intercom.createUser(params, function(err, res) {
              if (err) {
                winston.log("info", err);
                console.error("polis_err_intercom_create_user_fb_fail");
                winston.log("info", params);
                yell("polis_err_intercom_create_user_fb_fail");
                return;
              }
            });
          }
        }, function(err) {
          fail(res, 500, "polis_err_reg_fb_user_misc22", err);
        }).catch(function(err) {
          fail(res, 500, "polis_err_reg_fb_user_misc2", err);
        });
    } // end doFbNoUserExistsYet

    let emailVerifiedPromise = Promise.resolve(true);
    if (!verified) {
      if (email) {
        emailVerifiedPromise = isEmailVerified(email);
      } else {
        emailVerifiedPromise = Promise.resolve(false);
      }
    }

    Promise.all([
      emailVerifiedPromise,
    ]).then(function(a) {
      let isVerifiedByPolisOrFacebook = a[0];

      if (!isVerifiedByPolisOrFacebook) {
        if (email) {
          doSendVerification(req, email);
          res.status(403).send("polis_err_reg_fb_verification_email_sent");
          return;
        } else {
          res.status(403).send("polis_err_reg_fb_verification_noemail_unverified");
          return;
        }
      }

      pg.queryP("select users.*, facebook_users.fb_user_id from users left join facebook_users on users.uid = facebook_users.uid " +
        "where users.email = ($1) " +
        "   or facebook_users.fb_user_id = ($2) " +
        ";", [email, fb_user_id]).then(function(rows) {
          let user = rows && rows.length && rows[0] || null;
          if (rows && rows.length > 1) {
            // the auth provided us with email and fb_user_id where the email is one polis user, and the fb_user_id is for another.
            // go with the one matching the fb_user_id in this case, and leave the email matching account alone.
            user = _.find(rows, function(row) {
              return row.fb_user_id === fb_user_id;
            });
          }
          if (user) {
            if (user.fb_user_id) {
              doFbUserHasAccountLinked(user);
            } else {
              doFbNotLinkedButUserWithEmailExists(user);
            }
          } else {
            doFbNoUserExistsYet(user);
          }
        }, function(err) {
          fail(res, 500, "polis_err_reg_fb_user_looking_up_email", err);
        }).catch(function(err) {
          fail(res, 500, "polis_err_reg_fb_user_misc", err);
        });
    });
  } // end do_handle_POST_auth_facebook

  function handle_POST_auth_new(req, res) {
    require('./auth/create-user').createUser(req, res);
  } // end /api/v3/auth/new


  function handle_POST_tutorial(req, res) {
    let uid = req.p.uid;
    let step = req.p.step;
    pg.queryP("update users set tut = ($1) where uid = ($2);", [step, uid]).then(function() {
      res.status(200).json({});
    }).catch(function(err) {
      fail(res, 500, "polis_err_saving_tutorial_state", err);
    });
  }



  function handle_GET_users(req, res) {
    let uid = req.p.uid;

    if (req.p.errIfNoAuth && !uid) {
      fail(res, 401, "polis_error_auth_needed");
      return;
    }

    getUser(uid, null, req.p.xid, req.p.owner_uid).then(function(user) {
      res.status(200).json(user);
    }, function(err) {
      fail(res, 500, "polis_err_getting_user_info2", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_getting_user_info", err);
    });
  }

  function getUser(uid, zid_optional, xid_optional, owner_uid_optional) {
    if (!uid) {
      // this api may be called by a new user, so we don't want to trigger a failure here.
      return Promise.resolve({});
    }

    let xidInfoPromise = Promise.resolve(null);
    if (zid_optional && xid_optional) {
      xidInfoPromise = getXidRecord(xid_optional, zid_optional);
    } else if (xid_optional && owner_uid_optional) {
      xidInfoPromise = getXidRecordByXidOwnerId(xid_optional, owner_uid_optional, zid_optional);
    }

    return Promise.all([
      getUserInfoForUid2(uid),
      getFacebookInfo([uid]),
      getTwitterInfo([uid]),
      xidInfoPromise,
      getEmailVerifiedInfo([uid])
    ]).then(function(o) {
      let info = o[0];
      let fbInfo = o[1];
      let twInfo = o[2];
      let xInfo = o[3];
      let mvInfo = o[4];

      let hasFacebook = fbInfo && fbInfo.length && fbInfo[0];
      let hasTwitter = twInfo && twInfo.length && twInfo[0];
      let hasXid = xInfo && xInfo.length && xInfo[0];
      if (hasFacebook) {
        let width = 40;
        let height = 40;
        fbInfo.fb_picture = "https://graph.facebook.com/v2.2/" + fbInfo.fb_user_id + "/picture?width=" + width + "&height=" + height;
        delete fbInfo[0].response;
      }
      if (hasTwitter) {
        delete twInfo[0].response;
      }
      if (hasXid) {
        delete xInfo[0].owner;
        delete xInfo[0].created;
        delete xInfo[0].uid;
      }
      return {
        uid: uid,
        email: info.email,
        hname: info.hname,
        emailVerified: !!(mvInfo && mvInfo.length > 0 && mvInfo[0]),
        hasFacebook: !!hasFacebook,
        facebook: fbInfo && fbInfo[0],
        twitter: twInfo && twInfo[0],
        hasTwitter: !!hasTwitter,
        hasXid: !!hasXid,
        xInfo: xInfo && xInfo[0],
        finishedTutorial: !!info.tut,
        site_ids: [info.site_id],
        created: Number(info.created),
        daysInTrial: 10 + (usersToAdditionalTrialDays[uid] || 0),
        // plan: planCodeToPlanName[info.plan],
        planCode: info.plan,
      };
    });
  }

  // These map from non-ui string codes to number codes used in the DB
  // The string representation ("sites", etc) is also used in intercom.
  var planCodes = {
    mike: 9999,
    trial: 0,
    free: 0,
    individuals: 1,
    students: 2,
    pp: 3,
    sites: 100,
    org99: 99,
    pro: 300,
    organizations: 1000,
  };

  // // These are for customer to see in UI
  // var planCodeToPlanName = {
  //   9999: "MikePlan",
  //   0: "Trial",
  //   1: "Individual",
  //   2: "Student",
  //   3: "Participants Pay",
  //   100: "Site",
  //   1000: "Organization",
  // };


  function changePlan(uid, planCode) {
    return new Promise(function(resolve, reject) {
      pg.queryP("update users set plan = ($1) where uid = ($2);", [planCode, uid], function(err, results) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  function setUsersPlanInIntercom(uid, planCode) {
    return new Promise(function(resolve, reject) {
      var params = {
        "user_id": uid,
        "custom_data": {
          "plan_code": planCode,
        },
      };
      intercom.updateUser(params, function(err, res) {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }


  function createStripeUser(o) {
    return new Promise(function(resolve, reject) {
      stripe.customers.create(o, function(err, customer) {
        if (err) {
          reject(err);
        } else {
          resolve(customer);
        }
      });
    });
  }

  function getStripeUser(customerId) {
    return new Promise(function(resolve, reject) {
      stripe.customers.retrieve(customerId, function(err, customer) {
        if (err) {
          reject(err);
        } else {
          resolve(customer);
        }
      });
    });
  }

  function createStripeSubscription(customerId, planId) {
    return new Promise(function(resolve, reject) {
      stripe.customers.createSubscription(customerId, {
        plan: planId,
      }, function(err, subscription) {
        if (err) {
          reject(err);
        } else {
          resolve(subscription);
        }
      });
    });
  }

  function updateStripePlan(user, stripeToken, stripeEmail, plan) {
    var customerPromise = user.stripeCustomerId ? getStripeUser(user.stripeCustomerId) : createStripeUser({
      card: stripeToken,
      description: user.hname,
      email: stripeEmail,
      metadata: {
        uid: user.uid,
        polisEmail: user.email,
      },
    });

    return customerPromise.then(function(customer) {

      // throw new Error("TODO"); // TODO is "plan" the right identifier?

      // TODO may need to wrangle existing plans..

      return createStripeSubscription(customer.id, plan).then(function(data) {
        return pg.queryP("insert into stripe_subscriptions (uid, stripe_subscription_data) values ($1, $2) "+
          "on conflict  (uid) do update set stripe_subscription_data = ($2), modified = now_as_millis();", [user.uid, data]);
      });
    });
  }



  function handle_GET_createPlanChangeCoupon(req, res) {
    var uid = req.p.uid;
    var planCode = req.p.planCode;
    generateTokenP(30, false).then(function(code) {
      return pg.queryP("insert into coupons_for_free_upgrades (uid, code, plan) values ($1, $2, $3) returning *;", [uid, code, planCode]).then(function(rows) {
        var row = rows[0];
        row.url = "https://pol.is/api/v3/changePlanWithCoupon?code=" + row.code;
        res.status(200).json(row);
      }).catch(function(err) {
        fail(res, 500, "polis_err_creating_coupon", err);
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_creating_coupon_code", err);
    });
  }


  function handle_GET_changePlanWithCoupon(req, res) {
    var uid = req.p.uid;
    var code = req.p.code;
    var isCurrentUser = true;
    getCouponInfo(code).then(function(infos) {
      var info = infos[0];
      if (uid) {
        if (uid !== info.uid) {
          // signed in user is someone else!
          // This could easily happen if someone is testing an auto-join conversation in another browser.
          // So don't set the cookies in this case.
          isCurrentUser = false;
        }
      }
      return updatePlanOld(req, res, info.uid, info.plan, isCurrentUser);
    }).catch(function(err) {
      emailBadProblemTime("changePlanWithCoupon failed");
      fail(res, 500, "polis_err_changing_plan_with_coupon", err);
    });
  }

  function getCouponInfo(couponCode) {
    return pg.queryP("select * from coupons_for_free_upgrades where code = ($1);", [couponCode]);
  }

  function updatePlan(req, res, uid, planCode) {
    winston.log("info", 'updatePlan', uid, planCode);
    setUsersPlanInIntercom(uid, planCode).catch(function(err) {
      emailBadProblemTime("User " + uid + " changed their plan, but we failed to update Intercom");
    });

    // update DB and finish
    return changePlan(uid, planCode).then(function() {
      // Set cookie
      var setOnPolisDomain = !domainOverride;
      var origin = req.headers.origin || "";
      if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        setOnPolisDomain = false;
      }
      setPlanCookie(req, res, setOnPolisDomain, planCode);
    });
  }


  function updatePlanOld(req, res, uid, planCode, isCurrentUser) {
    winston.log("info", 'updatePlan', uid, planCode);
    setUsersPlanInIntercom(uid, planCode).catch(function(err) {
      emailBadProblemTime("User " + uid + " changed their plan, but we failed to update Intercom");
    });

    // update DB and finish
    return changePlan(uid, planCode).then(function() {
      // Set cookie
      if (isCurrentUser) {
        var protocol = devMode ? "http" : "https";
        var setOnPolisDomain = !domainOverride;
        var origin = req.headers.origin || "";
        if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
          setOnPolisDomain = false;
        }
        setPlanCookie(req, res, setOnPolisDomain, planCode);

        // Redirect to the same URL with the path behind the fragment "#"
        var path = "/settings";
        if (planCode >= 99) {
          path = "/settings/enterprise";
        }
        res.writeHead(302, {
          Location: protocol + "://" + req.headers.host + path,
        });
        return res.end();
      } else {
        res.status(200).json({
          status: "upgraded!",
        });
      }
    }).catch(function(err) {
      emailBadProblemTime("User changed their plan, but we failed to update the DB.");
      fail(res, 500, "polis_err_changing_plan", err);
    });
  }



  function handle_POST_stripe_save_token(req, res) {
    console.log("info", "XXX - Got the params!");
    console.log(req.body);
    console.log("info", "XXX - Got the params!");
  }


  function handle_POST_stripe_upgrade(req, res) {
    var uid = req.p.uid;
    var planName = req.p.plan;
    var planCode = planCodes[planName];

    getUserInfoForUid2(uid).then(function(user) {
      var stripeResponse = JSON.parse(req.p.stripeResponse);

      const body = "Polis account upgrade: " + user.hname + "\n" +
        user.email + "\n" +
        "planName " + planName + "\n" +
        "planCode " + planCode + "\n";

      emailTeam("Polis account upgraded", body);


      return updateStripePlan(user, stripeResponse.id, user.email, planName);
    }).then(function() {
      return updatePlan(req, res, uid, planCode);
    }).then(function() {
      res.json({});
    }).catch(function(err) {

      emailBadProblemTime("FAILED Polis account upgrade: " + uid + " err.type: " + (err && err.type) + "\n\n" + err);

      if (err) {
        if (err.type === 'StripeCardError') {
          return fail(res, 500, "polis_err_stripe_card_declined", err);
        } else {
          return fail(res, 500, "polis_err_stripe3", err);
        }
      } else {
        return fail(res, 500, "polis_err_stripe2");
      }
    });
  }

  function handle_POST_stripe_cancel(req, res) {
    const uid = req.p.uid;


    getUserInfoForUid2(uid).then((user) => {

      emailBadProblemTime("User cancelled subscription: " + user.email);

      return pg.queryP("select * from stripe_subscriptions where uid = ($1);", [uid]).then((rows) => {
        if (!rows || !rows.length) {
          return fail(res, 500, "polis_err_stripe_cancel_no_subscription_record", err);
        }
        const record = rows[0].stripe_subscription_data;

        stripe.customers.cancelSubscription(record.customer, record.id, (err) => {
          if (err) {
            emailBadProblemTime("User cancel subscription failed: " + user.email);
            return fail(res, 500, "polis_err_stripe_cancel_failed", err);
          }
          return updatePlan(req, res, uid, planCodes.free).then(function() {
            res.json({});
          })
        });
      });
    });
  }

  function handle_POST_charge(req, res) {

    var stripeToken = req.p.stripeToken;
    var stripeEmail = req.p.stripeEmail;
    var uid = req.p.uid;
    var plan = req.p.plan;
    var planCode = planCodes[plan];

    if (plan !== "pp") {
      if (!stripeToken) {
        return fail(res, 500, "polis_err_changing_plan_missing_stripeToken");
      }
      if (!stripeEmail) {
        return fail(res, 500, "polis_err_changing_plan_missing_stripeEmail");
      }
    }

    var updateStripePromise = Promise.resolve();
    if (plan !== "pp") {
      // not a participant pays plan, so we actually have to update stripe.
      getUserInfoForUid2(uid).then(function(user) {
        return updateStripePlan(user, stripeToken, stripeEmail, plan);
      });
    }

    updateStripePromise.then(function() {
      return updatePlanOld(req, res, uid, planCode, true);
    }).catch(function(err) {
      if (err) {
        if (err.type === 'StripeCardError') {
          return fail(res, 500, "polis_err_stripe_card_declined", err);
        } else {
          return fail(res, 500, "polis_err_stripe", err);
        }
      }
    });
  }

  function _getCommentsForModerationList(o) {
    var strictCheck = Promise.resolve(null);
    var include_voting_patterns = o.include_voting_patterns;

    if (o.modIn) {
      strictCheck = pg.queryP("select strict_moderation from conversations where zid = ($1);", [o.zid]).then((c) => {
        return o.strict_moderation;
      });
    }

    return strictCheck.then((strict_moderation) => {

      let modClause = "";
      let params = [o.zid];
      if (!_.isUndefined(o.mod)) {
        modClause = " and comments.mod = ($2)";
        params.push(o.mod);
      } else if (!_.isUndefined(o.mod_gt)) {
        modClause = " and comments.mod > ($2)";
        params.push(o.mod_gt);
      } else if (!_.isUndefined(o.modIn)) {
        if (o.modIn === true) {
          if (strict_moderation) {
            modClause = " and comments.mod > 0";
          } else {
            modClause = " and comments.mod >= 0";
          }
        } else if (o.modIn === false) {
          if (strict_moderation) {
            modClause = " and comments.mod <= 0";
          } else {
            modClause = " and comments.mod < 0";
          }
        }
      }
      if (!include_voting_patterns) {
        return pg.queryP_metered_readOnly("_getCommentsForModerationList", "select * from comments where comments.zid = ($1)" + modClause, params);
      }

      return pg.queryP_metered_readOnly("_getCommentsForModerationList", "select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)" + modClause, params).then((rows) => {

        // each comment will have up to three rows. merge those into one with agree/disagree/pass counts.
        let adp = {};
        for (let i = 0; i < rows.length; i++) {
          let row = rows[i];
          let o = adp[row.tid] = adp[row.tid] || {
            agree_count: 0,
            disagree_count: 0,
            pass_count: 0,
          };
          if (row.vote === polisTypes.reactions.pull) {
            o.agree_count = Number(row.count);
          } else if (row.vote === polisTypes.reactions.push) {
            o.disagree_count = Number(row.count);
          } else if (row.vote === polisTypes.reactions.pass) {
            o.pass_count = Number(row.count);
          }
        }
        rows = _.uniq(rows, false, (row) => {
          return row.tid;
        });

        for (let i = 0; i < rows.length; i++) {
          let row = rows[i];
          row.agree_count = adp[row.tid].agree_count;
          row.disagree_count = adp[row.tid].disagree_count;
          row.pass_count = adp[row.tid].pass_count;
          row.count = row.agree_count + row.disagree_count + row.pass_count;
        }
        return rows;
      });
    });
  }

  function _getCommentsList(o) {
    return new MPromise("_getCommentsList", function(resolve, reject) {
      getConversationInfo(o.zid).then(function(conv) {

        let q = sql_comments.select(sql_comments.star())
          .where(
            sql_comments.zid.equals(o.zid)
          );
        if (!_.isUndefined(o.pid)) {
          q = q.and(sql_comments.pid.equals(o.pid));
        }
        if (!_.isUndefined(o.tids)) {
          q = q.and(sql_comments.tid.in(o.tids));
        }
        if (!_.isUndefined(o.mod)) {
          q = q.and(sql_comments.mod.equals(o.mod));
        }
        if (!_.isUndefined(o.not_voted_by_pid)) {
          // 'SELECT * FROM comments WHERE zid = 12 AND tid NOT IN (SELECT tid FROM votes WHERE pid = 1);'
          // Don't return comments the user has already voted on.
          q = q.and(
            sql_comments.tid.notIn(
              sql_votes_latest_unique.subQuery().select(sql_votes_latest_unique.tid)
              .where(
                sql_votes_latest_unique.zid.equals(o.zid)
              ).and(
                sql_votes_latest_unique.pid.equals(o.not_voted_by_pid)
              )
            )
          );
        }

        if (!_.isUndefined(o.withoutTids)) {
          q = q.and(sql_comments.tid.notIn(o.withoutTids));
        }
        if (o.moderation) {

        } else {
          q = q.and(sql_comments.active.equals(true));
          if (conv.strict_moderation) {
            q = q.and(sql_comments.mod.equals(polisTypes.mod.ok));
          } else {
            q = q.and(sql_comments.mod.notEquals(polisTypes.mod.ban));
          }
        }

        q = q.and(sql_comments.velocity.gt(0)); // filter muted comments

        if (!_.isUndefined(o.random)) {
          if (conv.prioritize_seed) {
            q = q.order("is_seed desc, random()");
          } else {
            q = q.order("random()");
          }
        } else {
          q = q.order(sql_comments.created);
        }
        if (!_.isUndefined(o.limit)) {
          q = q.limit(o.limit);
        } else {
          q = q.limit(999); // TODO paginate
        }
        return pg.queryP(q.toString(), [], function(err, docs) {
          if (err) {
            reject(err);
            return;
          }
          if (docs.rows && docs.rows.length) {
            resolve(docs.rows);
          } else {
            resolve([]);
          }
        });
      });
    });
  }

  function getNumberOfCommentsRemaining(zid, pid) {
    return pg.queryP("with " +
      "v as (select * from votes_latest_unique where zid = ($1) and pid = ($2)), " +
      "c as (select * from get_visible_comments($1)), " +
      "remaining as (select count(*) as remaining from c left join v on c.tid = v.tid where v.vote is null), " +
      "total as (select count(*) as total from c) " +
      "select cast(remaining.remaining as integer), cast(total.total as integer), cast(($2) as integer) as pid from remaining, total;", [zid, pid]);
  }


  function getComments(o) {
    let commentListPromise = o.moderation ? _getCommentsForModerationList(o) : _getCommentsList(o);
    let convPromise = getConversationInfo(o.zid);
    let conv = null;
    return Promise.all([convPromise, commentListPromise]).then(function(a) {
      let rows = a[1];
      conv = a[0];
      let cols = [
        "txt",
        "tid",
        "created",
        "uid",
        "tweet_id",
        "quote_src_url",
        "anon",
        "is_seed",
        "is_meta",
        "lang",
        "pid",
      ];
      if (o.moderation) {
        cols.push("velocity");
        cols.push("zid");
        cols.push("mod");
        cols.push("active");
        cols.push("agree_count"); //  in  moderation queries, we join in the vote count
        cols.push("disagree_count"); //  in  moderation queries, we join in the vote count
        cols.push("pass_count"); //  in  moderation queries, we join in the vote count
        cols.push("count"); //  in  moderation queries, we join in the vote count
      }
      rows = rows.map(function(row) {
        let x = _.pick(row, cols);
        if (!_.isUndefined(x.count)) {
          x.count = Number(x.count);
        }
        return x;
      });
      return rows;
    }).then(function(comments) {

      let include_social = !conv.is_anon && o.include_social;

      if (include_social) {
        let nonAnonComments = comments.filter(function(c) {
          return !c.anon && !c.is_seed;
        });
        let uids = _.pluck(nonAnonComments, "uid");
        return getSocialInfoForUsers(uids, o.zid).then(function(socialInfos) {
          let uidToSocialInfo = {};
          socialInfos.forEach(function(info) {
            // whitelist properties to send
            let infoToReturn = _.pick(info, [
              // fb
              "fb_name",
              "fb_link",
              "fb_user_id",
              // twitter
              "name",
              "screen_name",
              "twitter_user_id",
              "profile_image_url_https",
              "followers_count",
              // xInfo
              "x_profile_image_url",
              "x_name",
            ]);
            infoToReturn.tw_verified = !!info.verified;
            infoToReturn.tw_followers_count = info.followers_count;

            // extract props from fb_public_profile
            if (info.fb_public_profile) {
              try {
                let temp = JSON.parse(info.fb_public_profile);
                infoToReturn.fb_verified = temp.verified;
              } catch (e) {
                console.error("error parsing JSON of fb_public_profile for uid: ", info.uid);
              }
            }

            if (!_.isUndefined(infoToReturn.fb_user_id)) {
              let width = 40;
              let height = 40;
              infoToReturn.fb_picture = `https://graph.facebook.com/v2.2/${infoToReturn.fb_user_id}/picture?width=${width}&height=${height}`;
            }

            uidToSocialInfo[info.uid] = infoToReturn;
          });
          return comments.map(function(c) {
            let s = uidToSocialInfo[c.uid];
            if (s) {
              if (!c.anon) { // s should be undefined in this case, but adding a double-check here in case.
                c.social = s;
              }
            }
            return c;
          });
        });
      } else {
        return comments;
      }
    }).then(function(comments) {
      comments.forEach(function(c) {
        delete c.uid;
        delete c.anon;
      });
      return comments;
    });
  }

  
 //  Rename column 'zid' to 'conversation_id', add a new column called 'zid' and have that be a VARCHAR of limited length.
 //  Use conversation_id internally, refactor math poller to use conversation_id
 //  continue to use zid externally, but it will be a string of limited length
 //  Don't expose the conversation_id to the client.

 //  plan:
 //  add the new column conversation_id, copy values from zid
 //  change the code to look things up by conversation_id

  



  function handle_GET_participation(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let strict = req.p.strict;
    isOwner(zid, uid).then(function(ok) {
      if (!ok) {
        fail(res, 403, "polis_err_get_participation_auth");
        return;
      }

      return Promise.all([
        pg.queryP_readOnly("select pid, count(*) from votes where zid = ($1) group by pid;", [zid]),
        pg.queryP_readOnly("select pid, count(*) from comments where zid = ($1) group by pid;", [zid]),
        getXids(zid), //pg.queryP_readOnly("select pid, xid from xids inner join (select * from participants where zid = ($1)) as p on xids.uid = p.uid;", [zid]),
      ]).then(function(o) {
        let voteCountRows = o[0];
        let commentCountRows = o[1];
        let pidXidRows = o[2];
        let i, r;

        if (strict && !pidXidRows.length) {
          fail(res, 409, "polis_err_get_participation_missing_xids This conversation has no xids for its participants.");
          return;
        }

        // Build a map like this {xid -> {votes: 10, comments: 2}}
        let result = new DD(function() {
          return {
            votes: 0,
            comments: 0,
          };
        });

        // Count votes
        for (i = 0; i < voteCountRows.length; i++) {
          r = voteCountRows[i];
          result.g(r.pid).votes = Number(r.count);
        }
        // Count comments
        for (i = 0; i < commentCountRows.length; i++) {
          r = commentCountRows[i];
          result.g(r.pid).comments = Number(r.count);
        }

        // convert from DD to POJO
        result = result.m;

        if (pidXidRows && pidXidRows.length) {
          // Convert from {pid -> foo} to {xid -> foo}
          let pidToXid = {};
          for (i = 0; i < pidXidRows.length; i++) {
            pidToXid[pidXidRows[i].pid] = pidXidRows[i].xid;
          }
          let xidBasedResult = {};
          let size = 0;
          _.each(result, function(val, key) {
            xidBasedResult[pidToXid[key]] = val;
            size += 1;
          });

          if (strict && (commentCountRows.length || voteCountRows.length) && size > 0) {
            fail(res, 409, "polis_err_get_participation_missing_xids This conversation is missing xids for some of its participants.");
            return;
          }
          res.status(200).json(xidBasedResult);
        } else {
          res.status(200).json(result);
        }

      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_participation_misc", err);
    });
  }


  function getAgeRange(demo) {
    var currentYear = (new Date()).getUTCFullYear();
    var birthYear = demo.ms_birth_year_estimate_fb;
    if (_.isNull(birthYear) || _.isUndefined(birthYear) || _.isNaN(birthYear)) {
      return "?";
    }
    var age = currentYear - birthYear;
    if (age < 12) {
      return "0-11";
    } else if (age < 18) {
      return "12-17";
    } else if (age < 25) {
      return "18-24";
    } else if (age < 35) {
      return "25-34";
    } else if (age < 45) {
      return "35-44";
    } else if (age < 55) {
      return "45-54";
    } else if (age < 65) {
      return "55-64";
    } else {
      return "65+";
    }
  }

  // 0 male, 1 female, 2 other, or NULL
  function getGender(demo) {
    var gender = demo.fb_gender;
    if (_.isNull(gender) || _.isUndefined(gender)) {
      gender = demo.ms_gender_estimate_fb;
    }
    return gender;
  }




  function getDemographicsForVotersOnComments(zid, comments) {
    function isAgree(v) {
      return v.vote === polisTypes.reactions.pull;
    }
    function isDisgree(v) {
      return v.vote === polisTypes.reactions.push;
    }
    function isPass(v) {
      return v.vote === polisTypes.reactions.pass;
    }

    function isGenderMale(demo) {
      return demo.gender === 0;
    }
    function isGenderFemale(demo) {
      return demo.gender === 1;
    }
    function isGenderUnknown(demo) {
      var gender = demo.gender;
      return gender !== 0 && gender !== 1;
    }

    return Promise.all([
      pg.queryP("select pid,tid,vote from votes_latest_unique where zid = ($1);", [zid]),
      pg.queryP("select p.pid, d.* from participants p left join demographic_data d on p.uid = d.uid where p.zid = ($1);", [zid]),
    ]).then((a) => {
      var votes = a[0];
      var demo = a[1];


      demo = demo.map((d) => {
        return {
          pid: d.pid,
          gender: getGender(d),
          ageRange: getAgeRange(d),
        };
      });
      var demoByPid = _.indexBy(demo, "pid");

      votes = votes.map((v) => {
        return _.extend(v, demoByPid[v.pid]);
      });

      var votesByTid = _.groupBy(votes, "tid");

      // TODO maybe we should actually look at gender, then a/d/p %
      // TODO maybe we should actually look at each age range, then a/d/p %
      // that will be more natrual in cases of unequal representation

      return comments.map((c) => {
        var votesForThisComment =  votesByTid[c.tid];

        if (!votesForThisComment || !votesForThisComment.length) {
          console.log("skipping");
          // console.log(votesForThisComment);
          return c;
        }

        var agrees = votesForThisComment.filter(isAgree);
        var disagrees = votesForThisComment.filter(isDisgree);
        var passes = votesForThisComment.filter(isPass);

        var votesByAgeRange = _.groupBy(votesForThisComment, "ageRange");

        c.demographics = {
          gender: {
            "m": {
              agree: agrees.filter(isGenderMale).length,
              disagree: disagrees.filter(isGenderMale).length,
              pass: passes.filter(isGenderMale).length,
            },
            "f": {
              agree: agrees.filter(isGenderFemale).length,
              disagree: disagrees.filter(isGenderFemale).length,
              pass: passes.filter(isGenderFemale).length,
            },
            "?": {
              agree: agrees.filter(isGenderUnknown).length,
              disagree: disagrees.filter(isGenderUnknown).length,
              pass: passes.filter(isGenderUnknown).length,
            },
          },
          // TODO return all age ranges even if zero.
          age: _.mapObject(votesByAgeRange, (votes, ageRange) => {
            var o = _.countBy(votes, "vote");
            return {
              agree: o[polisTypes.reactions.pull],
              disagree: o[polisTypes.reactions.push],
              pass: o[polisTypes.reactions.pass],
            };
          }),
        };
        return c;
      });
    });
  }

  function translateAndStoreComment(zid, tid, txt, lang) {
    if (useTranslateApi) {
      return translateString(txt, lang).then((results) => {
        const translation = results[0];
        const src = -1; // Google Translate of txt with no added context
        return pg.queryP("insert into comment_translations (zid, tid, txt, lang, src) values ($1, $2, $3, $4, $5) returning *;", [zid, tid, translation, lang, src]).then((rows) => {
          return rows[0];
        });
      });
    }
    return Promise.resolve(null);
  }


  function handle_GET_comments_translations(req, res) {
    const zid = req.p.zid;
    const tid = req.p.tid;
    const firstTwoCharsOfLang = req.p.lang.substr(0,2);

    getComment(zid, tid).then((comment) => {
      return pg.queryP("select * from comment_translations where zid = ($1) and tid = ($2) and lang LIKE '$3%';", [zid, tid, firstTwoCharsOfLang]).then((existingTranslations) => {
        if (existingTranslations) {
          return existingTranslations;
        }
        return translateAndStoreComment(zid, tid, comment.txt, req.p.lang);
      }).then((rows) => {
        res.status(200).json(rows || []);
      });
    }).catch((err) => {
      fail(res, 500, "polis_err_get_comments_translations", err);
    });
  }

  function handle_GET_comments(req, res) {

    let rid = req.headers["x-request-id"] + " " + req.headers['user-agent'];
    winston.log("info", "getComments " + rid + " begin");

    const isReportQuery = !_.isUndefined(req.p.rid);

    getComments(req.p).then(function(comments) {
      if (req.p.rid ) {
        return pg.queryP("select tid, selection from report_comment_selections where rid = ($1);", [req.p.rid]).then((selections) => {
          let tidToSelection = _.indexBy(selections, "tid");
          comments = comments.map((c) => {
            c.includeInReport = tidToSelection[c.tid] && tidToSelection[c.tid].selection > 0;
            return c;
          });
          return comments;
        });
      } else {
        return comments;
      }

    }).then(function(comments) {

      comments = comments.map(function(c) {
        let hasTwitter = c.social && c.social.twitter_user_id;
        if (hasTwitter) {
          c.social.twitter_profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + c.social.twitter_user_id;
        }
        let hasFacebook = c.social && c.social.fb_user_id;
        if (hasFacebook) {
          let width = 40;
          let height = 40;
          c.social.fb_picture = `https://graph.facebook.com/v2.2/${c.social.fb_user_id}/picture?width=${width}&height=${height}`;
        }
        return c;
      });

      if (req.p.include_demographics) {
        isModerator(req.p.zid, req.p.uid).then((owner) => {
          if (owner || isReportQuery) {
            return getDemographicsForVotersOnComments(req.p.zid, comments).then((commentsWithDemographics) => {
              finishArray(res, commentsWithDemographics);
            }).catch((err) => {
              fail(res, 500, "polis_err_get_comments3", err);
            });
          } else {
            fail(res, 500, "polis_err_get_comments_permissions");
          }
        }).catch((err) => {
          fail(res, 500, "polis_err_get_comments2", err);
        });
      } else {
        finishArray(res, comments);
      }
    }).catch(function(err) {
      winston.log("info", "getComments " + rid + " failed");
      fail(res, 500, "polis_err_get_comments", err);
    });
  } // end GET /api/v3/comments


  function isDuplicateKey(err) {
    let isdup = err.code === 23505 ||
      err.code === '23505' ||
      err.sqlState === 23505 ||
      err.sqlState === '23505' ||
      (err.messagePrimary && err.messagePrimary.includes("duplicate key value"));
    return isdup;
  }

  function failWithRetryRequest(res) {
    res.setHeader('Retry-After', 0);
    console.warn(57493875);
    res.writeHead(500).send(57493875);
  }

  function getNumberOfCommentsWithModerationStatus(zid, mod) {
    return new MPromise("getNumberOfCommentsWithModerationStatus", function(resolve, reject) {
      pgQuery_readOnly("select count(*) from comments where zid = ($1) and mod = ($2);", [zid, mod], function(err, result) {
        if (err) {
          reject(err);
        } else {
          let count = result && result.rows && result.rows[0] && result.rows[0].count;
          count = Number(count);
          if (isNaN(count)) {
            count = void 0;
          }
          resolve(count);
        }
      });
    });
  }

  function sendCommentModerationEmail(req, uid, zid, unmoderatedCommentCount) {
    if (_.isUndefined(unmoderatedCommentCount)) {
      unmoderatedCommentCount = "";
    }
    let body = unmoderatedCommentCount;
    if (unmoderatedCommentCount === 1) {
      body += " Statement is waiting for your review here: ";
    } else {
      body += " Statements are waiting for your review here: ";
    }

    getZinvite(zid).catch(function(err) {
      console.error(err);
      yell("polis_err_getting_zinvite");
      return void 0;
    }).then(function(zinvite) {

      // NOTE: the counter goes in the email body so it doesn't create a new email thread (in Gmail, etc)

      body += createProdModerationUrl(zinvite);

      body += "\n\nThank you for using Polis.";

      // NOTE: adding a changing element (date) at the end to prevent gmail from thinking the URL is a signature, and hiding it. (since the URL doesn't change between emails, Gmail tries to be smart, and hides it)
      // "Sent: " + Date.now() + "\n";

      // NOTE: Adding zid to the subject to force the email client to create a new email thread.
      return sendEmailByUid(uid, `Waiting for review (conversation ${zinvite})`, body);
    }).catch(function(err) {
      console.error(err);
    });
  }

  function createProdModerationUrl(zinvite) {
    return "https://pol.is/m/" + zinvite;
  }

  function createModerationUrl(req, zinvite) {
    let server = devMode ? "http://localhost:5000" : "https://pol.is";

    if (req.headers.host.includes("preprod.pol.is")) {
      server = "https://preprod.pol.is";
    }
    let url = server + "/m/" + zinvite;
    return url;
  }

  // function createMuteUrl(zid, tid) {
  //     let server = devMode ? "http://localhost:5000" : "https://pol.is";
  //     let params = {
  //         zid: zid,
  //         tid: tid
  //     };
  //     let path = "v3/mute";
  //     params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);
  //     return server + "/"+path+"?" + paramsToStringSortedByName(params);
  // }

  // function createUnmuteUrl(zid, tid) {
  //     let server = devMode ? "http://localhost:5000" : "https://pol.is";
  //     let params = {
  //         zid: zid,
  //         tid: tid
  //     };
  //     let path = "v3/unmute";
  //     params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);
  //     return server + "/"+path+"?" + paramsToStringSortedByName(params);
  // }

  function moderateComment(zid, tid, active, mod, is_meta) {
    return new Promise(function(resolve, reject) {
      pg.queryP("UPDATE COMMENTS SET active=($3), mod=($4), modified=now_as_millis(), is_meta = ($5) WHERE zid=($1) and tid=($2);", [zid, tid, active, mod, is_meta], function(err) {
        if (err) {
          reject(err);
        } else {

          // TODO an optimization would be to only add the task when the comment becomes visible after the mod.
          addNotificationTask(zid);

          resolve();
        }
      });
    });
  }

  function getComment(zid, tid) {
    return pg.queryP("select * from comments where zid = ($1) and tid = ($2);", [zid, tid]).then((rows) => {
      return (rows && rows[0]) || null;
    });
  }


  // function muteComment(zid, tid) {
  //     let mod = polisTypes.mod.ban;
  //     return moderateComment(zid, tid, false, mod);
  // }
  // function unmuteComment(zid, tid) {
  //     let mod = polisTypes.mod.ok;
  //     return moderateComment(zid, tid, true, mod);
  // }

  // function handle_GET_mute(req, res) {
  //     let tid = req.p.tid;
  //     let zid = req.p.zid;
  //     let params = {
  //         zid: req.p.zid,
  //         tid: req.p.tid,
  //         signature: req.p[HMAC_SIGNATURE_PARAM_NAME],
  //     };
  //     winston.log("info","mute", 1);
  //     verifyHmacForQueryParams("v3/mute", params).catch(function() {
  //     winston.log("info","mute", 2);
  //         fail(res, 403, "polis_err_signature_mismatch");
  //     }).then(function() {
  //     winston.log("info","mute", 3);
  //         return muteComment(zid, tid);
  //     }).then(function() {
  //     winston.log("info","mute", 4);
  //         return getComment(zid, tid);
  //     }).then(function(c) {
  //     winston.log("info","mute", 5);
  //         res.set('Content-Type', 'text/html');
  //         res.send(
  //             "<h1>muted tid: "+c.tid+" zid:" + c.zid + "</h1>" +
  //             "<p>" + c.txt + "</p>" +
  //             "<a href=\"" + createUnmuteUrl(zid, tid) + "\">Unmute this comment.</a>"
  //         );
  //     }).catch(function(err) {
  //     winston.log("info","mute", 6);
  //         fail(res, 500, err);
  //     });
  // }

  // function handle_GET_unmute(req, res) {
  //     let tid = req.p.tid;
  //     let zid = req.p.zid;
  //     let params = {
  //         zid: req.p.zid,
  //         tid: req.p.tid,
  //         signature: req.p[HMAC_SIGNATURE_PARAM_NAME],
  //     };
  //     verifyHmacForQueryParams("v3/unmute", params).catch(function() {
  //         fail(res, 403, "polis_err_signature_mismatch");
  //     }).then(function() {
  //         return unmuteComment(zid, tid);
  //     }).then(function() {
  //         return getComment(zid, tid);
  //     }).then(function(c) {
  //         res.set('Content-Type', 'text/html');
  //         res.send(
  //             "<h1>unmuted tid: "+c.tid+" zid:" + c.zid + "</h1>" +
  //             "<p>" + c.txt + "</p>" +
  //             "<a href=\"" + createMuteUrl(zid, tid) + "\">Mute this comment.</a>"
  //         );
  //     }).catch(function(err) {
  //         fail(res, 500, err);
  //     });
  // }


  function hasBadWords(txt) {
    txt = txt.toLowerCase();
    let tokens = txt.split(" ");
    for (var i = 0; i < tokens.length; i++) {
      if (badwords[tokens[i]]) {
        return true;
      }
    }
    return false;
  }



  function commentExists(zid, txt) {
    return pg.queryP("select zid from comments where zid = ($1) and txt = ($2);", [zid, txt]).then(function(rows) {
      return rows && rows.length;
    });
  }

  function handle_POST_comments_slack(req, res) {
    const slack_team = req.p.slack_team;
    const slack_user_id = req.p.slack_user_id;


    pg.queryP("select * from slack_users where slack_team = ($1) and slack_user_id = ($2);", [slack_team, slack_user_id]).then((rows) => {
      if (!rows || !rows.length) {
        const uidPromise = createDummyUser();
        return uidPromise.then((uid) => {
          return pg.queryP("insert into slack_users (uid, slack_team, slack_user_id) values ($1, $2, $3) returning *;", [
            uid,
            slack_team,
            slack_user_id,
          ]);
        });
      }
      return rows;
    }).then((slack_user_rows) => {
      return getPidPromise(req.p.zid, req.p.uid, true).then((pid) => {
        if (pid >= 0) {
          req.p.pid = pid
        }
        return slack_user_rows;
      });
    }).then((slack_user_rows) => {
      if (!slack_user_rows || !slack_user_rows.length) {
        fail(res, 500, "polis_err_post_comments_slack_missing_slack_user");
      }
      const uid = slack_user_rows[0].uid;
      req.p.uid = uid;

      handle_POST_comments(req, res);


    }).catch((err) => {
      fail(res, 500, "polis_err_post_comments_slack_misc", err);
    });
  }



  function handle_POST_comments(req, res) {
    let zid = req.p.zid;
    let xid = void 0; //req.p.xid;
    let uid = req.p.uid;
    let txt = req.p.txt;
    let pid = req.p.pid; // PID_FLOW may be undefined
    let currentPid = pid;
    let vote = req.p.vote;
    let twitter_tweet_id = req.p.twitter_tweet_id;
    let quote_twitter_screen_name = req.p.quote_twitter_screen_name;
    let quote_txt = req.p.quote_txt;
    let quote_src_url = req.p.quote_src_url;
    let anon = req.p.anon;
    let is_seed = req.p.is_seed;
    let mustBeModerator = !!quote_txt || !!twitter_tweet_id || anon;

    console.log("POST_comments begin", Date.now());
    console.log("POST_comments params", req.p);

    // either include txt, or a tweet id
    if (
      (_.isUndefined(txt) || txt === '') &&
      (_.isUndefined(twitter_tweet_id) || twitter_tweet_id === '') &&
      (_.isUndefined(quote_txt) || quote_txt === '')
    ) {
      fail(res, 400, "polis_err_param_missing_txt");
      return;
    }

    if (quote_txt && _.isUndefined(quote_src_url)) {
      fail(res, 400, "polis_err_param_missing_quote_src_url");
      return;
    }

    function doGetPid() {

      console.log("POST_comments doGetPid begin", Date.now());

      // PID_FLOW
      if (_.isUndefined(pid)) {
        return getPidPromise(req.p.zid, req.p.uid, true).then((pid) => {
          if (pid === -1) {

            console.log("POST_comments doGetPid addParticipant begin", Date.now());
            return addParticipant(req.p.zid, req.p.uid).then(function(rows) {
              let ptpt = rows[0];
              pid = ptpt.pid;
              currentPid = pid;
              console.log("POST_comments doGetPid addParticipant done", Date.now());
              return pid;
            });
          } else {
            console.log("POST_comments doGetPid done", Date.now());
            return pid;
          }
        });
      }
      console.log("POST_comments doGetPid done", Date.now());
      return Promise.resolve(pid);
    }


    let twitterPrepPromise = Promise.resolve();
    if (twitter_tweet_id) {
      twitterPrepPromise = prepForTwitterComment(twitter_tweet_id, zid);
    } else if (quote_twitter_screen_name) {
      twitterPrepPromise = prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid);
    }

    console.log("POST_comments before twitterPrepPromise", Date.now());

    twitterPrepPromise.then(function(info) {

      console.log("POST_comments after twitterPrepPromise", Date.now());

      let ptpt = info && info.ptpt;
      // let twitterUser = info && info.twitterUser;
      let tweet = info && info.tweet;

      if (tweet) {
        console.log('Post comments tweet', txt, tweet.txt);
        txt = tweet.text;
      } else if (quote_txt) {
        console.log('Post comments quote_txt', txt, quote_txt);
        txt = quote_txt;
      } else {
        console.log('Post comments txt', txt);
      }

      let ip =
        req.headers['x-forwarded-for'] || // TODO This header may contain multiple IP addresses. Which should we report?
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;

      let isSpamPromise = isSpam({
        comment_content: txt,
        comment_author: uid,
        permalink: 'https://pol.is/' + zid,
        user_ip: ip,
        user_agent: req.headers['user-agent'],
        referrer: req.headers.referer,
      });
      isSpamPromise.catch(function(err) {
        console.error("isSpam failed");
        winston.log("info", err);
      });
      // let isSpamPromise = Promise.resolve(false);
      let isModeratorPromise = isModerator(zid, uid);

      let conversationInfoPromise = getConversationInfo(zid);




    // return xidUserPromise.then(function(xidUser) {




      let shouldCreateXidRecord = false;

      let pidPromise;
      if (ptpt) {
        pidPromise = Promise.resolve(ptpt.pid);
      } else {

        let xidUserPromise = !_.isUndefined(xid) && !_.isNull(xid) ? getXidStuff(xid, zid) : Promise.resolve();
        pidPromise = xidUserPromise.then((xidUser) => {
          shouldCreateXidRecord = xidUser === "noXidRecord";
          if (xidUser && xidUser.uid) {
            uid = xidUser.uid;
            pid = xidUser.pid;
            return pid;
          } else {
            return doGetPid().then((pid) => {
              if (shouldCreateXidRecord) {
                return createXidRecordByZid(zid, uid, xid).then(() => {return pid;});
              }
              return pid;
            });
          }
        });
      }

      let commentExistsPromise = commentExists(zid, txt);

      console.log("POST_comments before Promise.all", Date.now());

      return Promise.all([pidPromise, conversationInfoPromise, isModeratorPromise, commentExistsPromise]).then(function(results) {

        console.log("POST_comments after Promise.all", Date.now());

        let pid = results[0];
        let conv = results[1];
        let is_moderator = results[2];
        let commentExists = results[3];

        if (!is_moderator && mustBeModerator) {
          fail(res, 403, "polis_err_post_comment_auth");
          return;
        }

        if (pid < 0) {
          // NOTE: this API should not be called in /demo mode
          fail(res, 500, "polis_err_post_comment_bad_pid");
          return;
        }

        if (commentExists) {
          fail(res, 409, "polis_err_post_comment_duplicate");
          return;
        }

        if (!conv.is_active) {
          fail(res, 403, "polis_err_conversation_is_closed");
          return;
        }

        if (_.isUndefined(txt)) {
          console.log("undefined txt");
          console.log(req.p);
          throw "polis_err_post_comments_missing_txt";
        }
        let bad = hasBadWords(txt);

        console.log("POST_comments before isSpamPromise", Date.now());
        return isSpamPromise.then(function(spammy) {
          winston.log("info", "spam test says: " + txt + " " + (spammy ? "spammy" : "not_spammy"));
          return spammy;
        }, function(err) {
          console.error("spam check failed");
          winston.log("info", err);
          return false; // spam check failed, continue assuming "not spammy".
        }).then(function(spammy) {
          console.log("POST_comments after isSpamPromise", Date.now());
          let velocity = 1;
          let active = true;
          let classifications = [];
          if (bad && conv.profanity_filter) {
            active = false;
            classifications.push("bad");
            console.log("active=false because (bad && conv.profanity_filter)");
          }
          if (spammy && conv.spam_filter) {
            active = false;
            classifications.push("spammy");
            console.log("active=false because (spammy && conv.spam_filter)");
          }
          if (conv.strict_moderation) {
            active = false;
            console.log("active=false because (conv.strict_moderation)");
          }
          if (active) {
            console.log("active=true");
          }

          let mod = 0; // hasn't yet been moderated.

          // moderators' comments are automatically in (when prepopulating).
          if (is_moderator && is_seed) {
            mod = polisTypes.mod.ok;
            active = true;
          }
          let authorUid = ptpt ? ptpt.uid : uid;

          console.log("POST_comments before INSERT INTO COMMENTS", Date.now());

          Promise.all([
            detectLanguage(txt),
          ]).then((a) => {
            let detections = a[0];
            let detection = Array.isArray(detections) ? detections[0] : detections;
            let lang = detection.language;
            let lang_confidence = detection.confidence;

            return pg.queryP(
              "INSERT INTO COMMENTS " +
              "(pid, zid, txt, velocity, active, mod, uid, tweet_id, quote_src_url, anon, is_seed, created, tid, lang, lang_confidence) VALUES " +
              "($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, default, null, $12, $13) RETURNING *;",
              [pid, zid, txt, velocity, active, mod, authorUid, twitter_tweet_id || null, quote_src_url || null, anon || false, is_seed || false, lang, lang_confidence]).then(function(docs) {
                let comment = docs && docs[0];
                let tid = comment && comment.tid;
                // let createdTime = comment && comment.created;

                if (bad || spammy || conv.strict_moderation) {
                  getNumberOfCommentsWithModerationStatus(zid, polisTypes.mod.unmoderated).catch(function(err) {
                    yell("polis_err_getting_modstatus_comment_count");
                    return void 0;
                  }).then(function(n) {
                    if (n === 0) {
                      return;
                    }
                    pg.queryP_readOnly("select * from users where site_id = (select site_id from page_ids where zid = ($1)) UNION select * from users where uid = ($2);", [zid, conv.owner]).then(function(users) {
                      let uids = _.pluck(users, "uid");
                      // also notify polis team for moderation
                      uids = _.union(uids, [
                        125, // mike
                        186, // colin
                        36140, // chris
                      ]);
                      uids.forEach(function(uid) {
                        sendCommentModerationEmail(req, uid, zid, n);
                        sendSlackEvent({
                          type: "comment_mod_needed",
                          data: comment,
                        });
                      });
                    });
                  });
                } else {
                  addNotificationTask(zid);
                  sendCommentModerationEmail(req, 125, zid, "?"); // email mike for all comments, since some people may not have turned on strict moderation, and we may want to babysit evaluation conversations of important customers.
                  sendSlackEvent({
                    type: "comment_mod_needed",
                    data: comment,
                  });
                }

                console.log("POST_comments before votesPost", Date.now());

                // It should be safe to delete this. Was added to postpone the no-auto-vote change for old conversations.
                if (is_seed && _.isUndefined(vote) && zid <= 17037) {
                  vote = 0;
                }

                let createdTime = comment.created;
                let votePromise = _.isUndefined(vote) ? Promise.resolve() : votesPost(uid, pid, zid, tid, vote, 0, false);

                return votePromise.then(function(o) {
                  if (o && o.vote && o.vote.created) {
                    createdTime = o.vote.created;
                  }

                  setTimeout(function() {
                    updateConversationModifiedTime(zid, createdTime);
                    updateLastInteractionTimeForConversation(zid, uid);
                    if (!_.isUndefined(vote)) {
                      updateVoteCount(zid, pid);
                    }
                  }, 100);

                  console.log("POST_comments sending json", Date.now());
                  res.json({
                    tid: tid,
                    currentPid: currentPid,
                  });
                  console.log("POST_comments sent json", Date.now());
                }, function(err) {
                  fail(res, 500, "polis_err_vote_on_create", err);
                });
              }, function(err) {
                if (err.code === '23505' || err.code === 23505) {
                  // duplicate comment
                  fail(res, 409, "polis_err_post_comment_duplicate", err);
                } else {
                  fail(res, 500, "polis_err_post_comment", err);
                }
              }); // insert
          }); // lang
        });
      }, function(errors) {
        if (errors[0]) {
          fail(res, 500, "polis_err_getting_pid", errors[0]);
          return;
        }
        if (errors[1]) {
          fail(res, 500, "polis_err_getting_conv_info", errors[1]);
          return;
        }
      });

    }, function(err) {
      fail(res, 500, "polis_err_fetching_tweet", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_post_comment_misc", err);
    });

    //var rollback = function(client) {
    //pg.queryP('ROLLBACK', function(err) {
    //if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
    //});
    //};
    //pg.queryP('BEGIN;', function(err) {
    //if(err) return rollback(client);
    ////process.nextTick(function() {
    //pg.queryP("SET CONSTRAINTS ALL DEFERRED;", function(err) {
    //if(err) return rollback(client);
    //pg.queryP("INSERT INTO comments (tid, pid, zid, txt, created) VALUES (null, $1, $2, $3, default);", [pid, zid, txt], function(err, docs) {
    //if(err) return rollback(client);
    //pg.queryP('COMMIT;', function(err, docs) {
    //if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
    //var tid = docs && docs[0] && docs[0].tid;
    //// Since the user posted it, we'll submit an auto-pull for that.
    //var autoPull = {
    //zid: zid,
    //vote: polisTypes.reactions.pull,
    //tid: tid,
    //pid: pid
    //};
    ////votesPost(uid, pid, zid, tid, [autoPull]);
    //}); // COMMIT
    //}); // INSERT
    //}); // SET CONSTRAINTS
    ////}); // nextTick
    //}); // BEGIN
  } // end POST /api/v3/comments


  function handle_GET_votes_me(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
      if (err || pid < 0) {
        fail(res, 500, "polis_err_getting_pid", err);
        return;
      }
      pgQuery_readOnly("SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);", [req.p.zid, req.p.pid], function(err, docs) {
        if (err) {
          fail(res, 500, "polis_err_get_votes_by_me", err);
          return;
        }
        for (var i = 0; i < docs.rows.length; i++) {
          docs.rows[i].weight = docs.rows[i].weight / 32767;
        }
        finishArray(res, docs.rows);
      });
    });
  }

  function handle_GET_votes(req, res) {
    getVotesForSingleParticipant(req.p).then(function(votes) {
      finishArray(res, votes);
    }, function(err) {
      fail(res, 500, "polis_err_votes_get", err);
    });
  }

  //function getNextCommentRandomly(zid, pid, withoutTids, include_social) {
    //let params = {
      //zid: zid,
      //not_voted_by_pid: pid,
      //limit: 1,
      //random: true,
      //include_social: include_social,
    //};
    //if (!_.isUndefined(withoutTids) && withoutTids.length) {
      //params.withoutTids = withoutTids;
    //}
    //return getComments(params).then(function(comments) {
      //if (!comments || !comments.length) {
        //return null;
      //} else {
        //let c = comments[0];
        //return getNumberOfCommentsRemaining(zid, pid).then((rows) => {
          //if (!rows || !rows.length) {
            //throw new Error("polis_err_getNumberOfCommentsRemaining_" + zid + "_" + pid);
          //}
          //c.remaining = Number(rows[0].remaining);
          //c.total = Number(rows[0].total);
          //return c;
        //});
      //}
    //});
  //}


  function selectProbabilistically(comments, priorities, nTotal, nRemaining) {
    // Here we go through all of the comments we might select for the user and add their priority values
    let lookup = _.reduce(comments, (o, comment) => {
      // If we like, we can use nTotal and nRemaining here to figure out how much we should emphasize the
      // priority, potentially. Maybe we end up with different classes of priorities lists for this purpose?
      // scaling this value in some way may also be helpful.
      let lookup_val = o.lastCount + (priorities[comment.tid] || 1);
      o.lookup.push([lookup_val, comment]);
      o.lastCount = lookup_val;
      return o;
    },
      {'lastCount': 0, 'lookup': []});
    // We arrange a random number that should fall somewhere in the range of the lookup_vals
    let randomN = Math.random() * lookup.lastCount;
    // Return the first one that has a greater lookup; could eventually replace this with something smarter
    // that does a bisectional lookup if performance becomes an issue. But I want to keep the implementation
    // simple to reason about all other things being equal.
    let result = _.find(lookup.lookup, (x) => x[0] > randomN);
    let c = result[1];
    c.randomN = randomN;
    return c;
  }

  // This very much follows the outline of the random selection above, but factors out the probabilistic logic
  // to the selectProbabilistically fn above.
  function getNextPrioritizedComment(zid, pid, withoutTids, include_social) {
    let params = {
      zid: zid,
      not_voted_by_pid: pid,
      include_social: include_social,
    };
    if (!_.isUndefined(withoutTids) && withoutTids.length) {
      params.withoutTids = withoutTids;
    }
    // What should we set timestamp to below in getPca? Is 0 ok? What triggers updates?
    return Promise.all([getComments(params), getPca(zid, 0), getNumberOfCommentsRemaining(zid, pid)]).then((results) => {
      let comments = results[0];
      let math = results[1];
      let numberOfCommentsRemainingRows = results[2];
      if (!comments || !comments.length) {
        return null;
      } else if (!numberOfCommentsRemainingRows || !numberOfCommentsRemainingRows.length) {
        throw new Error("polis_err_getNumberOfCommentsRemaining_" + zid + "_" + pid);
      }
      let commentPriorities = math ? (math.asPOJO['comment-priorities'] || {}) : {};
      let nTotal = Number(numberOfCommentsRemainingRows[0].total);
      let nRemaining = Number(numberOfCommentsRemainingRows[0].remaining);
      let c = selectProbabilistically(comments, commentPriorities, nTotal, nRemaining);
      c.remaining = nRemaining;
      c.total = nTotal;
      return c;
    });
  }


  // function getNextCommentPrioritizingNonPassedComments(zid, pid, withoutTids) {
  //   if (!withoutTids || !withoutTids.length) {
  //     withoutTids = [-999999]; // ensure there's a value in there so the sql parses as a list
  //   }
  //   let q = "WITH ";
  //   q += "  star_counts AS ";
  //   q += "  (SELECT tid, count(*) as starcount from stars where zid = $1 group by tid), ";
  //   q += "  conv AS  ";
  //   q += "  (SELECT *,";
  //   q += "    CASE WHEN strict_moderation=TRUE then 1 ELSE 0 END as minModVal from conversations where zid = $1),";
  //   q += "  pv AS  ";
  //   q += "  (SELECT tid,  ";
  //   q += "          TRUE AS voted ";
  //   q += "   FROM votes  ";
  //   q += "   WHERE zid = $1 ";
  //   q += "     AND pid = $2 ";
  //   q += "   GROUP BY tid),  ";
  //   q += "     x AS  ";
  //   q += "  (SELECT * ";
  //   q += "   FROM votes_latest_unique($1) ";
  //   q += "   ORDER BY tid),  ";
  //   q += "     a AS  ";
  //   q += "  (SELECT zid,  ";
  //   q += "          tid,  ";
  //   q += "          count(*) ";
  //   q += "   FROM x  ";
  //   q += "   WHERE vote < 0 ";
  //   q += "   GROUP BY zid,  ";
  //   q += "            tid),  ";
  //   q += "     d AS  ";
  //   q += "  (SELECT tid,  ";
  //   q += "          count(*) ";
  //   q += "   FROM x  ";
  //   q += "   WHERE vote > 0 ";
  //   q += "   GROUP BY tid),  ";
  //   q += "     t AS  ";
  //   q += "  (SELECT tid,  ";
  //   q += "          count(*) ";
  //   q += "   FROM x ";
  //   q += "   GROUP BY tid),  ";
  //   q += "     c AS  ";
  //   q += "  (SELECT * ";
  //   q += "   FROM comments  ";
  //   q += "   WHERE zid = $1) ";
  //   q += "SELECT $1 AS zid,  ";
  //   q += "       c.tid,  ";
  //   q += "       (COALESCE(a.count,0.0)+COALESCE(d.count,0.0)) / coalesce(t.count, 1.0) AS nonpass_score,  ";
  //   q += "       pv.voted AS voted,  ";
  //   q += "       c.* ";
  //   q += "FROM c ";
  //   q += "LEFT JOIN d ON c.tid = d.tid ";
  //   q += "LEFT JOIN t ON c.tid = t.tid ";
  //   q += "LEFT JOIN a ON a.zid = c.zid ";
  //   q += "  AND a.tid = c.tid ";
  //   q += "LEFT JOIN pv ON c.tid = pv.tid  ";
  //   q += "LEFT JOIN conv ON c.zid = conv.zid  ";
  //   q += "LEFT JOIN star_counts ON c.tid = star_counts.tid ";
  //   q += "WHERE voted IS NULL ";
  //   q += "  AND c.tid NOT IN (" + withoutTids.join(",") + ") ";
  //   q += "  AND (pv.voted = FALSE OR pv.voted IS NULL)";
  //   q += "  AND c.active = true";
  //   q += "  AND c.mod >= conv.minModVal";
  //   q += "  AND c.velocity > 0";
  //   q += " ORDER BY starcount DESC NULLS LAST, nonpass_score DESC ";
  //   q += " LIMIT 1;";
  //   return pg.queryP_readOnly(q, [zid, pid]).then(function(comments) {
  //     if (!comments || !comments.length) {
  //       return null;
  //     } else {
  //       return comments[0];
  //     }
  //   });
  // }

  function getCommentTranslations(zid, tid) {
    return pg.queryP("select * from comment_translations where zid = ($1) and tid = ($2);", [zid, tid]);
  }

  function getNextComment(zid, pid, withoutTids, include_social, lang) {
    // return getNextCommentPrioritizingNonPassedComments(zid, pid, withoutTids, !!!!!!!!!!!!!!!!TODO IMPL!!!!!!!!!!!include_social);
    //return getNextCommentRandomly(zid, pid, withoutTids, include_social).then((c) => {
    return getNextPrioritizedComment(zid, pid, withoutTids, include_social).then((c) => {
      if (lang && c) {
        const firstTwoCharsOfLang = lang.substr(0,2);
        return getCommentTranslations(zid, c.tid).then((translations) => {
          c.translations = translations;
          let hasMatch = _.some(translations, (t) => {
            return t.lang.startsWith(firstTwoCharsOfLang);
          });
          if (!hasMatch) {
            return translateAndStoreComment(zid, c.tid, c.txt, lang).then((translation) => {
              if (translation) {
                c.translations.push(translation);
              }
              return c;
            });
          }
          return c;
        });
      } else if (c) {
        c.translations = [];
      }
      return c;
    });
  }

  // NOTE: only call this in response to a vote. Don't call this from a poll, like /api/v3/nextComment
  function addNoMoreCommentsRecord(zid, pid) {
    return pg.queryP("insert into event_ptpt_no_more_comments (zid, pid, votes_placed) values ($1, $2, " +
      "(select count(*) from votes where zid = ($1) and pid = ($2)))", [zid, pid]);
  }



  function handle_GET_nextComment(req, res) {
    if (req.timedout) {
      return;
    }
    // NOTE: I tried to speed up this query by adding db indexes, and by removing queries like getConversationInfo and finishOne.
    //          They didn't help much, at least under current load, which is negligible. pg:diagnose isn't complaining about indexes.
    //      I think the direction to go as far as optimizing this is to asyncronously build up a synced in-ram list of next comments
    //        for each participant, for currently active conversations. (this would probably be a math-poller-esque process on another
    //         hostclass)
    //         Along with this would be to cache in ram info about moderation status of each comment so we can filter before returning a comment.

    getNextComment(req.p.zid, req.p.not_voted_by_pid, req.p.without, req.p.include_social, req.p.lang).then(function(c) {
      if (req.timedout) {
        return;
      }
      if (c) {
        if (!_.isUndefined(req.p.not_voted_by_pid)) {
          c.currentPid = req.p.not_voted_by_pid;
        }
        finishOne(res, c);
      } else {
        let o = {};
        if (!_.isUndefined(req.p.not_voted_by_pid)) {
          o.currentPid = req.p.not_voted_by_pid;
        }
        res.status(200).json(o);
      }
    }, function(err) {
      if (req.timedout) {
        return;
      }
      fail(res, 500, "polis_err_get_next_comment2", err);
    }).catch(function(err) {
      if (req.timedout) {
        return;
      }
      fail(res, 500, "polis_err_get_next_comment", err);
    });
  }


  function handle_GET_participationInit(req, res) {

    // let qs = {
    //   conversation_id: req.p.conversation_id,
    // };

    // let nextCommentQs = Object.assign({}, qs, {
    //   not_voted_by_pid: "mypid",
    //   limit: 1,
    //   include_social: true,
    // });

    // let votesByMeQs = Object.assign({}, req.p, {
    //   pid: "mypid",
    // });

    // let famousQs = req.p.ptptoiLimit ? Object.assign({}, qs, {
    //   ptptoiLimit: req.p.ptptoiLimit,
    // }) : qs;

    // function getIfConv() {
    //   if (qs.conversation_id) {
    //     return request.get.apply(request, arguments);
    //   } else {
    //     return Promise.resolve("null");
    //   }
    // }

    // function getIfConvAndAuth() {
    //   if (req.p.uid) {
    //     return getIfConv.apply(0, arguments);
    //   } else {
    //     return Promise.resolve("null");
    //   }
    // }

    // function getWith304AsSuccess() {
    //   return getIfConv.apply(0, arguments).catch(function(foo) {
    //     if (foo.statusCode === 304) {
    //       return "null";
    //     } else {
    //       throw foo;
    //     }
    //   });
    // }

    function ifConv(f, args) {
      if (req.p.conversation_id) {
        return f.apply(null, args);
      } else {
        return Promise.resolve(null);
      }
    }

    function ifConvAndAuth(f, args) {
      if (req.p.uid) {
        return ifConv(f, args);
      } else {
        return Promise.resolve(null);
      }
    }

    let acceptLanguage = req.headers["accept-language"] || req.headers["Accept-Language"] || "en-US";

    if (req.p.lang === "acceptLang") {
      // "en-US,en;q=0.8,da;q=0.6,it;q=0.4,es;q=0.2,pt-BR;q=0.2,pt;q=0.2" --> "en-US"
      // req.p.lang = acceptLanguage.match("^[^,;]*")[0];
      req.p.lang = acceptLanguage.substr(0,2);
    }

    getPermanentCookieAndEnsureItIsSet(req, res);

    Promise.all([
      // request.get({uri: "http://" + SELF_HOSTNAME + "/api/v3/users", qs: qs, headers: req.headers, gzip: true}),
      getUser(req.p.uid, req.p.zid, req.p.xid, req.p.owner_uid),
      // getIfConvAndAuth({uri: "http://" + SELF_HOSTNAME + "/api/v3/participants", qs: qs, headers: req.headers, gzip: true}),
      ifConvAndAuth(getParticipant, [req.p.zid, req.p.uid]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/nextComment", qs: nextCommentQs, headers: req.headers, gzip: true}),
      ifConv(getNextComment, [req.p.zid, req.p.pid, [], true, req.p.lang]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/conversations", qs: qs, headers: req.headers, gzip: true}),
      ifConv(getOneConversation, [req.p.zid, req.p.uid, req.p.lang]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/votes", qs: votesByMeQs, headers: req.headers, gzip: true}),
      ifConv(getVotesForSingleParticipant, [req.p]),
      ifConv(getPca, [req.p.zid, -1]),
      // getWith304AsSuccess({uri: "http://" + SELF_HOSTNAME + "/api/v3/math/pca2", qs: qs, headers: req.headers, gzip: true}),
      ifConv(doFamousQuery, [req.p, req]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/votes/famous", qs: famousQs, headers: req.headers, gzip: true}),
    ]).then(function(arr) {
      let conv = arr[3];
      let o = {
        user: arr[0],
        ptpt: arr[1],
        nextComment: arr[2],
        conversation: conv,
        votes: arr[4] || [],
        pca: arr[5] ? (arr[5].asJSON ? arr[5].asJSON : null) : null,
        famous: arr[6],
        // famous: JSON.parse(arr[6]),
        acceptLanguage: acceptLanguage,
      };
      if (o.conversation) {
        delete o.conversation.zid;
        o.conversation.conversation_id = req.p.conversation_id;
      }
      if (o.ptpt) {
        delete o.ptpt.zid;
      }
      for (var i = 0; i < o.votes.length; i++) {
        delete o.votes[i].zid; // strip zid for security
        // delete o.votes[i].pid; // because it's extra crap. Feel free to delete this line if you need pid.
      }
      if (!o.nextComment) {
        o.nextComment = {};
      }
      if (!_.isUndefined(req.p.pid)) {
        o.nextComment.currentPid = req.p.pid;
      }

      res.status(200).json(o);

    }, function(err) {
      console.error(err);
      fail(res, 500, "polis_err_get_participationInit2", err);
    }).catch(function(err) {
      console.error(err);
      fail(res, 500, "polis_err_get_participationInit", err);
    });
  }



  function updateConversationModifiedTime(zid, t) {
    let modified = _.isUndefined(t) ? Date.now() : Number(t);
    let query = "update conversations set modified = ($2) where zid = ($1) and modified < ($2);";
    let params = [zid, modified];
    if (_.isUndefined(t)) {
      query = "update conversations set modified = now_as_millis() where zid = ($1);";
      params = [zid];
    }
    return pg.queryP(query, params);
  }



  function createXidRecordByZid(zid, uid, xid, x_profile_image_url, x_name, x_email) {
    return getConversationInfo(zid).then((conv) => {
      const shouldCreateXidRecord = conv.use_xid_whitelist ? isXidWhitelisted(conv.owner, xid) : Promise.resolve(true);
      return shouldCreateXidRecord.then((should) => {
        if (!should) {
          throw new Error("polis_err_xid_not_whitelisted_2");
        }
        return pg.queryP("insert into xids (owner, uid, xid, x_profile_image_url, x_name, x_email) values ((select org_id from conversations where zid = ($1)), $2, $3, $4, $5, $6) " +
          "on conflict (owner, xid) do nothing;", [
            zid,
            uid,
            xid,
            x_profile_image_url || null,
            x_name || null,
            x_email || null,
          ]);
      });
    });
  }

  function getXidRecord(xid, zid) {
    return pg.queryP("select * from xids where xid = ($1) and owner = (select org_id from conversations where zid = ($2));", [xid, zid]);
  }

  function getXidStuff(xid, zid) {
    return getXidRecord(xid, zid).then((rows) => {
      if (!rows || !rows.length) {
        return "noXidRecord";
      }
      let xidRecordForPtpt = rows[0];
      if (xidRecordForPtpt) {
        return getPidPromise(zid, xidRecordForPtpt.uid, true).then((pidForXid) => {
          xidRecordForPtpt.pid = pidForXid;
          return xidRecordForPtpt;
        });
      }
      return xidRecordForPtpt;
    });
  }

  function handle_PUT_participants_extended(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;

    let fields = {};
    if (!_.isUndefined(req.p.show_translation_activated)) {
      fields.show_translation_activated = req.p.show_translation_activated;
    }

    let q = sql_participants_extended.update(
      fields
    )
    .where(
      sql_participants_extended.zid.equals(zid)
    ).and(
      sql_participants_extended.uid.equals(uid)
    );

    pg.queryP(q.toString(), []).then((result) => {
      res.json(result);
    }).catch((err) => {
      fail(res, 500, "polis_err_put_participants_extended", err);
    });
  }

  function handle_POST_votes(req, res) {
    let uid = req.p.uid; // PID_FLOW uid may be undefined here.
    let zid = req.p.zid;
    let pid = req.p.pid; // PID_FLOW pid may be undefined here.
    let lang = req.p.lang;

    // We allow viewing (and possibly writing) without cookies enabled, but voting requires cookies (except the auto-vote on your own comment, which seems ok)
    let token = req.cookies[COOKIES.TOKEN];
    let apiToken = req.headers.authorization;
    let xPolisHeaderToken = req.headers['x-polis'];
    if (!uid && !token && !apiToken && !xPolisHeaderToken) {
      fail(res, 403, "polis_err_vote_noauth");
      return;
    }

    let permanent_cookie = getPermanentCookieAndEnsureItIsSet(req, res);

    // PID_FLOW WIP for now assume we have a uid, but need a participant record.
    let pidReadyPromise = _.isUndefined(req.p.pid) ? addParticipantAndMetadata(req.p.zid, req.p.uid, req, permanent_cookie).then(function(rows) {
      let ptpt = rows[0];
      pid = ptpt.pid;
    }) : Promise.resolve();


    pidReadyPromise.then(function() {

      // let conv;
      let vote;

      // PID_FLOW WIP for now assume we have a uid, but need a participant record.
      let pidReadyPromise = _.isUndefined(pid) ? addParticipant(zid, uid).then(function(rows) {
        let ptpt = rows[0];
        pid = ptpt.pid;
      }) : Promise.resolve();

      return pidReadyPromise.then(function() {
        return votesPost(uid, pid, zid, req.p.tid, req.p.vote, req.p.weight, true);
      }).then(function(o) {
        // conv = o.conv;
        vote = o.vote;
        let createdTime = vote.created;
        setTimeout(function() {
          updateConversationModifiedTime(zid, createdTime);
          updateLastInteractionTimeForConversation(zid, uid);

          // NOTE: may be greater than number of comments, if they change votes
          updateVoteCount(zid, pid);
        }, 100);
        if (_.isUndefined(req.p.starred)) {
          return;
        } else {
          return addStar(zid, req.p.tid, pid, req.p.starred, createdTime);
        }
      }).then(function() {
        return getNextComment(zid, pid, [], true, lang);
      }).then(function(nextComment) {
        let result = {};
        if (nextComment) {
          result.nextComment = nextComment;
        } else {
          // no need to wait for this to finish
          addNoMoreCommentsRecord(zid, pid);
        }
        // PID_FLOW This may be the first time the client gets the pid.
        result.currentPid = pid;


        // result.shouldMod = true; // TODO
        if (result.shouldMod) {
          result.modOptions = {};
          if (req.p.vote === polisTypes.reactions.pull) {
            result.modOptions.as_important = true;
            result.modOptions.as_factual = true;
            result.modOptions.as_feeling = true;
          } else if (req.p.vote === polisTypes.reactions.push) {
            result.modOptions.as_notmyfeeling = true;
            result.modOptions.as_notgoodidea = true;
            result.modOptions.as_notfact = true;
            result.modOptions.as_abusive = true;
          } else if (req.p.vote === polisTypes.reactions.pass) {
            result.modOptions.as_unsure = true;
            result.modOptions.as_spam = true;
            result.modOptions.as_abusive = true;
          }
        }

        finishOne(res, result);
      });
    }).catch(function(err) {
      if (err === "polis_err_vote_duplicate") {
        fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
      } else if (err === "polis_err_conversation_is_closed") {
        fail(res, 403, "polis_err_conversation_is_closed", err);
      } else if (err === "polis_err_post_votes_social_needed") {
        fail(res, 403, "polis_err_post_votes_social_needed", err);
      } else {
        fail(res, 500, "polis_err_vote", err);
      }
    });
  }



  function handle_POST_ptptCommentMod(req, res) {
    let zid = req.p.zid;
    let pid = req.p.pid;

    let uid = req.p.uid;

    // need('as_important', getBool, assignToP, false),
    // need('as_spam', getBool, assignToP, false),
    // need('as_offtopic', getBool, assignToP, false),



    return pg.queryP("insert into crowd_mod (" +
      "zid, " +
      "pid, " +
      "tid, " +
      "as_abusive, " +
      "as_factual, " +
      "as_feeling, " +
      "as_important, " +
      "as_notfact, " +
      "as_notgoodidea, " +
      "as_notmyfeeling, " +
      "as_offtopic, " +
      "as_spam, " +
      "as_unsure) values (" +
      "$1, " +
      "$2, " +
      "$3, " +
      "$4, " +
      "$5, " +
      "$6, " +
      "$7, " +
      "$8, " +
      "$9, " +
      "$10, " +
      "$11, " +
      "$12, " +
      "$13);",[
        req.p.zid,
        req.p.pid,
        req.p.tid,
        req.p.as_abusive,
        req.p.as_factual,
        req.p.as_feeling,
        req.p.as_important,
        req.p.as_notfact,
        req.p.as_notgoodidea,
        req.p.as_notmyfeeling,
        req.p.as_offtopic,
        req.p.as_spam,
        req.p.unsure,
      ]).then((createdTime) => {
        setTimeout(function() {
          updateConversationModifiedTime(req.p.zid, createdTime);
          updateLastInteractionTimeForConversation(zid, uid);
        }, 100);
      }).then(function() {
        return getNextComment(req.p.zid, pid, [], true, req.p.lang); // TODO req.p.lang is probably not defined
      }).then(function(nextComment) {
        let result = {};
        if (nextComment) {
          result.nextComment = nextComment;
        } else {
          // no need to wait for this to finish
          addNoMoreCommentsRecord(req.p.zid, pid);
        }
        // PID_FLOW This may be the first time the client gets the pid.
        result.currentPid = req.p.pid;
        finishOne(res, result);

      }).catch(function(err) {
        if (err === "polis_err_ptptCommentMod_duplicate") {
          fail(res, 406, "polis_err_ptptCommentMod_duplicate", err); // TODO allow for changing votes?
        } else if (err === "polis_err_conversation_is_closed") {
          fail(res, 403, "polis_err_conversation_is_closed", err);
        } else {
          fail(res, 500, "polis_err_ptptCommentMod", err);
        }
      });
  }



  function handle_POST_upvotes(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;

    pg.queryP("select * from upvotes where uid = ($1) and zid = ($2);", [uid, zid]).then(function(rows) {
      if (rows && rows.length) {
        fail(res, 403, "polis_err_upvote_already_upvoted");
      } else {
        pg.queryP("insert into upvotes (uid, zid) VALUES ($1, $2);", [uid, zid]).then(function() {
          pg.queryP("update conversations set upvotes = (select count(*) from upvotes where zid = ($1)) where zid = ($1);", [zid]).then(function() {
            res.status(200).json({});
          }, function(err) {
            fail(res, 500, "polis_err_upvote_update", err);
          });
        }, function(err) {
          fail(res, 500, "polis_err_upvote_insert", err);
        });
      }
    }, function(err) {
      fail(res, 500, "polis_err_upvote_check", err);
    });
  }


  function addStar(zid, tid, pid, starred, created) {
    starred = starred ? 1 : 0;
    let query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
    let params = [pid, zid, tid, starred];
    if (!_.isUndefined(created)) {
      query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, $5) RETURNING created;";
      params.push(created);
    }
    return pg.queryP(query, params);
  }


  function handle_POST_stars(req, res) {
    addStar(req.p.zid, req.p.tid, req.p.pid, req.p.starred).then(function(result) {
      let createdTime = result.rows[0].created;
      setTimeout(function() {
        updateConversationModifiedTime(req.p.zid, createdTime);
      }, 100);
      res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
    }).catch(function(err) {
      if (err) {
        if (isDuplicateKey(err)) {
          fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
        } else {
          fail(res, 500, "polis_err_vote", err);
        }
      }
    });
  }

  function handle_POST_trashes(req, res) {
    let query = "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
    let params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
    pg.queryP(query, params, function(err, result) {
      if (err) {
        if (isDuplicateKey(err)) {
          fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
        } else {
          fail(res, 500, "polis_err_vote", err);
        }
        return;
      }

      let createdTime = result.rows[0].created;
      setTimeout(function() {
        updateConversationModifiedTime(req.p.zid, createdTime);
      }, 100);

      res.status(200).json({}); // TODO don't stop after the first one, map the inserts to deferreds.
    });
  }


  function verifyMetadataAnswersExistForEachQuestion(zid) {
    let errorcode = "polis_err_missing_metadata_answers";
    return new Promise(function(resolve, reject) {
      pgQuery_readOnly("select pmqid from participant_metadata_questions where zid = ($1);", [zid], function(err, results) {
        if (err) {
          reject(err);
          return;
        }
        if (!results.rows || !results.rows.length) {
          resolve();
          return;
        }
        let pmqids = results.rows.map(function(row) {
          return Number(row.pmqid);
        });
        pgQuery_readOnly(
          "select pmaid, pmqid from participant_metadata_answers where pmqid in (" + pmqids.join(",") + ") and alive = TRUE and zid = ($1);", [zid],
          function(err, results) {
            if (err) {
              reject(err);
              return;
            }
            if (!results.rows || !results.rows.length) {
              reject(new Error(errorcode));
              return;
            }
            let questions = _.reduce(pmqids, function(o, pmqid) {
              o[pmqid] = 1;
              return o;
            }, {});
            results.rows.forEach(function(row) {
              delete questions[row.pmqid];
            });
            if (Object.keys(questions).length) {
              reject(new Error(errorcode));
            } else {
              resolve();
            }
          });
      });
    });
  }

  function handle_PUT_comments(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let tid = req.p.tid;
    let active = req.p.active;
    let mod = req.p.mod;
    let is_meta = req.p.is_meta;

    isModerator(zid, uid).then(function(isModerator) {
      if (isModerator) {
        moderateComment(zid, tid, active, mod, is_meta).then(function() {
          res.status(200).json({});
        }, function(err) {
          fail(res, 500, "polis_err_update_comment", err);
        });
      } else {
        fail(res, 403, "polis_err_update_comment_auth");
      }
    }).catch(function(err) {
      fail(res, 500, "polis_err_update_comment", err);
    });
  }

  function handle_POST_reportCommentSelections(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let rid = req.p.rid;
    let tid = req.p.tid;
    let selection = req.p.include ? 1 : -1;
    isModerator(zid, uid).then((isMod) => {
      if (!isMod) {
        return fail(res, 403, "polis_err_POST_reportCommentSelections_auth");
      }
      return pg.queryP("insert into report_comment_selections (rid, tid, selection, zid, modified) values ($1, $2, $3, $4, now_as_millis()) "+
        "on conflict (rid, tid) do update set selection = ($3), zid  = ($4), modified = now_as_millis();", [rid, tid, selection, zid]).then(() => {

          // The old report isn't valid anymore, so when a user loads the report again a new worker_tasks entry will be created.
          return pg.queryP("delete from math_report_correlationmatrix where rid = ($1);", [rid]);

        }).then(() => {
          res.json({});
        });
    }).catch((err) => {
      fail(res, 500, "polis_err_POST_reportCommentSelections_misc", err);
    });
  }


  // kind of crappy that we're replacing the zinvite.
  // This is needed because we initially create a conversation with the POST, then actually set the properties with the subsequent PUT.
  // if we stop doing that, we can remove this function.
  function generateAndReplaceZinvite(zid, generateShortZinvite) {
    let len = 12;
    if (generateShortZinvite) {
      len = 6;
    }
    return new Promise(function(resolve, reject) {
      generateToken(len, false, function(err, zinvite) {
        if (err) {
          return reject("polis_err_creating_zinvite");
        }
        pg.queryP("update zinvites set zinvite = ($1) where zid = ($2);", [zinvite, zid], function(err, results) {
          if (err) {
            reject(err);
          } else {
            resolve(zinvite);
          }
        });
      });
    });
  }

  function sendGradeForAssignment(oauth_consumer_key, oauth_consumer_secret, params) {

    let replaceResultRequestBody = '' +
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0">' +
      '<imsx_POXHeader>' +
      '<imsx_POXRequestHeaderInfo>' +
      '<imsx_version>V1.0</imsx_version>' +
      '<imsx_messageIdentifier>999999123</imsx_messageIdentifier>' +
      '</imsx_POXRequestHeaderInfo>' +
      '</imsx_POXHeader>' +
      '<imsx_POXBody>' +
      '<replaceResultRequest>' + // parser has???  xml.at_css('imsx_POXBody *:first').name.should == 'replaceResultResponse'
      '<resultRecord>' +
      '<sourcedGUID>' +
      '<sourcedId>' + params.lis_result_sourcedid + '</sourcedId>' +
      '</sourcedGUID>' +
      '<result>' +
      '<resultScore>' +
      '<language>en</language>' + // this is the formatting of the resultScore (for example europe might use a comma. Just stick to en formatting here.)
      '<textString>' + params.gradeFromZeroToOne + '</textString>' +
      '</resultScore>' +
      '</result>' +
      '</resultRecord>' +
      '</replaceResultRequest>' +
      '</imsx_POXBody>' +
      '</imsx_POXEnvelopeRequest>';

    let oauth = new OAuth.OAuth(
      null, //'https://api.twitter.com/oauth/request_token',
      null, //'https://api.twitter.com/oauth/access_token',
      oauth_consumer_key, //'your application consumer key',
      oauth_consumer_secret, //'your application secret',
      '1.0', //'1.0A',
      null,
      'HMAC-SHA1'
    );
    return new Promise(function(resolve, reject) {
      oauth.post(
        params.lis_outcome_service_url, //'https://api.twitter.com/1.1/trends/place.json?id=23424977',
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        replaceResultRequestBody,
        "application/xml",
        function(e, data, res) {
          if (e) {
            winston.log("info", "grades foo failed");
            console.error(e);
            reject(e);
          } else {
            winston.log("info", 'grades foo ok!');
            resolve(params, data);
          }
          // winston.log("info",require('util').inspect(data));
        }
      );
    });
  }

  function sendCanvasGradesIfNeeded(zid, ownerUid) {
    // get the lti_user_ids for participants who voted or commented
    let goodLtiUserIdsPromise = pg.queryP(
      "select lti_user_id from " +
      "(select distinct uid from " +
      "(select distinct pid from votes where zid = ($1) UNION " +
      "select distinct pid from comments where zid = ($1)) as x " +
      "inner join participants p on x.pid = p.pid where p.zid = ($1)) as good_uids " +
      "inner join lti_users on good_uids.uid = lti_users.uid;", [zid]);

    let callbackInfoPromise = pg.queryP(
      "select * from canvas_assignment_conversation_info ai " +
      "inner join canvas_assignment_callback_info ci " +
      "on ai.custom_canvas_assignment_id = ci.custom_canvas_assignment_id " +
      "where ai.zid = ($1);", [zid]);

    let ownerLtiCredsPromise = pg.queryP(
      "select * from lti_oauthv1_credentials where uid = ($1);", [ownerUid]);

    return Promise.all([
      goodLtiUserIdsPromise,
      callbackInfoPromise,
      ownerLtiCredsPromise,
    ]).then(function(results) {
      let isFullPointsEarningLtiUserId = _.indexBy(results[0], "lti_user_id");
      let callbackInfos = results[1];
      if (!callbackInfos || !callbackInfos.length) {
        // TODO may be able to check for scenarios like missing callback infos, where votes and comments and canvas_assignment_conversation_info exist, and then throw an error
        return;
      }
      let ownerLtiCreds = results[2];
      if (!ownerLtiCreds || !ownerLtiCreds.length) {
        throw new Error("polis_err_lti_oauth_credentials_are_missing " + ownerUid);
      }
      ownerLtiCreds = ownerLtiCreds[0];
      if (!ownerLtiCreds.oauth_shared_secret || !ownerLtiCreds.oauth_consumer_key) {
        throw new Error("polis_err_lti_oauth_credentials_are_bad " + ownerUid);
      }

      let promises = callbackInfos.map(function(assignmentCallbackInfo) {
        let gradeFromZeroToOne = isFullPointsEarningLtiUserId[assignmentCallbackInfo.lti_user_id] ? 1.0 : 0.0;
        assignmentCallbackInfo.gradeFromZeroToOne = gradeFromZeroToOne;
        winston.log("info", "grades assigned" + gradeFromZeroToOne + " lti_user_id " + assignmentCallbackInfo.lti_user_id);
        return sendGradeForAssignment(
          ownerLtiCreds.oauth_consumer_key,
          ownerLtiCreds.oauth_shared_secret,
          assignmentCallbackInfo);
      });
      return Promise.all(promises);
    });
  }

  function updateLocalRecordsToReflectPostedGrades(listOfGradingContexts) {
    listOfGradingContexts = listOfGradingContexts || [];
    return Promise.all(listOfGradingContexts.map(function(gradingContext) {
      winston.log("info", "grading set to " + gradingContext.gradeFromZeroToOne);
      return pg.queryP("update canvas_assignment_callback_info set grade_assigned = ($1) where tool_consumer_instance_guid = ($2) and lti_context_id = ($3) and lti_user_id = ($4) and custom_canvas_assignment_id = ($5);", [
        gradingContext.gradeFromZeroToOne,
        gradingContext.tool_consumer_instance_guid,
        gradingContext.lti_context_id,
        gradingContext.lti_user_id,
        gradingContext.custom_canvas_assignment_id,
      ]);
    }));
  }

  function handle_GET_lti_oauthv1_credentials(req, res) {
    let uid = "FOO";
    if (req.p && req.p.uid) {
      uid = req.p.uid;
    }
    Promise.all([
      generateTokenP(40, false),
      generateTokenP(40, false),
    ]).then(function(results) {
      let key = "polis_oauth_consumer_key_" + results[0];
      let secret = "polis_oauth_shared_secret_" + results[1];
      let x = [uid, "'" + key + "'", "'" + secret + "'"].join(",");
      // return the query, they we can manually run this in the pg shell, and email? the keys to the instructor
      res.status(200).json("INSERT INTO lti_oauthv1_credentials (uid, oauth_consumer_key, oauth_shared_secret) values (" + x + ") returning oauth_consumer_key, oauth_shared_secret;");
    });
  }


  function handle_POST_conversation_close(req, res) {
    var q = "select * from conversations where zid = ($1)";
    var params = [req.p.zid];
    if (!isPolisDev(req.p.uid)) {
      q = q + " and owner = ($2)";
      params.push(req.p.uid);
    }
    pg.queryP(q, params).then(function(rows) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      let conv = rows[0];
      // if (conv.is_active) {
      // regardless of old state, go ahead and close it, and update grades. will make testing easier.
      pg.queryP("update conversations set is_active = false where zid = ($1);", [conv.zid]).then(function() {

        if (conv.is_slack) {
          sendSlackEvent({
            type: "closed",
            data: conv,
          });
        }

        // might need to send some grades
        let ownerUid = req.p.uid;
        sendCanvasGradesIfNeeded(conv.zid, ownerUid).then(function(listOfContexts) {
          return updateLocalRecordsToReflectPostedGrades(listOfContexts);
        }).then(function() {
          res.status(200).json({});
        }).catch(function(err) {
          fail(res, 500, "polis_err_closing_conversation_sending_grades", err);
        });
      }).catch(function(err) {
        fail(res, 500, "polis_err_closing_conversation2", err);
      });
      // } else {
      //     // was already closed.
      //     res.status(204).send("");
      // }
    }).catch(function(err) {
      fail(res, 500, "polis_err_closing_conversation", err);
    });
  }

  function handle_POST_conversation_reopen(req, res) {

    var q = "select * from conversations where zid = ($1)";
    var params = [req.p.zid];
    if (!isPolisDev(req.p.uid)) {
      q = q + " and owner = ($2)";
      params.push(req.p.uid);
    }
    pg.queryP(q, params).then(function(rows) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      let conv = rows[0];
      pg.queryP("update conversations set is_active = true where zid = ($1);", [conv.zid]).then(function() {
        if (conv.is_slack) {
          sendSlackEvent({
            type: "reopened",
            data: conv,
          });
        }
        res.status(200).json({});
      }).catch(function(err) {
        fail(res, 500, "polis_err_reopening_conversation2", err);
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_reopening_conversation", err);
    });
  }

  function handle_PUT_users(req, res) {
    let uid = req.p.uid;
    if (isPolisDev(uid) && req.p.uid_of_user) {
      uid = req.p.uid_of_user;
    }

    let fields = {};
    if (!_.isUndefined(req.p.email)) {
      fields.email = req.p.email;
    }
    if (!_.isUndefined(req.p.hname)) {
      fields.hname = req.p.hname;
    }

    let q = sql_users.update(
        fields
      )
      .where(
        sql_users.uid.equals(uid)
      );

    pg.queryP(q.toString(), []).then((result) => {
      res.json(result);
    }).catch((err) => {
      fail(res, 500, "polis_err_put_user", err);
    });
  }

  function handle_PUT_conversations(req, res) {
    let generateShortUrl = req.p.short_url;
    isModerator(req.p.zid, req.p.uid).then(function(ok) {
      if (!ok) {
        fail(res, 403, "polis_err_update_conversation_permission");
        return;
      }

      let verifyMetaPromise;
      if (req.p.verifyMeta) {
        verifyMetaPromise = verifyMetadataAnswersExistForEachQuestion(req.p.zid);
      } else {
        verifyMetaPromise = Promise.resolve();
      }

      let fields = {};
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
      ifDefinedSet("auth_needed_to_vote", req.p, fields);
      ifDefinedSet("auth_needed_to_write", req.p, fields);
      ifDefinedSet("auth_opt_fb", req.p, fields);
      ifDefinedSet("auth_opt_tw", req.p, fields);
      ifDefinedSet("auth_opt_allow_3rdparty", req.p, fields);



      if (!_.isUndefined(req.p.owner_sees_participation_stats)) {
        fields.owner_sees_participation_stats = !!req.p.owner_sees_participation_stats;
      }
      if (!_.isUndefined(req.p.launch_presentation_return_url_hex)) {
        fields.lti_users_only = true;
      }
      if (!_.isUndefined(req.p.link_url)) {
        fields.link_url = req.p.link_url;
      }

      ifDefinedSet("subscribe_type", req.p, fields);

      let q = sql_conversations.update(
          fields
        )
        .where(
          sql_conversations.zid.equals(req.p.zid)
        )
        // .and( sql_conversations.owner.equals(req.p.uid) )
        .returning('*');
      verifyMetaPromise.then(function() {
        pg.queryP(
          q.toString(),
          function(err, result) {
            if (err) {
              fail(res, 500, "polis_err_update_conversation", err);
              return;
            }
            let conv = result && result.rows && result.rows[0];

            let promise = generateShortUrl ?
              generateAndReplaceZinvite(req.p.zid, generateShortUrl) :
              Promise.resolve();
            let successCode = generateShortUrl ? 201 : 200;

            promise.then(function() {

              // send notification email
              if (req.p.send_created_email) {
                Promise.all([getUserInfoForUid2(req.p.uid), getConversationUrl(req, req.p.zid, true)]).then(function(results) {
                  let hname = results[0].hname;
                  let url = results[1];
                  sendEmailByUid(
                      req.p.uid,
                      "Conversation created",
                      "Hi " + hname + ",\n" +
                      "\n" +
                      "Here's a link to the conversation you just created. Use it to invite participants to the conversation. Share it by whatever network you prefer - Gmail, Facebook, Twitter, etc., or just post it to your website or blog. Try it now! Click this link to go to your conversation:" +
                      "\n" +
                      url + "\n" +
                      "\n" +
                      "With gratitude,\n" +
                      "\n" +
                      "The team at pol.is\n"
                    )
                    .catch(function(err) {
                      console.error(err);
                    });
                }).catch(function(err) {
                  yell("polis_err_sending_conversation_created_email");
                  winston.log("info", err);
                });
              }

              if (req.p.launch_presentation_return_url_hex) {
                // conv.lti_redirect = {
                //     return_type: "iframe",
                //     launch_presentation_return_url: hexToStr(req.p.launch_presentation_return_url_hex),
                //     width: 320,
                //     height: 900,
                //     url: getServerNameWithProtocol(req) + "/" + req.p.conversation_id,
                // };

                // using links because iframes are pretty crappy within Canvas assignments.
                let linkText = "pol.is conversation";
                if (req.p.topic) {
                  linkText += " (" + req.p.topic + ")";
                }
                let linkTitle = "";
                if (req.p.description) {
                  linkTitle += req.p.description;
                }
                conv.lti_redirect = {
                  return_type: "url",
                  launch_presentation_return_url: hexToStr(req.p.launch_presentation_return_url_hex),
                  url: getServerNameWithProtocol(req) + "/" + req.p.conversation_id,
                  text: linkText,
                  title: linkTitle,
                  target: "_blank", // Open in a new window.
                };
              }

              if (req.p.custom_canvas_assignment_id) {
                addCanvasAssignmentConversationInfoIfNeeded(
                  req.p.zid,
                  req.p.tool_consumer_instance_guid,
                  req.p.context, // lti_context_id,
                  req.p.custom_canvas_assignment_id).then(function() {
                    finishOne(res, conv, true, successCode);
                  }).catch(function(err) {
                    fail(res, 500, "polis_err_saving_assignment_grading_context", err);
                    emailBadProblemTime("PUT conversation worked, but couldn't save assignment context");
                  });
              } else {
                finishOne(res, conv, true, successCode);
              }

              updateConversationModifiedTime(req.p.zid);

              //     // LTI redirect to create e
              //     // let url = getServerNameWithProtocol(req) + "/" + req.p.conversation_id;
              //     // redirectToLtiEditorDestinationWithDetailsAboutIframe(req, res, req.p.launch_presentation_return_url, url, 320, 900);
              // // } else {
              // finishOne(res, conv);
              // // }

            }).catch(function(err) {
              fail(res, 500, "polis_err_update_conversation", err);
            });
          }
        );
      }, function(err) {
        fail(res, 500, err.message, err);
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_update_conversation", err);
    });
  }

  function handle_DELETE_metadata_questions(req, res) {
    let uid = req.p.uid;
    let pmqid = req.p.pmqid;

    getZidForQuestion(pmqid, function(err, zid) {
      if (err) {
        fail(res, 500, "polis_err_delete_participant_metadata_questions_zid", err);
        return;
      }
      isConversationOwner(zid, uid, function(err) {
        if (err) {
          fail(res, 403, "polis_err_delete_participant_metadata_questions_auth", err);
          return;
        }

        deleteMetadataQuestionAndAnswers(pmqid, function(err) {
          if (err) {
            fail(res, 500, "polis_err_delete_participant_metadata_question", new Error(err));
            return;
          }
          res.send(200);
        });
      });
    });
  }

  function handle_DELETE_metadata_answers(req, res) {
    let uid = req.p.uid;
    let pmaid = req.p.pmaid;

    getZidForAnswer(pmaid, function(err, zid) {
      if (err) {
        fail(res, 500, "polis_err_delete_participant_metadata_answers_zid", err);
        return;
      }
      isConversationOwner(zid, uid, function(err) {
        if (err) {
          fail(res, 403, "polis_err_delete_participant_metadata_answers_auth", err);
          return;
        }

        deleteMetadataAnswer(pmaid, function(err) {
          if (err) {
            fail(res, 500, "polis_err_delete_participant_metadata_answers", err);
            return;
          }
          res.send(200);
        });
      });
    });
  }

  function getZidForAnswer(pmaid, callback) {
    pg.queryP("SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);", [pmaid], function(err, result) {
      if (err) {
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_answer");
        return;
      }
      callback(null, result.rows[0].zid);
    });
  }

  function getZidForQuestion(pmqid, callback) {
    pg.queryP("SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);", [pmqid], function(err, result) {
      if (err) {
        winston.log("info", err);
        callback(err);
        return;
      }
      if (!result.rows || !result.rows.length) {
        callback("polis_err_zid_missing_for_question");
        return;
      }
      callback(null, result.rows[0].zid);
    });
  }

  function deleteMetadataAnswer(pmaid, callback) {
    // pg.queryP("update participant_metadata_choices set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
    //     if (err) {callback(34534545); return;}
    pg.queryP("update participant_metadata_answers set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
      if (err) {
        callback(err);
        return;
      }
      callback(null);
    });
    // });
  }

  function deleteMetadataQuestionAndAnswers(pmqid, callback) {
    // pg.queryP("update participant_metadata_choices set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
    //     if (err) {callback(93847834); return;}
    pg.queryP("update participant_metadata_answers set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
      if (err) {
        callback(err);
        return;
      }
      pg.queryP("update participant_metadata_questions set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
        if (err) {
          callback(err);
          return;
        }
        callback(null);
      });
    });
    // });
  }

  function handle_GET_metadata_questions(req, res) {
    let zid = req.p.zid;
    let zinvite = req.p.zinvite;
    let suzinvite = req.p.suzinvite;

    function doneChecking(err, foo) {
      if (err) {
        fail(res, 403, "polis_err_get_participant_metadata_auth", err);
        return;
      }

      async.parallel([
        function(callback) {
          pgQuery_readOnly("SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);", [zid], callback);
        },
        //function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_answers WHERE alive = true AND zid = ($1);", [zid], callback); },
        //function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_choices WHERE alive = true AND zid = ($1);", [zid], callback); },
      ], function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata_questions", err);
          return;
        }
        let rows = result[0] && result[0].rows;
        rows = rows.map(function(r) {
          r.required = true;
          return r;
        });
        finishArray(res, rows);
      });
    }

    if (zinvite) {
      checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else if (suzinvite) {
      checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
    } else {
      doneChecking(false);
    }
  }

  function handle_POST_metadata_questions(req, res) {
    let zid = req.p.zid;
    let key = req.p.key;
    let uid = req.p.uid;

    function doneChecking(err, foo) {
      if (err) {
        fail(res, 403, "polis_err_post_participant_metadata_auth", err);
        return;
      }
      pg.queryP("INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;", [
        zid,
        key,
      ], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
          fail(res, 500, "polis_err_post_participant_metadata_key", err);
          return;
        }

        finishOne(res, results.rows[0]);
      });
    }

    isConversationOwner(zid, uid, doneChecking);
  }

  function handle_POST_metadata_answers(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let pmqid = req.p.pmqid;
    let value = req.p.value;

    function doneChecking(err, foo) {
      if (err) {
        fail(res, 403, "polis_err_post_participant_metadata_auth", err);
        return;
      }
      pg.queryP("INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;", [pmqid, zid, value], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
          pg.queryP("UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;", [pmqid, zid, value], function(err, results) {
            if (err) {
              fail(res, 500, "polis_err_post_participant_metadata_value", err);
              return;
            }
            finishOne(res, results.rows[0]);
          });
        } else {
          finishOne(res, results.rows[0]);
        }
      });
    }

    isConversationOwner(zid, uid, doneChecking);
  }

  function handle_GET_metadata_choices(req, res) {
    let zid = req.p.zid;

    getChoicesForConversation(zid).then(function(choices) {
      finishArray(res, choices);
    }, function(err) {
      fail(res, 500, "polis_err_get_participant_metadata_choices", err);
    });
  }


  function handle_GET_metadata_answers(req, res) {
    let zid = req.p.zid;
    let zinvite = req.p.zinvite;
    let suzinvite = req.p.suzinvite;
    let pmqid = req.p.pmqid;

    function doneChecking(err, foo) {
      if (err) {
        fail(res, 403, "polis_err_get_participant_metadata_auth", err);
        return;
      }
      let query = sql_participant_metadata_answers.select(sql_participant_metadata_answers.star())
        .where(
          sql_participant_metadata_answers.zid.equals(zid)
        ).and(
          sql_participant_metadata_answers.alive.equals(true)
        );

      if (pmqid) {
        query = query.where(sql_participant_metadata_answers.pmqid.equals(pmqid));
      }
      pgQuery_readOnly(query.toString(), function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata_answers", err);
          return;
        }
        let rows = result.rows.map(function(r) {
          r.is_exclusive = true; // TODO fetch this info from the queston itself
          return r;
        });
        finishArray(res, rows);
      });
    }

    if (zinvite) {
      checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else if (suzinvite) {
      checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
    } else {
      doneChecking(false);
    }
  }


  function handle_GET_metadata(req, res) {
    let zid = req.p.zid;
    let zinvite = req.p.zinvite;
    let suzinvite = req.p.suzinvite;

    function doneChecking(err) {
      if (err) {
        fail(res, 403, "polis_err_get_participant_metadata_auth", err);
        return;
      }
      async.parallel([
        function(callback) {
          pgQuery_readOnly("SELECT * FROM participant_metadata_questions WHERE zid = ($1);", [zid], callback);
        },
        function(callback) {
          pgQuery_readOnly("SELECT * FROM participant_metadata_answers WHERE zid = ($1);", [zid], callback);
        },
        function(callback) {
          pgQuery_readOnly("SELECT * FROM participant_metadata_choices WHERE zid = ($1);", [zid], callback);
        },
      ], function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_get_participant_metadata", err);
          return;
        }
        let keys = result[0] && result[0].rows;
        let vals = result[1] && result[1].rows;
        let choices = result[2] && result[2].rows;
        let o = {};
        let keyNames = {};
        let valueNames = {};
        let i;
        let k;
        let v;
        if (!keys || !keys.length) {
          res.status(200).json({});
          return;
        }
        for (i = 0; i < keys.length; i++) {
          // Add a map for each keyId
          k = keys[i];
          o[k.pmqid] = {};
          // keep the user-facing key name
          keyNames[k.pmqid] = k.key;
        }
        for (i = 0; i < vals.length; i++) {
          // Add an array for each possible valueId
          k = vals[i];
          v = vals[i];
          o[k.pmqid][v.pmaid] = [];
          // keep the user-facing value string
          valueNames[v.pmaid] = v.value;
        }
        for (i = 0; i < choices.length; i++) {
          // Append a pid for each person who has seleted that value for that key.
          o[choices[i].pmqid][choices[i].pmaid] = choices[i].pid;
        }
        // TODO cache
        res.status(200).json({
          kvp: o, // key_id => value_id => [pid]
          keys: keyNames,
          values: valueNames,
        });
      });
    }

    if (zinvite) {
      checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else if (suzinvite) {
      checkSuzinviteCodeValidity(zid, suzinvite, doneChecking);
    } else {
      doneChecking(false);
    }
  }


  function getConversationHasMetadata(zid) {
    return new Promise(function(resolve, reject) {
      pgQuery_readOnly('SELECT * from participant_metadata_questions where zid = ($1)', [zid], function(err, metadataResults) {
        if (err) {
          return reject("polis_err_get_conversation_metadata_by_zid");
        }
        let hasNoMetadata = !metadataResults || !metadataResults.rows || !metadataResults.rows.length;
        resolve(!hasNoMetadata);
      });
    });
  }

  function getConversationTranslations(zid, lang) {
    const firstTwoCharsOfLang = lang.substr(0,2);
    return pg.queryP("select * from conversation_translations where zid = ($1) and lang = ($2);", [zid, firstTwoCharsOfLang]);
  }

  function getConversationTranslationsMinimal(zid, lang) {
    if (!lang) {
      return Promise.resolve([]);
    }
    return getConversationTranslations(zid, lang).then(function(rows) {
      for (let i = 0; i < rows.length; i++) {
        delete rows[i].zid;
        delete rows[i].created;
        delete rows[i].modified;
        delete rows[i].src;
      }
      return rows;
    });
  }

  function getOneConversation(zid, uid, lang) {

    return Promise.all([
      pg.queryP_readOnly("select * from conversations left join  (select uid, site_id, plan from users) as u on conversations.owner = u.uid where conversations.zid = ($1);", [zid]),
      getConversationHasMetadata(zid),
      (_.isUndefined(uid) ? Promise.resolve({}) : getUserInfoForUid2(uid)),
      getConversationTranslationsMinimal(zid, lang),
    ]).then(function(results) {
      let conv = results[0] && results[0][0];
      let convHasMetadata = results[1];
      let requestingUserInfo = results[2];
      let translations = results[3];

      conv.auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(conv.auth_opt_allow_3rdparty, true);
      conv.auth_opt_fb_computed = conv.auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_fb, true);
      conv.auth_opt_tw_computed = conv.auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_tw, true);

      conv.translations = translations;

      return getUserInfoForUid2(conv.owner).then(function(ownerInfo) {
        let ownername = ownerInfo.hname;
        if (convHasMetadata) {
          conv.hasMetadata = true;
        }
        if (!_.isUndefined(ownername) && conv.context !== "hongkong2014") {
          conv.ownername = ownername;
        }
        conv.is_mod = conv.site_id === requestingUserInfo.site_id;
        conv.is_owner = conv.owner === uid;
        conv.pp = false; // participant pays (WIP)
        delete conv.uid; // conv.owner is what you want, uid shouldn't be returned.
        return conv;
      });
    });
  }

  function getConversations(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let xid = req.p.xid;
    // let course_invite = req.p.course_invite;
    let include_all_conversations_i_am_in = req.p.include_all_conversations_i_am_in;
    let want_mod_url = req.p.want_mod_url;
    let want_upvoted = req.p.want_upvoted;
    let want_inbox_item_admin_url = req.p.want_inbox_item_admin_url;
    let want_inbox_item_participant_url = req.p.want_inbox_item_participant_url;
    let want_inbox_item_admin_html = req.p.want_inbox_item_admin_html;
    let want_inbox_item_participant_html = req.p.want_inbox_item_participant_html;
    let context = req.p.context;
    // let limit = req.p.limit;
    winston.log("info", "thecontext", context);


    // this statement is currently a subset of the next one
    // let zidListQuery = "select zid from page_ids where site_id = (select site_id from users where uid = ($1))";

    // include conversations started by people with the same site_id as me
    // 1's indicate that the conversations are there for that reason
    let zidListQuery = "select zid, 1 as type from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($1)))";
    if (include_all_conversations_i_am_in) {
      zidListQuery += " UNION ALL select zid, 2 as type from participants where uid = ($1)"; // using UNION ALL instead of UNION to ensure we get all the 1's and 2's (I'm not sure if we can guarantee the 2's won't clobber some 1's if we use UNION)
    }
    zidListQuery += ";";


    pgQuery_readOnly(zidListQuery, [uid], function(err, results) {
      if (err) {
        fail(res, 500, "polis_err_get_conversations_participated_in", err);
        return;
      }

      let participantInOrSiteAdminOf = results && results.rows && _.pluck(results.rows, "zid") || null;
      let siteAdminOf = _.filter(results.rows, function(row) {
        return row.type === 1;
      });
      let isSiteAdmin = _.indexBy(siteAdminOf, "zid");

      let query = sql_conversations.select(sql_conversations.star());

      let isRootsQuery = false;
      let orClauses;
      if (!_.isUndefined(req.p.context)) {
        if (req.p.context === "/") {
          winston.log("info", "asdf" + req.p.context + "asdf");
          // root of roots returns all public conversations
          // TODO lots of work to decide what's relevant
          // There is a bit of mess here, because we're returning both public 'roots' conversations, and potentially private conversations that you are already in.
          orClauses = sql_conversations.is_public.equals(true);
          isRootsQuery = true; // more conditions follow in the ANDs below
        } else {
          // knowing a context grants access to those conversations (for now at least)
          winston.log("info", "CONTEXT", context);
          orClauses = sql_conversations.context.equals(req.p.context);
        }
      } else {
        orClauses = sql_conversations.owner.equals(uid);
        if (participantInOrSiteAdminOf.length) {
          orClauses = orClauses.or(sql_conversations.zid.in(participantInOrSiteAdminOf));
        }
      }


      query = query.where(orClauses);
      if (!_.isUndefined(req.p.course_invite)) {
        query = query.and(sql_conversations.course_id.equals(req.p.course_id));
      }
      // query = query.where("("+ or_clauses.join(" OR ") + ")");
      if (!_.isUndefined(req.p.is_active)) {
        query = query.and(sql_conversations.is_active.equals(req.p.is_active));
      }
      if (!_.isUndefined(req.p.is_draft)) {
        query = query.and(sql_conversations.is_draft.equals(req.p.is_draft));
      }
      if (!_.isUndefined(req.p.zid)) {
        query = query.and(sql_conversations.zid.equals(zid));
      }
      if (isRootsQuery) {
        query = query.and(sql_conversations.context.isNotNull());
      }

      //query = whereOptional(query, req.p, 'owner');
      query = query.order(sql_conversations.created.descending);

      if (!_.isUndefined(req.p.limit)) {
        query = query.limit(req.p.limit);
      } else {
        query = query.limit(999); // TODO paginate
      }
      pgQuery_readOnly(query.toString(), function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_get_conversations", err);
          return;
        }
        let data = result.rows || [];


        addConversationIds(data).then(function(data) {
          let suurlsPromise;
          if (xid) {
            suurlsPromise = Promise.all(data.map(function(conv) {
              return createOneSuzinvite(
                xid,
                conv.zid,
                conv.owner, // TODO think: conv.owner or uid?
                _.partial(generateSingleUseUrl, req)
              );
            }));
          } else {
            suurlsPromise = Promise.resolve();
          }
          let upvotesPromise = (uid && want_upvoted) ? pg.queryP_readOnly("select zid from upvotes where uid = ($1);", [uid]) : Promise.resolve();

          return Promise.all([
            suurlsPromise,
            upvotesPromise,
          ]).then(function(x) {
            let suurlData = x[0];
            let upvotes = x[1];
            if (suurlData) {
              suurlData = _.indexBy(suurlData, "zid");
            }
            if (upvotes) {
              upvotes = _.indexBy(upvotes, "zid");
            }
            data.forEach(function(conv) {
              conv.is_owner = conv.owner === uid;
              let root = getServerNameWithProtocol(req);

              if (want_mod_url) {
                // TODO make this into a moderation invite URL so others can join Issue #618
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
                  "<a href='" + root + "/" + conv.conversation_id + "'>" + (conv.topic || conv.created) + "</a>" +
                  " <a href='" + root + "/m/" + conv.conversation_id + "'>moderate</a>";

                conv.inbox_item_admin_html_escaped = conv.inbox_item_admin_html.replace(/'/g, "\\'");
              }
              if (want_inbox_item_participant_html) {
                conv.inbox_item_participant_html = "<a href='" + root + "/" + conv.conversation_id + "'>" + (conv.topic || conv.created) + "</a>";
                conv.inbox_item_participant_html_escaped = conv.inbox_item_admin_html.replace(/'/g, "\\'");
              }

              if (suurlData) {
                conv.url = suurlData[conv.zid].suurl;
              } else {
                conv.url = buildConversationUrl(req, conv.conversation_id);
              }
              if (upvotes && upvotes[conv.zid]) {
                conv.upvoted = true;
              }
              conv.created = Number(conv.created);
              conv.modified = Number(conv.modified);

              // if there is no topic, provide a UTC timstamp instead
              if (_.isUndefined(conv.topic) || conv.topic === "") {
                conv.topic = (new Date(conv.created)).toUTCString();
              }

              conv.is_mod = conv.is_owner || isSiteAdmin[conv.zid];

              // Make sure zid is not exposed
              delete conv.zid;

              delete conv.is_anon;
              delete conv.is_active;
              delete conv.is_draft;
              delete conv.is_public;
              if (conv.context === "") {
                delete conv.context;
              }
            });

            res.status(200).json(data);

          }, function(err) {
            fail(res, 500, "polis_err_get_conversations_surls", err);
          });
        }).catch(function(err) {
          fail(res, 500, "polis_err_get_conversations_misc", err);
        });
      });
    });
  }

  function createReport(zid) {
    return generateTokenP(20, false).then(function(report_id) {
      report_id = 'r' + report_id;
      return pg.queryP("insert into reports (zid, report_id) values ($1, $2);", [zid, report_id]);
    });
  }


  function handle_POST_reports(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;

    return isModerator(zid, uid).then((isMod) => {
      if (!isMod) {
        return fail(res, 403, "polis_err_post_reports_permissions", err);
      }
      return createReport(zid).then(() => {
        res.json({});
      });
    }).catch((err) => {
      fail(res, 500, "polis_err_post_reports_misc", err);
    });
  }


  function handle_PUT_reports(req, res) {
    let rid = req.p.rid;
    let uid = req.p.uid;
    let zid = req.p.zid;

    return isModerator(zid, uid).then((isMod) => {
      if (!isMod) {
        return fail(res, 403, "polis_err_put_reports_permissions", err);
      }

      let fields = {
        modified: "now_as_millis()",
      };

      sql_reports.columns.map((c) => {
        return c.name;
      }).filter((name) => {
        // only allow changing label fields, (label_x_neg, etc) not zid, etc.
        return name.startsWith("label_");
      }).forEach((name) => {
        if (!_.isUndefined(req.p[name])) {
          fields[name] = req.p[name];
        }
      });

      if (!_.isUndefined(req.p.report_name)) {
        fields.report_name = req.p.report_name;
      }

      let q = sql_reports.update(
          fields
        )
        .where(
          sql_reports.rid.equals(rid)
        );

      let query  = q.toString();
      query = query.replace("'now_as_millis()'", "now_as_millis()"); // remove quotes added by sql lib

      return pg.queryP(query, []).then((result) => {
        res.json({});
      });
    }).catch((err) => {
      fail(res, 500, "polis_err_post_reports_misc", err);
    });
  }


  function handle_GET_reports(req, res) {
    let zid = req.p.zid;
    let rid = req.p.rid;
    let uid = req.p.uid;

    let reportsPromise = null;

    if (rid) {
      if (zid) {
        reportsPromise = Promise.reject("polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id");
      } else {
        reportsPromise = pg.queryP("select * from reports where rid = ($1);", [rid]);
      }
    } else if (zid) {
      reportsPromise = isModerator(zid, uid).then((doesOwnConversation) => {
        if (!doesOwnConversation) {
          throw "polis_err_permissions";
        }
        return pg.queryP("select * from reports where zid = ($1);", [zid]);
      });
    } else {
      reportsPromise = pg.queryP("select * from reports where zid in (select zid from conversations where owner = ($1));", [uid]);
    }

    reportsPromise.then((reports) => {
      let zids = [];
      reports = reports.map((report) => {
        zids.push(report.zid);
        delete report.rid;
        return report;
      });

      if (zids.length === 0) {
        return res.json(reports);
      }
      return pg.queryP("select * from zinvites where zid in (" + zids.join(",") + ");", []).then((zinvite_entries) => {
        let zidToZinvite = _.indexBy(zinvite_entries, "zid");
        reports = reports.map((report) => {
          report.conversation_id = zidToZinvite[report.zid].zinvite;
          delete report.zid;
          return report;
        });
        res.json(reports);
      });
    }).catch((err) => {
      if (err === "polis_err_permissions") {
        fail(res, 403, "polis_err_permissions");
      } else if (err === "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id") {
        fail(res, 404, "polis_err_get_reports_should_not_specify_both_report_id_and_conversation_id");
      } else {
        fail(res, 500, "polis_err_get_reports_misc", err);
      }
    });
  }


  function decodeParams(encodedStringifiedJson) {
    if (!encodedStringifiedJson.match(/^\/?ep1_/)) {
      throw new Error("wrong encoded params prefix");
    }
    if (encodedStringifiedJson[0] === "/") {
      encodedStringifiedJson = encodedStringifiedJson.slice(5);
    } else {
      encodedStringifiedJson = encodedStringifiedJson.slice(4);
    }
    let stringifiedJson = hexToStr(encodedStringifiedJson);
    let o = JSON.parse(stringifiedJson);
    return o;
  }

  function encodeParams(o) {
    let stringifiedJson = JSON.stringify(o);
    let encoded = "ep1_" + strToHex(stringifiedJson);
    return encoded;
  }

  function handle_GET_enterprise_deal_url(req, res) {
    var o = {
      monthly: req.p.monthly,
    };
    if (req.p.maxUsers) {
      o.maxUsers = req.p.maxUsers;
    }
    if (req.p.plan_name) {
      o.plan_name = req.p.plan_name;
    }
    if (req.p.plan_id) {
      o.plan_id = req.p.plan_id;
    }
    res.send("https://pol.is/settings/enterprise/" + encodeParams(o));
  }


  function handle_GET_stripe_account_connect(req, res) {
    var stripe_client_id = process.env.STRIPE_CLIENT_ID;

    var stripeUrl = "https://connect.stripe.com/oauth/authorize?response_type=code&client_id=" + stripe_client_id + "&scope=read_write";
    res.set({
      'Content-Type': 'text/html',
    }).send("<html><body>" +
      "<a href ='" + stripeUrl + "'>Connect Pol.is to Stripe</a>" +
      "</body></html>");
  }


  function handle_GET_stripe_account_connected_oauth_callback(req, res) {

    var code = req.p.code;
    // var access_token = req.p.access_token;
    // var error = req.p.error;
    // var error_description = req.p.error_description;
    if (req.p.error) {
      fail(res, 500, "polis_err_fetching_stripe_info_" + req.p.error, req.p.error_description);
      return;
    }

    // Make /oauth/token endpoint POST request
    request.post({
      url: 'https://connect.stripe.com/oauth/token',
      form: {
        grant_type: 'authorization_code',
        client_id: process.env.STRIPE_CLIENT_ID,
        code: code,
        client_secret: process.env.STRIPE_SECRET_KEY,
      },
    }, function(err, r, body) {
      if (err) {
        fail(res, 500, "polis_err_stripe_oauth", err);
        return;
      }
      body = JSON.parse(body);
      pg.queryP("INSERT INTO stripe_accounts (" +
        "stripe_account_token_type, " +
        "stripe_account_stripe_publishable_key, " +
        "stripe_account_scope, " +
        "stripe_account_livemode, " +
        "stripe_account_stripe_user_id, " +
        "stripe_account_refresh_token, " +
        "stripe_account_access_token " +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7);", [
          body.token_type,
          body.stripe_publishable_key,
          body.scope,
          body.livemode,
          body.stripe_user_id,
          body.refresh_token,
          body.access_token,
        ]).then(function() {
          res.set({
            'Content-Type': 'text/html',
          }).send("<html><body>success!</body></html>");
        }, function(err) {
          fail(res, 500, "polis_err_saving_stripe_info", err);
        });
    });
  }


  function handle_GET_conversations(req, res) {
    let courseIdPromise = Promise.resolve();
    if (req.p.course_invite) {
      courseIdPromise = pg.queryP_readOnly("select course_id from courses where course_invite = ($1);", [req.p.course_invite]).then(function(rows) {
        return rows[0].course_id;
      });
    }
    courseIdPromise.then(function(course_id) {
      if (course_id) {
        req.p.course_id = course_id;
      }
      let lang = null; // for now just return the default
      if (req.p.zid) {
        getOneConversation(req.p.zid, req.p.uid, lang).then(function(data) {
          finishOne(res, data);
        }, function(err) {
          fail(res, 500, "polis_err_get_conversations_2", err);
        }).catch(function(err) {
          fail(res, 500, "polis_err_get_conversations_1", err);
        });
      } else if (req.p.uid || req.p.context) {
        getConversations(req, res);
      } else {
        fail(res, 403, "polis_err_need_auth");
      }
    });
  }

  function handle_GET_contexts(req, res) {
    pg.queryP_readOnly("select name from contexts where is_public = TRUE order by name;", []).then(function(contexts) {
      res.status(200).json(contexts);
    }, function(err) {
      fail(res, 500, "polis_err_get_contexts_query", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_contexts_misc", err);
    });
  }

  function handle_POST_contexts(req, res) {
    let uid = req.p.uid;
    let name = req.p.name;

    function createContext() {
      return pg.queryP("insert into contexts (name, creator, is_public) values ($1, $2, $3);", [name, uid, true]).then(function() {
        res.status(200).json({});
      }, function(err) {
        fail(res, 500, "polis_err_post_contexts_query", err);
      }).catch(function(err) {
        fail(res, 500, "polis_err_post_contexts_misc", err);
      });
    }
    pg.queryP("select name from contexts where name = ($1);", [name]).then(function(rows) {
      let exists = rows && rows.length;
      if (exists) {
        fail(res, 422, "polis_err_post_context_exists");
        return;
      }
      return createContext();
    }, function(err) {
      fail(res, 500, "polis_err_post_contexts_check_query", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_post_contexts_check_misc", err);
    });
  }


  function isUserAllowedToCreateConversations(uid, callback) {
    callback(null, true);
    // pg.queryP("select is_owner from users where uid = ($1);", [uid], function(err, results) {
    //     if (err) { return callback(err); }
    //     if (!results || !results.rows || !results.rows.length) {
    //         return callback(1);
    //     }
    //     callback(null, results.rows[0].is_owner);
    // });
  }

  function handle_POST_reserve_conversation_id(req, res) {
    const zid = 0;
    const shortUrl = false;
    // TODO check auth - maybe bot has key
    generateAndRegisterZinvite(zid, shortUrl).then(function(conversation_id) {
      res.json({
        conversation_id: conversation_id,
      });
    }).catch((err) => {
      fail(res, 500, "polis_err_reserve_conversation_id", err);
    });
  }


  function handle_POST_conversations(req, res) {

    let xidStuffReady = Promise.resolve();

    xidStuffReady.then(() => {

      winston.log("info", "context", req.p.context);
      let generateShortUrl = req.p.short_url;

      isUserAllowedToCreateConversations(req.p.uid, function(err, isAllowed) {
        if (err) {
          fail(res, 403, "polis_err_add_conversation_failed_user_check", err);
          return;
        }
        if (!isAllowed) {
          fail(res, 403, "polis_err_add_conversation_not_enabled", new Error("polis_err_add_conversation_not_enabled"));
          return;
        }


        let q = sql_conversations.insert({
          owner: req.p.uid, // creator
          org_id: req.p.org_id || req.p.uid, // assume the owner is the creator if there's no separate owner specified (
          topic: req.p.topic,
          description: req.p.description,
          is_active: req.p.is_active,
          is_data_open: req.p.is_data_open,
          is_draft: req.p.is_draft,
          is_public: true, // req.p.short_url,
          is_anon: req.p.is_anon,
          is_slack: req.p.is_slack,
          profanity_filter: req.p.profanity_filter,
          spam_filter: req.p.spam_filter,
          strict_moderation: req.p.strict_moderation,
          context: req.p.context || null,
          owner_sees_participation_stats: !!req.p.owner_sees_participation_stats,
        }).returning('*').toString();

        pg.queryP(q, [], function(err, result) {
          if (err) {
            if (isDuplicateKey(err)) {
              yell(err);
              failWithRetryRequest(res);
            } else {
              fail(res, 500, "polis_err_add_conversation", err);
            }
            return;
          }

          let zid = result && result.rows && result.rows[0] && result.rows[0].zid;

          const zinvitePromise = req.p.conversation_id ?
            getZidFromConversationId(req.p.conversation_id).then((zid) => {
              return zid === 0 ? req.p.conversation_id : null;
            }) :
            generateAndRegisterZinvite(zid, generateShortUrl);

          zinvitePromise.then(function(zinvite) {
            if (zinvite === null) {
              fail(res, 400, "polis_err_conversation_id_already_in_use", err);
              return;
            }
            // NOTE: OK to return conversation_id, because this conversation was just created by this user.
            finishOne(res, {
              url: buildConversationUrl(req, zinvite),
              zid: zid,
            });
          }).catch(function(err) {
            fail(res, 500, "polis_err_zinvite_create", err);
          });
        }); // end insert
      }); // end isUserAllowedToCreateConversations
    }).catch((err) => {
      fail(res, 500, "polis_err_conversation_create", err);
    }); // end xidStuffReady
  } // end post conversations



  function handle_POST_query_participants_by_metadata(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let pmaids = req.p.pmaids;

    if (!pmaids.length) {
      // empty selection
      return res.status(200).json([]);
    }

    function doneChecking() {
      // find list of participants who are not eliminated by the list of excluded choices.
      pgQuery_readOnly(
        // 3. invert the selection of participants, so we get those who passed the filter.
        "select pid from participants where zid = ($1) and pid not in " +
        // 2. find the people who chose those answers
        "(select pid from participant_metadata_choices where alive = TRUE and pmaid in " +
        // 1. find the unchecked answers
        "(select pmaid from participant_metadata_answers where alive = TRUE and zid = ($2) and pmaid not in (" + pmaids.join(",") + "))" +
        ")" +
        ";", [zid, zid],
        function(err, results) {
          if (err) {
            fail(res, 500, "polis_err_metadata_query", err);
            return;
          }
          res.status(200).json(_.pluck(results.rows, "pid"));
        });
    }

    isOwnerOrParticipant(zid, uid, doneChecking);
  }


  function handle_POST_sendCreatedLinkToEmail(req, res) {
    winston.log("info", req.p);
    pgQuery_readOnly("SELECT * FROM users WHERE uid = $1", [req.p.uid], function(err, results) {
      if (err) {
        fail(res, 500, "polis_err_get_email_db", err);
        return;
      }
      let email = results.rows[0].email;
      let fullname = results.rows[0].hname;
      pgQuery_readOnly("select * from zinvites where zid = $1", [req.p.zid], function(err, results) {
        let zinvite = results.rows[0].zinvite;
        let server = getServerNameWithProtocol(req);
        let createdLink = server + "/#" + req.p.zid + "/" + zinvite;
        let body = "" +
          "Hi " + fullname + ",\n" +
          "\n" +
          "Here's a link to the conversation you just created. Use it to invite participants to the conversation. Share it by whatever network you prefer - Gmail, Facebook, Twitter, etc., or just post it to your website or blog. Try it now! Click this link to go to your conversation: \n" +
          "\n" +
          createdLink + "\n" +
          "\n" +
          "With gratitude,\n" +
          "\n" +
          "The team at pol.is";

        return sendTextEmail(
          POLIS_FROM_ADDRESS,
          email,
          "Link: " + createdLink,
          body).then(function() {
            res.status(200).json({});
          }).catch(function(err) {
            fail(res, 500, "polis_err_sending_created_link_to_email", err);
          });
      });
    });
  }

  function handle_POST_notifyTeam(req, res) {
    if (req.p.webserver_pass !== process.env.WEBSERVER_PASS || req.p.webserver_username !== process.env.WEBSERVER_USERNAME) {
      return fail(res, 403, "polis_err_notifyTeam_auth");
    }
    let subject = req.p.subject;
    let body = req.p.body;
    emailTeam(subject, body).then(() => {
      res.status(200).json({});
    }).catch((err) => {
      return fail(res, 500, "polis_err_notifyTeam");
    });
  }

  function handle_POST_sendEmailExportReady(req, res) {

    if (req.p.webserver_pass !== process.env.WEBSERVER_PASS || req.p.webserver_username !== process.env.WEBSERVER_USERNAME) {
      return fail(res, 403, "polis_err_sending_export_link_to_email_auth");
    }

    const domain = process.env.PRIMARY_POLIS_URL;
    const email = req.p.email;
    const subject = "Polis data export for conversation pol.is/" + req.p.conversation_id;
    const fromAddress = `Polis Team <${adminEmailDataExport}>`;
    const body = `Greetings

You created a data export for conversation ${domain}/${req.p.conversation_id} that has just completed. You can download the results for this conversation at the following url:

https://${domain}/api/v3/dataExport/results?filename=${req.p.filename}&conversation_id=${req.p.conversation_id}

Please let us know if you have any questons about the data.

Thanks for using Polis!
`;

    console.log("SENDING EXPORT EMAIL");
    console.log({
      domain,
      email,
      subject,
      fromAddress,
      body,
    });


    sendTextEmail(
      fromAddress,
      email,
      subject,
      body).then(function() {
        res.status(200).json({});
      }).catch(function(err) {
        fail(res, 500, "polis_err_sending_export_link_to_email", err);
      });
  }

  function getTwitterRequestToken(returnUrl) {
    let oauth = new OAuth.OAuth(
      'https://api.twitter.com/oauth/request_token', // null
      'https://api.twitter.com/oauth/access_token', // null
      process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
      process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
      '1.0A',
      null,
      'HMAC-SHA1'
    );
    let body = {
      oauth_callback: returnUrl,
    };
    return new Promise(function(resolve, reject) {
      oauth.post(
        'https://api.twitter.com/oauth/request_token',
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        body,
        "multipart/form-data",
        function(e, data, res) {
          if (e) {
            console.error("get twitter token failed");
            console.error(e);
            reject(e);
          } else {
            resolve(data);
          }
          // winston.log("info",require('util').inspect(data));
        }
      );
    });
  }

  function handle_GET_twitterBtn(req, res) {
    let dest = req.p.dest || "/inbox";
    dest = encodeURIComponent(getServerNameWithProtocol(req) + dest);
    let returnUrl = getServerNameWithProtocol(req) + "/api/v3/twitter_oauth_callback?owner=" + req.p.owner + "&dest=" + dest;

    getTwitterRequestToken(returnUrl).then(function(data) {
      winston.log("info", data);
      data += "&callback_url=" + dest;
      // data += "&callback_url=" + encodeURIComponent(getServerNameWithProtocol(req) + "/foo");
      res.redirect("https://api.twitter.com/oauth/authenticate?" + data);
    }).catch(function(err) {
      fail(res, 500, "polis_err_twitter_auth_01", err);
    });
  }


  function getTwitterAccessToken(body) {
    let oauth = new OAuth.OAuth(
      'https://api.twitter.com/oauth/request_token', // null
      'https://api.twitter.com/oauth/access_token', // null
      process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
      process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
      '1.0A',
      null,
      'HMAC-SHA1'
    );
    return new Promise(function(resolve, reject) {
      oauth.post(
        'https://api.twitter.com/oauth/access_token',
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        body,
        "multipart/form-data",
        function(e, data, res) {
          if (e) {
            console.error("get twitter token failed");
            console.error(e);
            reject(e);
          } else {
            resolve(data);
          }
          // winston.log("info",require('util').inspect(data));
        }
      );
    });
  }

  // TODO expire this stuff
  let twitterUserInfoCache = new LruCache({
    max: 10000,
  });


  function getTwitterUserInfo(o, useCache) {
    console.log("getTwitterUserInfo", o);

    let twitter_user_id = o.twitter_user_id;
    let twitter_screen_name = o.twitter_screen_name;
    let params = {
      // oauth_verifier: req.p.oauth_verifier,
      // oauth_token: req.p.oauth_token, // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the header, but this will have been added by the signing process."
    };
    let identifier; // this is way sloppy, but should be ok for caching and logging
    if (twitter_user_id) {
      params.user_id = twitter_user_id;
      identifier = twitter_user_id;
    } else if (twitter_screen_name) {
      params.screen_name = twitter_screen_name;
      identifier = twitter_screen_name;
    }

    let oauth = new OAuth.OAuth(
      'https://api.twitter.com/oauth/request_token', // null
      'https://api.twitter.com/oauth/access_token', // null
      process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
      process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
      '1.0A',
      null,
      'HMAC-SHA1'
    );
    return new MPromise("getTwitterUserInfo", function(resolve, reject) {
      let cachedCopy = twitterUserInfoCache.get(identifier);
      if (useCache && cachedCopy) {
        return resolve(cachedCopy);
      }
      if (suspendedOrPotentiallyProblematicTwitterIds.indexOf(identifier) >= 0) {
        return reject();
      }
      oauth.post(
        'https://api.twitter.com/1.1/users/lookup.json',
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        params,
        "multipart/form-data",
        function(e, data, res) {
          if (e) {
            console.error("get twitter token failed for identifier: " + identifier);
            console.error(e);
            suspendedOrPotentiallyProblematicTwitterIds.push(identifier);
            reject(e);
          } else {
            twitterUserInfoCache.set(identifier, data);
            resolve(data);
          }
          // winston.log("info",require('util').inspect(data));
        }
      );
    });
  }



  function getTwitterTweetById(twitter_tweet_id) {
    let oauth = new OAuth.OAuth(
      'https://api.twitter.com/oauth/request_token', // null
      'https://api.twitter.com/oauth/access_token', // null
      process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
      process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
      '1.0A',
      null,
      'HMAC-SHA1'
    );
    return new MPromise("getTwitterTweet", function(resolve, reject) {
      oauth.get(
        'https://api.twitter.com/1.1/statuses/show.json?id=' + twitter_tweet_id,
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        function(e, data, res) {
          if (e) {
            console.error(" - - - - get twitter tweet failed - - - -");
            console.error(e);
            reject(e);
          } else {
            data = JSON.parse(data);
            console.dir(data);
            resolve(data);
          }
          // winston.log("info",require('util').inspect(data));
        }
      );
    });
  }

  // function getTwitterUserTimeline(screen_name) {
  //   let oauth = new OAuth.OAuth(
  //     'https://api.twitter.com/oauth/request_token', // null
  //     'https://api.twitter.com/oauth/access_token', // null
  //     process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
  //     process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
  //     '1.0A',
  //     null,
  //     'HMAC-SHA1'
  //   );
  //   return new MPromise("getTwitterTweet", function(resolve, reject) {
  //     oauth.get(
  //       'https://api.twitter.com/1.1/statuses/user_timeline.json?screen_name=' + screen_name,
  //       void 0, //'your user token for this app', //test user token
  //       void 0, //'your user secret for this app', //test user secret
  //       function(e, data, res) {
  //         if (e) {
  //           console.error(" - - - - get twitter tweet failed - - - -");
  //           console.error(e);
  //           reject(e);
  //         } else {
  //           let foo = JSON.parse(data);
  //           foo = _.pluck(foo, "text");
  //           console.dir(foo);
  //           resolve(data);
  //         }
  //         // winston.log("info",require('util').inspect(data));
  //       }
  //     );
  //   });
  // }



  // Certain twitter ids may be suspended.
  // Twitter will error if we request info on them.
  //  so keep a list of these for as long as the server is running,
  //  so we don't repeat requests for them.
  // This is probably not optimal, but is pretty easy.
  let suspendedOrPotentiallyProblematicTwitterIds = [];


  function getTwitterUserInfoBulk(list_of_twitter_user_id) {
    list_of_twitter_user_id = list_of_twitter_user_id || [];
    let oauth = new OAuth.OAuth(
      'https://api.twitter.com/oauth/request_token', // null
      'https://api.twitter.com/oauth/access_token', // null
      process.env.TWITTER_CONSUMER_KEY, //'your application consumer key',
      process.env.TWITTER_CONSUMER_SECRET, //'your application secret',
      '1.0A',
      null,
      'HMAC-SHA1'
    );
    return new Promise(function(resolve, reject) {
      oauth.post(
        'https://api.twitter.com/1.1/users/lookup.json',
        void 0, //'your user token for this app', //test user token
        void 0, //'your user secret for this app', //test user secret
        {
          // oauth_verifier: req.p.oauth_verifier,
          // oauth_token: req.p.oauth_token, // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the header, but this will have been added by the signing process."
          user_id: list_of_twitter_user_id.join(","),
        },
        "multipart/form-data",
        function(e, data, res) {
          if (e) {
            console.error("get twitter token failed");
            console.error(e);
            // we should probably check that the error is code 17:  { statusCode: 404, data: '{"errors":[{"code":17,"message":"No user matches for specified terms."}]}' }
            list_of_twitter_user_id.forEach(function(id) {
              console.log("adding twitter_user_id to suspendedOrPotentiallyProblematicTwitterIds: " + id);
              suspendedOrPotentiallyProblematicTwitterIds.push(id);
            });
            reject(e);
          } else {
            data = JSON.parse(data);
            // winston.log("info",data);
            // winston.log("info",require('util').inspect(data));
            resolve(data);
          }
        }
      );
    });
  }


  function switchToUser(req, res, uid) {
    return new Promise(function(resolve, reject) {
      startSession(uid, function(errSess, token) {
        if (errSess) {
          reject(errSess);
          return;
        }
        addCookies(req, res, token, uid).then(function() {
          resolve();
        }).catch(function(err) {
          reject("polis_err_adding_cookies");
        });
      });
    });
  }


  // retry, resolving with first success, or rejecting with final error
  function retryFunctionWithPromise(f, numTries) {
    return new Promise(function(resolve, reject) {
      winston.log("info", "retryFunctionWithPromise", numTries);
      f().then(function(x) {
        winston.log("info", "retryFunctionWithPromise", "RESOLVED");
        resolve(x);
      }, function(err) {
        numTries -= 1;
        if (numTries <= 0) {
          winston.log("info", "retryFunctionWithPromise", "REJECTED");
          reject(err);
        } else {
          retryFunctionWithPromise(f, numTries).then(resolve, reject);
        }
      });
    });
  }


  function updateSomeTwitterUsers() {
    return pg.queryP_readOnly("select uid, twitter_user_id from twitter_users where modified < (now_as_millis() - 30*60*1000) order by modified desc limit 100;").then(function(results) {
      let twitter_user_ids = _.pluck(results, "twitter_user_id");
      if (results.length === 0) {
        return [];
      }
      twitter_user_ids = _.difference(twitter_user_ids, suspendedOrPotentiallyProblematicTwitterIds);
      if (twitter_user_ids.length === 0) {
        return [];
      }

      getTwitterUserInfoBulk(twitter_user_ids).then(function(info) {
        // Uncomment to log out lots of twitter crap for a good time
        //console.dir(info);

        let updateQueries = info.map(function(u) {
          let q = "update twitter_users set " +
            "screen_name = ($2)," +
            "name = ($3)," +
            "followers_count = ($4)," +
            "friends_count = ($5)," +
            "verified = ($6)," +
            "profile_image_url_https = ($7)," +
            "location = ($8)," +
            "modified = now_as_millis() " +
            "where twitter_user_id = ($1);";

          // uncomment to see some other twitter crap
          //console.log(q);
          return pg.queryP(q, [
            u.id,
            u.screen_name,
            u.name,
            u.followers_count,
            u.friends_count,
            u.verified,
            u.profile_image_url_https,
            u.location,
          ]);
        });
        return Promise.all(updateQueries).then(function() {
          console.log("done123");
        });
      }).catch(function(err) {
        console.error("error updating twitter users:" + twitter_user_ids.join(" "));
      });
    });
  }
  // Ensure we don't call this more than 60 times in each 15 minute window (across all of our servers/use-cases)
  setInterval(updateSomeTwitterUsers, 1 * 60 * 1000);
  updateSomeTwitterUsers();


  // getTwitterTweetById("627881237101846528").then(function(tweet) {
  //     console.dir(tweet);
  // });


  function createUserFromTwitterInfo(o) {
    return createDummyUser().then(function(uid) {
      return getAndInsertTwitterUser(o, uid).then(function(result) {

        let u = result.twitterUser;
        let twitterUserDbRecord = result.twitterUserDbRecord;

        return pg.queryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, u.name]).then(function() {
          return twitterUserDbRecord;
        });
      });
    });
  }


  function prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid) {
    let query = pg.queryP("select * from twitter_users where screen_name = ($1);", [quote_twitter_screen_name]);
    return addParticipantByTwitterUserId(query, {
      twitter_screen_name: quote_twitter_screen_name,
    }, zid, null);
  }

  function prepForTwitterComment(twitter_tweet_id, zid) {
    return getTwitterTweetById(twitter_tweet_id).then(function(tweet) {
      let user = tweet.user;
      let twitter_user_id = user.id_str;
      let query = pg.queryP("select * from twitter_users where twitter_user_id = ($1);", [twitter_user_id]);
      return addParticipantByTwitterUserId(query, {
        twitter_user_id: twitter_user_id,
      }, zid, tweet);
    });
  }


  function addParticipantByTwitterUserId(query, o, zid, tweet) {
    function addParticipantAndFinish(uid, twitterUser, tweet) {
      return addParticipant(zid, uid).then(function(rows) {
        let ptpt = rows[0];
        return {
          ptpt: ptpt,
          twitterUser: twitterUser,
          tweet: tweet,
        };
      });
    }
    return query.then(function(rows) {
      if (rows && rows.length) {
        let twitterUser = rows[0];
        let uid = twitterUser.uid;
        return getParticipant(zid, uid).then(function(ptpt) {
          if (!ptpt) {
            return addParticipantAndFinish(uid, twitterUser, tweet);
          }
          return {
            ptpt: ptpt,
            twitterUser: twitterUser,
            tweet: tweet,
          };
        }).catch(function(err) {
          return addParticipantAndFinish(uid, twitterUser, tweet);
        });
      } else {
        // no user records yet
        return createUserFromTwitterInfo(o).then(function(twitterUser) {
          let uid = twitterUser.uid;
          return addParticipant(zid, uid).then(function(rows) {
            let ptpt = rows[0];
            return {
              ptpt: ptpt,
              twitterUser: twitterUser,
              tweet: tweet,
            };
          });
        });
      }
    });

    // * fetch tweet info
    //   if fails, return failure
    // * look for author in twitter_users
    //   if exists
    //    * use uid to find pid in participants
    //   if not exists
    //    * fetch info about user from twitter api
    //      if fails, ??????
    //      if ok
    //       * create a new user record
    //       * create a twitter record
  }

  function addParticipant(zid, uid) {
    return pg.queryP("INSERT INTO participants_extended (zid, uid) VALUES ($1, $2);", [zid, uid]).then(() => {
      return pg.queryP("INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;", [zid, uid]);
    });
  }


  function getAndInsertTwitterUser(o, uid) {
    return getTwitterUserInfo(o, false).then(function(u) {
      u = JSON.parse(u)[0];
      winston.log("info", "TWITTER USER INFO");
      winston.log("info", u);
      winston.log("info", "/TWITTER USER INFO");
      return pg.queryP("insert into twitter_users (" +
        "uid," +
        "twitter_user_id," +
        "screen_name," +
        "name," +
        "followers_count," +
        "friends_count," +
        "verified," +
        "profile_image_url_https," +
        "location," +
        "response" +
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *;", [
          uid,
          u.id,
          u.screen_name,
          u.name,
          u.followers_count,
          u.friends_count,
          u.verified,
          u.profile_image_url_https,
          u.location,
          JSON.stringify(u),
        ]).then(function(rows) {
          let record = rows && rows.length && rows[0] || null;

          // return the twitter user record
          return {
            twitterUser: u,
            twitterUserDbRecord: record,
          };
        });
    });
  }



  function handle_GET_twitter_oauth_callback(req, res) {
    let uid = req.p.uid;
    winston.log("info", "twitter oauth callback req.p", req.p);


    // commenting this out for now because all objects end up getting owner = t, but we don't really want to
    // add all twitter/facebook logins to intercom, so turning this off for now.
    //function maybeAddToIntercom(o) {
      //let shouldAddToIntercom = req.p.owner;
      //if (shouldAddToIntercom) {
        //let params = {
          //"email": o.email,
          //"name": o.name,
          //"user_id": o.uid,
        //};
        //let customData = {};
        //// if (referrer) {
        ////     customData.referrer = o.referrer;
        //// }
        //// if (organization) {
        ////     customData.org = organization;
        //// }
        //// customData.fb = true; // mark this user as a facebook auth user
        //customData.tw = true; // mark this user as a twitter auth user
        //customData.twitterScreenName = o.screen_name;
        //customData.uid = o.uid;
        //if (_.keys(customData).length) {
          //params.custom_data = customData;
        //}
        //intercom.createUser(params, function(err, res) {
          //if (err) {
            //winston.log("info", err);
            //console.error("polis_err_intercom_create_user_tw_fail");
            //winston.log("info", params);
            //yell("polis_err_intercom_create_user_tw_fail");
            //return;
          //}
        //});
      //}
    //}


    // TODO "Upon a successful authentication, your callback_url would receive a request containing the oauth_token and oauth_verifier parameters. Your application should verify that the token matches the request token received in step 1."

    let dest = req.p.dest;
    winston.log("info", "twitter_oauth_callback uid", uid);
    winston.log("info", "twitter_oauth_callback params");
    winston.log("info", req.p);
    winston.log("info", "twitter_oauth_callback params end");
    // this api sometimes succeeds, and sometimes fails, not sure why
    function tryGettingTwitterAccessToken() {
      return getTwitterAccessToken({
        oauth_verifier: req.p.oauth_verifier,
        oauth_token: req.p.oauth_token, // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the header, but this will have been added by the signing process."
      });
    }
    retryFunctionWithPromise(tryGettingTwitterAccessToken, 20).then(function(o) {
      winston.log("info", "TWITTER ACCESS TOKEN");
      let pairs = o.split("&");
      let kv = {};
      pairs.forEach(function(pair) {
        let pairSplit = pair.split("=");
        let k = pairSplit[0];
        let v = pairSplit[1];
        // can't do this anymore, because now twitter uses integers which overflow js max resolution
        //if (k === "user_id") {
          //v = parseInt(v);
        //}
        kv[k] = v;
      });
      winston.log("info", kv);
      winston.log("info", "/TWITTER ACCESS TOKEN");

      // TODO - if no auth, generate a new user.

      getTwitterUserInfo({
        twitter_user_id: kv.user_id,
      }, false).then(function(u) {
        u = JSON.parse(u)[0];
        winston.log("info", "TWITTER USER INFO");
        winston.log("info", u);
        winston.log("info", "/TWITTER USER INFO");
        return pg.queryP("insert into twitter_users (" +
          "uid," +
          "twitter_user_id," +
          "screen_name," +
          "name," +
          "followers_count," +
          "friends_count," +
          "verified," +
          "profile_image_url_https," +
          "location," +
          "response" +
          ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);", [
            uid,
            u.id,
            u.screen_name,
            u.name,
            u.followers_count,
            u.friends_count,
            u.verified,
            u.profile_image_url_https,
            u.location,
            JSON.stringify(u),
          ]).then(function() {
            // SUCCESS
            // There was no existing record
            // set the user's hname, if not already set
            pg.queryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, u.name]).then(function() {
              // OK, ready
              u.uid = uid;
              //maybeAddToIntercom(u);
              res.redirect(dest);
            }, function(err) {
              fail(res, 500, "polis_err_twitter_auth_update", err);
            }).catch(function(err) {
              fail(res, 500, "polis_err_twitter_auth_update_misc", err);
            });
          },
          function(err) {
            if (isDuplicateKey(err)) {
              // we know the uid OR twitter_user_id is filled
              // check if the uid is there with the same twitter_user_id - if so, redirect and good!
              // determine which kind of duplicate
              Promise.all([
                pg.queryP("select * from twitter_users where uid = ($1);", [uid]),
                pg.queryP("select * from twitter_users where twitter_user_id = ($1);", [u.id]),
              ]).then(function(foo) {
                let recordForUid = foo[0][0];
                let recordForTwitterId = foo[1][0];
                if (recordForUid && recordForTwitterId) {
                  if (recordForUid.uid === recordForTwitterId.uid) {
                    // match
                    res.redirect(dest);
                  } else {
                    // TODO_SECURITY_REVIEW
                    // both exist, but not same uid
                    switchToUser(req, res, recordForTwitterId.uid).then(function() {
                      res.redirect(dest);
                    }).catch(function(err) {
                      fail(res, 500, "polis_err_twitter_auth_456", err);
                    });
                  }
                } else if (recordForUid) {
                  // currently signed in user has a twitter account attached, but it's a different twitter account, and they are now signing in with a different twitter account.
                  // the newly supplied twitter account is not attached to anything.
                  fail(res, 500, "polis_err_twitter_already_attached", err);
                } else if (recordForTwitterId) {
                  // currently signed in user has no twitter account attached, but they just signed in with a twitter account which is attached to another user.
                  // For now, let's just have it sign in as that user.
                  // TODO_SECURITY_REVIEW
                  switchToUser(req, res, recordForTwitterId.uid).then(function() {
                    res.redirect(dest);
                  }).catch(function(err) {
                    fail(res, 500, "polis_err_twitter_auth_234", err);
                  });
                } else {
                  fail(res, 500, "polis_err_twitter_auth_345");
                }
              });

            // else check if the uid is there and has some other screen_name - if so, ????????

            // else check if the screen_name is there, but for a different uid - if so, ??????

            } else {
              fail(res, 500, "polis_err_twitter_auth_05", err);
            }
          });
      },function(err) {
        winston.log("error", "failed to getTwitterUserInfo");
        fail(res, 500, "polis_err_twitter_auth_041", err);
      }).catch(function(err) {
        fail(res, 500, "polis_err_twitter_auth_04", err);
      });
    }, function(err) {
      fail(res, 500, "polis_err_twitter_auth_gettoken", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_twitter_auth_misc", err);
    });
  }

  function getTwitterInfo(uids) {
    return pg.queryP_readOnly("select * from twitter_users where uid in ($1);", uids);
  }

  function getFacebookInfo(uids) {
    return pg.queryP_readOnly("select * from facebook_users where uid in ($1);", uids);
  }

  function getEmailVerifiedInfo(uids) {
    return pg.queryP_readOnly("SELECT * FROM email_validations WHERE email=" +
      "(SELECT email FROM users WHERE uid in ($1));", uids);
  }

  function getSocialParticipantsForMod_timed() {
    let start = Date.now();
    return getSocialParticipantsForMod.apply(null, arguments).then(function(results) {
      let elapsed = Date.now() - start;
      console.log("getSocialParticipantsForMod_timed", elapsed);
      return results;
    });
  }

  function getSocialParticipantsForMod(zid, limit, mod, owner) {

    let modClause = "";
    let params = [zid, limit, owner];
    if (!_.isUndefined(mod)) {
      modClause = " and mod = ($4)";
      params.push(mod);
    }

    let q = "with " +
      "p as (select uid, pid, mod from participants where zid = ($1) " + modClause + "), " + // and vote_count >= 1

      "final_set as (select * from p limit ($2)), " +

      "xids_subset as (select * from xids where owner = ($3) and x_profile_image_url is not null), " +

      "all_rows as (select " +
      // "final_set.priority, " +
      "final_set.mod, " +
      "twitter_users.twitter_user_id as tw__twitter_user_id, " +
      "twitter_users.screen_name as tw__screen_name, " +
      "twitter_users.name as tw__name, " +
      "twitter_users.followers_count as tw__followers_count, " +
      // "twitter_users.friends_count as tw__friends_count, " +
      "twitter_users.verified as tw__verified, " +
      "twitter_users.profile_image_url_https as tw__profile_image_url_https, " +
      "twitter_users.location as tw__location, " +
      // "twitter_users.response as tw__response, " +
      // "twitter_users.modified as tw__modified, " +
      // "twitter_users.created as tw__created, " +
      "facebook_users.fb_user_id as fb__fb_user_id, " +
      "facebook_users.fb_name as fb__fb_name, " +
      "facebook_users.fb_link as fb__fb_link, " +
      "facebook_users.fb_public_profile as fb__fb_public_profile, " +
      // "facebook_users.fb_login_status as fb__fb_login_status, " +
      // "facebook_users.fb_auth_response as fb__fb_auth_response, " +
      // "facebook_users.fb_access_token as fb__fb_access_token, " +
      // "facebook_users.fb_granted_scopes as fb__fb_granted_scopes, " +
      // "facebook_users.fb_location_id as fb__fb_location_id, " +
      "facebook_users.location as fb__location, " +
      // "facebook_users.response as fb__response, " +
      // "facebook_users.fb_friends_response as fb__fb_friends_response, " +
      // "facebook_users.created as fb__created, " +
      // "all_friends.uid is not null as is_fb_friend, " +
      // "final_set.uid " +
      "xids_subset.x_profile_image_url as x_profile_image_url, " +
      "xids_subset.xid as xid, " +
      "xids_subset.x_name as x_name, " +
      // "xids_subset.x_email as x_email, " +

      "final_set.pid " +
      "from final_set " +
      "left join twitter_users on final_set.uid = twitter_users.uid " +
      "left join facebook_users on final_set.uid = facebook_users.uid " +
      "left join xids_subset on final_set.uid = xids_subset.uid " +
      ") " +
      "select * from all_rows where (tw__twitter_user_id is not null) or (fb__fb_user_id is not null) or (xid is not null) " +
      // "select * from all_rows " +
      ";";
    return pg.queryP(q, params);
  }

  let socialParticipantsCache = new LruCache({
    maxAge: 1000 * 30, // 30 seconds
    max: 999,
  });

  function getSocialParticipants(zid, uid, limit, mod, math_tick, authorUids) {
    // NOTE ignoring authorUids as part of cacheKey for now, just because.
    let cacheKey = [zid, limit, mod, math_tick].join("_");
    if (socialParticipantsCache.get(cacheKey)) {
      return socialParticipantsCache.get(cacheKey);
    }

    let authorsQuery = authorUids.map(function(authorUid) {
      return "select " + Number(authorUid) + " as uid, 900 as priority";
    });
    authorsQuery = "(" + authorsQuery.join(" union ") + ")";
    if (authorUids.length === 0) {
      authorsQuery = null;
    }

    let q = "with " +
      "p as (select uid, pid, mod from participants where zid = ($1) and vote_count >= 1), " +
      // "all_friends as (select  " +
      //         "friend as uid, 100 as priority from facebook_friends where uid = ($2) " +
      //         "union  " +
      //         "select uid, 100 as priority from facebook_friends where friend = ($2)), " +

      "xids_subset as (select * from xids where owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null), " +
      "xid_ptpts as (select p.uid, 100 as priority from p inner join xids_subset on xids_subset.uid = p.uid where p.mod >= ($4)), " +
      "twitter_ptpts as (select p.uid, 10 as priority from p inner join twitter_users  on twitter_users.uid  = p.uid where p.mod >= ($4)), " +
      "all_fb_users as (select p.uid,   9 as priority from p inner join facebook_users on facebook_users.uid = p.uid where p.mod >= ($4)), " +
      "self as (select CAST($2 as INTEGER) as uid, 1000 as priority), " +
      (authorsQuery ? ("authors as " + authorsQuery + ", ") : "") +
      "pptpts as (select prioritized_ptpts.uid, max(prioritized_ptpts.priority) as priority " +
      "from ( " +
      "select * from self " +
      (authorsQuery ? ("union " +
        "select * from authors ") : "") +
      // "union  " +
      // "select * from all_friends " +
      "union " +
      "select * from twitter_ptpts " +
      "union " +
      "select * from all_fb_users " +
      "union " +
      "select * from xid_ptpts " +
      ") as prioritized_ptpts " +
      "inner join p on prioritized_ptpts.uid = p.uid " +
      "group by prioritized_ptpts.uid order by priority desc, prioritized_ptpts.uid asc), " +

      // force inclusion of participants with high mod values
      "mod_pptpts as (select asdfasdjfioasjdfoi.uid, max(asdfasdjfioasjdfoi.priority) as priority " +
      "from ( " +
      "select * from pptpts " +
      "union all " +
      "select uid, 999 as priority from p where mod >= 2) as asdfasdjfioasjdfoi " +
      // "inner join p on asdfasdjfioasjdfoi.uid = p.uid " +
      "group by asdfasdjfioasjdfoi.uid order by priority desc, asdfasdjfioasjdfoi.uid asc), " +


      // "mod_pptpts2 as (select fjoisjdfio.uid, max(fjoisjdfio.priority) as priority "+
      //     "from ( " +
      //         "select * from pptpts " +
      //         "UNION ALL " +
      //         "select uid, 999 as priority from p where mod >= 2) as fjoisjdfio " +
      //     "group by fjoisjdfio.uid order by fjoisjdfio.priority desc, fjoisjdfio.uid), " +

      // without blocked
      "final_set as (select * from mod_pptpts " +
      // "where uid not in (select uid from p where mod < 0) "+ // remove from twitter set intead.
      "limit ($3) " +
      ") " + // in invisible_uids

      "select " +
      "final_set.priority, " +
      "twitter_users.twitter_user_id as tw__twitter_user_id, " +
      "twitter_users.screen_name as tw__screen_name, " +
      "twitter_users.name as tw__name, " +
      "twitter_users.followers_count as tw__followers_count, " +
      // "twitter_users.friends_count as tw__friends_count, " +
      "twitter_users.verified as tw__verified, " +
      // "twitter_users.profile_image_url_https as tw__profile_image_url_https, " +
      "twitter_users.location as tw__location, " +
      // "twitter_users.response as tw__response, " +
      // "twitter_users.modified as tw__modified, " +
      // "twitter_users.created as tw__created, " +
      "facebook_users.fb_user_id as fb__fb_user_id, " +
      "facebook_users.fb_name as fb__fb_name, " +
      "facebook_users.fb_link as fb__fb_link, " +
      "facebook_users.fb_public_profile as fb__fb_public_profile, " +
      // "facebook_users.fb_login_status as fb__fb_login_status, " +
      // "facebook_users.fb_auth_response as fb__fb_auth_response, " +
      // "facebook_users.fb_access_token as fb__fb_access_token, " +
      // "facebook_users.fb_granted_scopes as fb__fb_granted_scopes, " +
      // "facebook_users.fb_location_id as fb__fb_location_id, " +
      "facebook_users.location as fb__location, " +
      // "facebook_users.response as fb__response, " +
      // "facebook_users.fb_friends_response as fb__fb_friends_response, " +
      // "facebook_users.created as fb__created, " +
      // "all_friends.uid is not null as is_fb_friend, " +
      "xids_subset.x_profile_image_url as x_profile_image_url, " +
      "xids_subset.xid as xid, " +
      "xids_subset.x_name as x_name, " +
      "xids_subset.x_email as x_email, " +
      // "final_set.uid " +
      "p.pid " +
      "from final_set " +
      "left join twitter_users on final_set.uid = twitter_users.uid " +
      "left join facebook_users on final_set.uid = facebook_users.uid " +
      "left join xids_subset on final_set.uid = xids_subset.uid " +
      "left join p on final_set.uid = p.uid " +
      // "left join all_fb_usersriends on all_friends.uid = p.uid " +
      ";";

    return pg.queryP_metered_readOnly("getSocialParticipants", q, [zid, uid, limit, mod]).then(function(response) {
      console.log('getSocialParticipants', response);
      socialParticipantsCache.set(cacheKey, response);
      return response;
    });
  }

  // function getFacebookFriendsInConversation(zid, uid) {
  //   if (!uid) {
  //     return Promise.resolve([]);
  //   }
  //   let p = pg.queryP_readOnly(
  //     "select * from " +
  //     "(select * from " +
  //     "(select * from " +
  //     "(select friend as uid from facebook_friends where uid = ($2) union select uid from facebook_friends where friend = ($2) union select uid from facebook_users where uid = ($2)) as friends) " +
  //     // ^ as friends
  //     "as fb natural left join facebook_users) as fb2 " +
  //     "inner join (select * from participants where zid = ($1) and (vote_count > 0 OR uid = ($2))) as p on fb2.uid = p.uid;", [zid, uid]);
  //   //"select * from (select * from (select friend as uid from facebook_friends where uid = ($2) union select uid from facebook_friends where friend = ($2)) as friends where uid in (select uid from participants where zid = ($1))) as fb natural left join facebook_users;", [zid, uid]);
  //   return p;
  // }

  // function getFacebookUsersInConversation(zid) {
  //   let p = pg.queryP_readOnly("select * from facebook_users inner join (select * from participants where zid = ($1) and vote_count > 0) as p on facebook_users.uid = p.uid;", [zid]);
  //   return p;
  // }

  function getSocialInfoForUsers(uids, zid) {
    uids = _.uniq(uids);
    uids.forEach(function(uid) {
      if (!_.isNumber(uid)) {
        throw "polis_err_123123_invalid_uid got:" + uid;
      }
    });
    if (!uids.length) {
      return Promise.resolve([]);
    }
    let uidString = uids.join(",");
    return pg.queryP_metered_readOnly("getSocialInfoForUsers", "with "+
      "x as (select * from xids where uid in (" + uidString + ") and owner  in (select org_id from conversations where zid = ($1))), "+
      "fb as (select * from facebook_users where uid in (" + uidString + ")), "+
      "tw as (select * from twitter_users where uid in (" + uidString + ")), "+
      "foo as (select *, coalesce(fb.uid, tw.uid) as foouid from fb full outer join tw on tw.uid = fb.uid) "+
      "select *, coalesce(foo.foouid, x.uid) as uid from foo full outer join x on x.uid = foo.foouid;", [zid]);
  }

  function updateVoteCount(zid, pid) {
    // return pg.queryP("update participants set vote_count = vote_count + 1 where zid = ($1) and pid = ($2);",[zid, pid]);
    return pg.queryP("update participants set vote_count = (select count(*) from votes where zid = ($1) and pid = ($2)) where zid = ($1) and pid = ($2)", [zid, pid]);
  }


  // zid_pid => "math_tick:ppaddddaadadaduuuuuuuuuuuuuuuuu"; // not using objects to save some ram
  // TODO consider "p2a24a2dadadu15" format
  let votesForZidPidCache = new LruCache({
    max: 5000,
  });


  function getVotesForZidPidWithTimestampCheck(zid, pid, math_tick) {
    let key = zid + "_" + pid;
    let cachedVotes = votesForZidPidCache.get(key);
    if (cachedVotes) {
      let pair = cachedVotes.split(":");
      let cachedTime = Number(pair[0]);
      let votes = pair[1];
      if (cachedTime >= math_tick) {
        return votes;
      }
    }
    return null;
  }


  function cacheVotesForZidPidWithTimestamp(zid, pid, math_tick, votes) {
    let key = zid + "_" + pid;
    let val = math_tick + ":" + votes;
    votesForZidPidCache.set(key, val);
  }


  // returns {pid -> "adadddadpupuuuuuuuu"}
  function getVotesForZidPidsWithTimestampCheck(zid, pids, math_tick) {
    let cachedVotes = pids.map(function(pid) {
      return {
        pid: pid,
        votes: getVotesForZidPidWithTimestampCheck(zid, pid, math_tick),
      };
    });
    let uncachedPids = cachedVotes.filter(function(o) {
      return !o.votes;
    }).map(function(o) {
      return o.pid;
    });
    cachedVotes = cachedVotes.filter(function(o) {
      return !!o.votes;
    });

    function toObj(items) {
      let o = {};
      for (var i = 0; i < items.length; i++) {
        o[items[i].pid] = items[i].votes;
      }
      return o;
    }

    if (uncachedPids.length === 0) {
      return Promise.resolve(toObj(cachedVotes));
    }
    return getVotesForPids(zid, uncachedPids).then(function(votesRows) {
      let newPidToVotes = aggregateVotesToPidVotesObj(votesRows);
      _.each(newPidToVotes, function(votes, pid) {
        cacheVotesForZidPidWithTimestamp(zid, pid, math_tick, votes);
      });
      let cachedPidToVotes = toObj(cachedVotes);
      return Object.assign(newPidToVotes, cachedPidToVotes);
    });
  }


  function getVotesForPids(zid, pids) {
    if (pids.length === 0) {
      return Promise.resolve([]);
    }
    return pg.queryP_readOnly("select * from votes where zid = ($1) and pid in (" + pids.join(",") + ") order by pid, tid, created;", [zid]).then(function(votesRows) {
      for (var i = 0; i < votesRows.length; i++) {
        votesRows[i].weight = votesRows[i].weight / 32767;
      }
      return votesRows;
    });
  }



  function createEmptyVoteVector(greatestTid) {
    let a = [];
    for (var i = 0; i <= greatestTid; i++) {
      a[i] = "u"; // (u)nseen
    }
    return a;
  }

  function aggregateVotesToPidVotesObj(votes) {
    let i = 0;
    let greatestTid = 0;
    for (i = 0; i < votes.length; i++) {
      if (votes[i].tid > greatestTid) {
        greatestTid = votes[i].tid;
      }
    }

    // use arrays or strings?
    let vectors = {}; // pid -> sparse array
    for (i = 0; i < votes.length; i++) {
      let v = votes[i];
      // set up a vector for the participant, if not there already

      vectors[v.pid] = vectors[v.pid] || createEmptyVoteVector(greatestTid);
      // assign a vote value at that location
      let vote = v.vote;
      if (polisTypes.reactions.push === vote) {
        vectors[v.pid][v.tid] = 'd';
      } else if (polisTypes.reactions.pull === vote) {
        vectors[v.pid][v.tid] = 'a';
      } else if (polisTypes.reactions.pass === vote) {
        vectors[v.pid][v.tid] = 'p';
      } else {
        console.error("unknown vote value");
        // let it stay 'u'
      }

    }
    let vectors2 = {};
    _.each(vectors, function(val, key) {
      vectors2[key] = val.join("");
    });
    return vectors2;
  }


  function getLocationsForParticipants(zid) {
    return pg.queryP_readOnly("select * from participant_locations where zid = ($1);", [zid]);
  }

  function getPidsForGid(zid, gid, math_tick) {
    return Promise.all([
      getPca(zid, math_tick),
      getBidIndexToPidMapping(zid, math_tick),
    ]).then(function(o) {
      if (!o[0] || !o[0].asPOJO) {
        return [];
      }
      o[0] = o[0].asPOJO;
      let clusters = o[0]['group-clusters'];
      let indexToBid = o[0]['base-clusters'].id; // index to bid
      let bidToIndex = [];
      for (let i = 0; i < indexToBid.length; i++) {
        bidToIndex[indexToBid[i]] = i;
      }
      let indexToPids = o[1].bidToPid; // actually index to [pid]
      let cluster = clusters[gid];
      if (!cluster) {
        return [];
      }
      let members = cluster.members; // bids
      let pids = [];
      for (var i = 0; i < members.length; i++) {
        let bid = members[i];
        let index = bidToIndex[bid];
        let morePids = indexToPids[index];
        Array.prototype.push.apply(pids, morePids);
      }
      pids = pids.map(function(x) {
        return parseInt(x);
      });
      pids.sort(function(a, b) {
        return a - b;
      });
      return pids;
    });
  }



  function geoCodeWithGoogleApi(locationString) {
    let googleApiKey = process.env.GOOGLE_API_KEY;
    let address = encodeURI(locationString);

    return new Promise(function(resolve, reject) {
      request.get("https://maps.googleapis.com/maps/api/geocode/json?address=" + address + "&key=" + googleApiKey).then(function(response) {
        response = JSON.parse(response);
        if (response.status !== "OK") {
          reject("polis_err_geocoding_failed");
          return;
        }
        let bestResult = response.results[0]; // NOTE: seems like there could be multiple responses - using first for now
        resolve(bestResult);
      }, reject).catch(reject);
    });
  }

  function geoCode(locationString) {
    return pg.queryP("select * from geolocation_cache where location = ($1);", [locationString]).then(function(rows) {
      if (!rows || !rows.length) {
        return geoCodeWithGoogleApi(locationString).then(function(result) {
          winston.log("info", result);
          let lat = result.geometry.location.lat;
          let lng = result.geometry.location.lng;
          // NOTE: not waiting for the response to this - it might fail in the case of a race-condition, since we don't have upsert
          pg.queryP("insert into geolocation_cache (location,lat,lng,response) values ($1,$2,$3,$4);", [
            locationString,
            lat,
            lng,
            JSON.stringify(result),
          ]);
          let o = {
            lat: lat,
            lng: lng,
          };
          return o;
        });
      } else {
        let o = {
          lat: rows[0].lat,
          lng: rows[0].lng,
        };
        return o;
      }
    });
  }


  let twitterShareCountCache = LruCache({
    maxAge: 1000 * 60 * 30, // 30 minutes
    max: 999,
  });

  function getTwitterShareCountForConversation(conversation_id) {
    let cached = twitterShareCountCache.get(conversation_id);
    if (cached) {
      return Promise.resolve(cached);
    }
    let httpUrl = "https://cdn.api.twitter.com/1/urls/count.json?url=http://pol.is/" + conversation_id;
    let httpsUrl = "https://cdn.api.twitter.com/1/urls/count.json?url=https://pol.is/" + conversation_id;
    return Promise.all([
      request.get(httpUrl),
      request.get(httpsUrl),
    ]).then(function(a) {
      let httpResult = a[0];
      let httpsResult = a[1];
      let httpCount = JSON.parse(httpResult).count;
      let httpsCount = JSON.parse(httpsResult).count;
      if (httpCount > 0 && httpsCount > 0 && httpCount === httpsCount) {
        console.warn("found matching http and https twitter share counts, if this is common, check twitter api to see if it has changed.");
      }
      let count = httpCount + httpsCount;
      twitterShareCountCache.set(conversation_id, count);
      return count;
    });
  }

  let fbShareCountCache = LruCache({
    maxAge: 1000 * 60 * 30, // 30 minutes
    max: 999,
  });

  function getFacebookShareCountForConversation(conversation_id) {
    let cached = fbShareCountCache.get(conversation_id);
    if (cached) {
      return Promise.resolve(cached);
    }
    let url = "http://graph.facebook.com/\?id\=https://pol.is/" + conversation_id;
    return request.get(url).then(function(result) {
      let shares = JSON.parse(result).shares;
      fbShareCountCache.set(conversation_id, shares);
      return shares;
    });
  }


  function getParticipantDemographicsForConversation(zid) {
    return pg.queryP("select * from demographic_data left join participants on participants.uid = demographic_data.uid where zid = ($1);", [zid]);
  }

  function getParticipantVotesForCommentsFlaggedWith_is_meta(zid) {
    return pg.queryP("select tid, pid, vote from votes_latest_unique where zid = ($1) and tid in (select tid from comments where zid = ($1) and is_meta = true)", [zid]);
  }


  function handle_GET_groupDemographics(req, res) {
    let zid = req.p.zid;
    Promise.all([
      getPidsForGid(zid, 0, -1),
      getPidsForGid(zid, 1, -1),
      getPidsForGid(zid, 2, -1),
      getPidsForGid(zid, 3, -1),
      getPidsForGid(zid, 4, -1),
      getParticipantDemographicsForConversation(zid),
      getParticipantVotesForCommentsFlaggedWith_is_meta(zid),
      isModerator(req.p.zid, req.p.uid),
    ]).then((o) => {
      let groupPids = [];
      let groupStats = [];

      let meta = o[5];
      let metaVotes = o[6];
      let isMod = o[7];

      const isReportQuery = !_.isUndefined(req.p.rid);

      if (!isMod && !isReportQuery) {
        throw "polis_err_groupDemographics_auth";
      }

      for (let i = 0; i < 5; i++) {
        if (o[i] && o[i].length) {
          groupPids.push(o[i]);

          groupStats.push({
            gid: i,
            count: 0,
            // fb_gender_male: 0,
            // fb_gender_female: 0,
            // fb_gender_null: 0,
            // ms_gender_estimate_fb_male: 0,
            // ms_gender_estimate_fb_female: 0,
            // ms_gender_estimate_fb_null: 0,
            // gender_guess_male: 0,
            // gender_guess_female: 0,
            // gender_guess_null: 0,
            // ms_birth_year_estimate_fb: 0,
            // ms_birth_year_count: 0,
            // birth_year_guess: 0,
            // birth_year_guess_count: 0,

            // convenient counts
            gender_male: 0,
            gender_female: 0,
            gender_null: 0,
            birth_year: 0,
            birth_year_count: 0,

            meta_comment_agrees: {},
            meta_comment_disagrees: {},
            meta_comment_passes: {},

          });
        } else {
          break;
        }
      }


      meta = _.indexBy(meta, 'pid');
      let pidToMetaVotes = _.groupBy(metaVotes, 'pid');

      for (let i = 0; i < groupStats.length; i++) {
        let s = groupStats[i];
        let pids = groupPids[i];
        for (let p = 0; p < pids.length; p++) {
          let pid = pids[p];
          let ptptMeta = meta[pid];
          if (ptptMeta) {
            s.count += 1;
            // if (ptptMeta.fb_gender === 0) {
            //   s.fb_gender_male += 1;
            // } else if (ptptMeta.fb_gender === 1) {
            //   s.fb_gender_female += 1;
            // } else {
            //   s.fb_gender_null += 1;
            // }
            // if (ptptMeta.gender_guess === 0) {
            //   s.gender_guess_male += 1;
            // } else if (ptptMeta.gender_guess === 1) {
            //   s.gender_guess_female += 1;
            // } else {
            //   s.gender_guess_null += 1;
            // }
            // if (ptptMeta.ms_birth_year_estimate_fb > 1900) {
            //   s.ms_birth_year_estimate_fb += ptptMeta.ms_birth_year_estimate_fb;
            //   s.ms_birth_year_count += 1;
            // }
            // if (ptptMeta.ms_gender_estimate_fb === 0) {
            //   s.ms_gender_estimate_fb_male += 1;
            // } else if (ptptMeta.ms_gender_estimate_fb === 1) {
            //   s.ms_gender_estimate_fb_female += 1;
            // } else {
            //   s.ms_gender_estimate_fb_null += 1;
            // }

            // if (ptptMeta.birth_year_guess) {
            //   s.birth_year_guess += ptptMeta.birth_year_guess;
            //   s.birth_year_guess_count += 1;
            // }

            // compute convenient counts
            let gender = null;
            if (_.isNumber(ptptMeta.fb_gender)) {
              gender = ptptMeta.fb_gender;
            } else if (_.isNumber(ptptMeta.gender_guess)) {
              gender = ptptMeta.gender_guess;
            } else if (_.isNumber(ptptMeta.ms_gender_estimate_fb)) {
              gender = ptptMeta.ms_gender_estimate_fb;
            }
            if (gender === 0) {
              s.gender_male += 1;
            } else if (gender === 1) {
              s.gender_female += 1;
            } else {
              s.gender_null += 1;
            }
            let birthYear = null;
            if (ptptMeta.ms_birth_year_estimate_fb > 1900) {
              birthYear = ptptMeta.ms_birth_year_estimate_fb;
            } else if (ptptMeta.birth_year_guess > 1900) {
              birthYear = ptptMeta.birth_year_guess;
            }
            if (birthYear > 1900) {
              s.birth_year += birthYear;
              s.birth_year_count += 1;
            }

          }
          let ptptMetaVotes = pidToMetaVotes[pid]
          if (ptptMetaVotes) {
            for (let v = 0; v < ptptMetaVotes.length; v++) {
              let vote = ptptMetaVotes[v];
              if (vote.vote === polisTypes.reactions.pass) {
                s.meta_comment_passes[vote.tid] = 1 + (s.meta_comment_passes[vote.tid] || 0)
              } else if (vote.vote === polisTypes.reactions.pull) {
                s.meta_comment_agrees[vote.tid] = 1 + (s.meta_comment_agrees[vote.tid] || 0)
              } else if (vote.vote === polisTypes.reactions.push) {
                s.meta_comment_disagrees[vote.tid] = 1 + (s.meta_comment_disagrees[vote.tid] || 0)
              }
            }
          }
        }
        s.ms_birth_year_estimate_fb = s.ms_birth_year_estimate_fb / s.ms_birth_year_count;
        s.birth_year_guess = s.birth_year_guess / s.birth_year_guess_count;
        s.birth_year = s.birth_year / s.birth_year_count;
      }



      res.json(groupStats);

    }).catch((err) => {
      fail(res, 500, "polis_err_groupDemographics", err);
    });
  }

  // this is for testing the encryption
  function handle_GET_logMaxmindResponse(req, res) {
    if (!isPolisDev(req.p.uid) || !devMode) {
      return fail(res, 403, "polis_err_permissions", err);
    }
    pg.queryP("select * from participants_extended where zid = ($1) and uid = ($2);", [req.p.zid, req.p.user_uid]).then((results) => {
      if (!results || !results.length) {
        res.json({});
        console.log("NOTHING");
        return;
      }
      var o = results[0];
      _.each(o, (val, key) => {
        if (key.startsWith("encrypted_")) {
          o[key] = decrypt(val);
        }
      });
      console.log(o);
      res.json({});
    }).catch((err) => {
      fail(res, 500, "polis_err_get_participantsExtended", err);
    });
  }

  function handle_GET_locations(req, res) {
    let zid = req.p.zid;
    let gid = req.p.gid;

    Promise.all([
      getPidsForGid(zid, gid, -1),
      getLocationsForParticipants(zid),
    ]).then(function(o) {
      let pids = o[0];
      let locations = o[1];
      locations = locations.filter(function(locData) {
        let pidIsInGroup = _.indexOf(pids, locData.pid, true) >= 0; // uses binary search
        return pidIsInGroup;
      });
      locations = locations.map(function(locData) {
        return {
          lat: locData.lat,
          lng: locData.lng,
          n: 1,
        };
      });
      res.status(200).json(locations);
    }).catch(function(err) {
      fail(res, 500, "polis_err_locations_01", err);
    });
  }


  function removeNullOrUndefinedProperties(o) {
    for (var k in o) {
      let v = o[k];
      if (v === null || v === undefined) {
        delete o[k];
      }
    }
    return o;
  }

  function pullXInfoIntoSubObjects(ptptoiRecord) {
    let p = ptptoiRecord;
    if (p.x_profile_image_url || p.xid || p.x_email) {
      p.xInfo = {};
      p.xInfo.x_profile_image_url = p.x_profile_image_url;
      p.xInfo.xid = p.xid;
      p.xInfo.x_name = p.x_name;
      // p.xInfo.x_email = p.x_email;
      delete p.x_profile_image_url;
      delete p.xid;
      delete p.x_name;
      delete p.x_email;
    }
    return p;
  }

  function pullFbTwIntoSubObjects(ptptoiRecord) {
    let p = ptptoiRecord;
    let x = {};
    _.each(p, function(val, key) {
      let fbMatch = /fb__(.*)/.exec(key);
      let twMatch = /tw__(.*)/.exec(key);
      if (fbMatch && fbMatch.length === 2 && val !== null) {
        x.facebook = x.facebook || {};
        x.facebook[fbMatch[1]] = val;
      } else if (twMatch && twMatch.length === 2 && val !== null) {
        x.twitter = x.twitter || {};
        x.twitter[twMatch[1]] = val;
      } else {
        x[key] = val;
      }
    });
    // extract props from fb_public_profile
    if (x.facebook && x.facebook.fb_public_profile) {
      try {
        let temp = JSON.parse(x.facebook.fb_public_profile);
        x.facebook.verified = temp.verified;
        // shouln't return this to client
        delete x.facebook.fb_public_profile;
      } catch (e) {
        console.error("error parsing JSON of fb_public_profile for uid: ", p.uid);
      }

      if (!_.isUndefined(x.facebook.fb_user_id)) {
        let width = 40;
        let height = 40;
        x.facebook.fb_picture = "https://graph.facebook.com/v2.2/" + x.facebook.fb_user_id + "/picture?width=" + width + "&height=" + height;
      }
    }
    return x;
  }


  function handle_PUT_ptptois(req, res) {
    let zid = req.p.zid;
    let uid = req.p.uid;
    let pid = req.p.pid;
    let mod = req.p.mod;
    isModerator(zid, uid).then(function(isMod) {
      if (!isMod) {
        fail(res, 403, "polis_err_ptptoi_permissions_123");
        return;
      }
      return pg.queryP("update participants set mod = ($3) where zid = ($1) and pid = ($2);", [zid, pid, mod]).then(function() {
        res.status(200).json({});
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_ptptoi_misc_234", err);
    });
  }


  function handle_GET_ptptois(req, res) {
    let zid = req.p.zid;
    let mod = req.p.mod;
    let uid = req.p.uid;
    let limit = 99999;

    let convPromise = getConversationInfo(req.p.zid);
    let socialPtptsPromise = convPromise.then((conv) => {
      return getSocialParticipantsForMod_timed(zid, limit, mod, conv.owner);
    });

    Promise.all([
      socialPtptsPromise,
      getConversationInfo(zid),
    ]).then(function(a) {
      let ptptois = a[0];
      let conv = a[1];
      let isOwner = uid === conv.owner;
      let isAllowed = isOwner || isPolisDev(req.p.uid) || conv.is_data_open;
      if (isAllowed) {
        ptptois = ptptois.map(pullXInfoIntoSubObjects);
        ptptois = ptptois.map(removeNullOrUndefinedProperties);
        ptptois = ptptois.map(pullFbTwIntoSubObjects);
        ptptois = ptptois.map(function(p) {
          p.conversation_id = req.p.conversation_id;
          return p;
        });

      } else {
        ptptois = [];
      }
      res.status(200).json(ptptois);
    }).catch(function(err) {
      fail(res, 500, "polis_err_ptptoi_misc", err);
    });
  }

  function handle_GET_votes_famous(req, res) {
    doFamousQuery(req.p, req).then(function(data) {
      res.status(200).json(data);
    }, function(err) {
      fail(res, 500, "polis_err_famous_proj_get2", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_famous_proj_get1", err);
    });
  }



  function doFamousQuery(o, req) {
    let uid = o.uid;
    let zid = o.zid;
    let math_tick = o.math_tick;

    // NOTE: if this API is running slow, it's probably because fetching the PCA from pg is slow, and PCA caching is disabled

    // let twitterLimit = 999; // we can actually check a lot of these, since they might be among the fb users
    // let softLimit = 26;
    let hardLimit = _.isUndefined(o.ptptoiLimit) ? 30 : o.ptptoiLimit;
    // let ALLOW_NON_FRIENDS_WHEN_EMPTY_SOCIAL_RESULT = true;
    let mod = 0; // for now, assume all conversations will show unmoderated and approved participants.

    function getAuthorUidsOfFeaturedComments() {
      return getPca(zid, 0).then(function(pcaData) {
        if (!pcaData) {
          return [];
        }
        pcaData = pcaData.asPOJO;
        pcaData.consensus = pcaData.consensus || {};
        pcaData.consensus.agree = pcaData.consensus.agree || [];
        pcaData.consensus.disagree = pcaData.consensus.disagree || [];
        let consensusTids = _.union(
          _.pluck(pcaData.consensus.agree, "tid"),
          _.pluck(pcaData.consensus.disagree, "tid"));

        let groupTids = [];
        for (var gid in pcaData.repness) {
          let commentData = pcaData.repness[gid];
          groupTids = _.union(groupTids, _.pluck(commentData, "tid"));
        }
        let featuredTids = _.union(consensusTids, groupTids);
        featuredTids.sort();
        featuredTids = _.uniq(featuredTids);

        if (featuredTids.length === 0) {
          return [];
        }
        let q = "with " +
          "authors as (select distinct(uid) from comments where zid = ($1) and tid in (" + featuredTids.join(",") + ") order by uid) " +
          "select authors.uid from authors inner join facebook_users on facebook_users.uid = authors.uid " +
          "union " +
          "select authors.uid from authors inner join twitter_users on twitter_users.uid = authors.uid " +
          "union " +
          "select authors.uid from authors inner join xids on xids.uid = authors.uid " +
          "order by uid;";

        return pg.queryP_readOnly(q, [zid]).then(function(comments) {
          let uids = _.pluck(comments, "uid");
          console.log('famous uids', uids);

          uids = _.uniq(uids);
          return uids;
        });
      });
    }


    return Promise.all([getConversationInfo(zid), getAuthorUidsOfFeaturedComments()]).then(function(a) {
      let conv = a[0];
      let authorUids = a[1];

      if (conv.is_anon) {
        return {};
      }

      return Promise.all([
        getSocialParticipants(zid, uid, hardLimit, mod, math_tick, authorUids),
        // getFacebookFriendsInConversation(zid, uid),
        // getTwitterUsersInConversation(zid, uid, twitterLimit),
        // getPolisSocialSettings(zid, uid),
        // getPidPromise(zid, uid),
      ]).then(function(stuff) {
        //     // if we didn't find any FB friends or Twitter users, find some that aren't friends
        //     // This may or may not be the right thing to do, but the reasoning is that it will help people understand what Polis is. Empty buckets will be confusing.
        //     let facebookFriends = stuff[0] || [];
        //     let twitterParticipants = stuff[1] || [];
        //     if (ALLOW_NON_FRIENDS_WHEN_EMPTY_SOCIAL_RESULT &&
        //         !facebookFriends.length &&
        //         !twitterParticipants.length) {
        //         return getFacebookUsersInConversation(zid, softLimit).then(function(fb) {
        //             stuff[0] = fb;
        //             return stuff;
        //         });
        //     } else {
        //         return stuff;
        //     }
        // }).then(function(stuff) {

        let participantsWithSocialInfo = stuff[0] || [];
        // let facebookFriends = stuff[0] || [];
        // let twitterParticipants = stuff[1] || [];
        // let polisSocialSettings = stuff[2] || [];
        // let myPid = stuff[3];
        // let pidToData = {};
        // let pids = [];
        // twitterParticipants.map(function(p) {
        //     return p.pid;
        // });

        // function shouldSkip(p) {
        //     let pidAlreadyAdded = !!pidToData[p.pid];
        //     let isSelf = p.pid === myPid;
        //     if (!pidAlreadyAdded && !isSelf && pids.length > softLimit) {
        //         if (pids.length > hardLimit) {
        //             return true;
        //         }
        //         // if we're beyond the soft limit, allow only high-profile twitter users
        //         if (p.followers_count < 1000) { // if this is run on FB, will be falsy
        //             return true;
        //         }
        //     }
        //     return false;
        // }


        // TODO There are issues with this:
        //   really, the data should all be merged first, then the list should be truncated to the correct number.
        // ALSO, we could return data on everyone who might appear in the list view, and add an "importance" score to help determine who to show in the vis at various screen sizes. (a client determination)
        // ALSO, per-group-minimums: we should include at least a facebook friend and at least one famous twitter user(if they exist) per group

        participantsWithSocialInfo = participantsWithSocialInfo.map(function(p) {
          let x = pullXInfoIntoSubObjects(p);
          // nest the fb and tw properties in sub objects
          x = pullFbTwIntoSubObjects(x);

          if (p.priority === 1000) {
            x.isSelf = true;
          }
          if (x.twitter) {
            x.twitter.profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + x.twitter.twitter_user_id;
          }
          // // don't include FB info to non-friends
          // if (!x.is_fb_friend && !x.isSelf) {
          //     delete x.facebook;
          // }
          return x;
        });

        let pids = participantsWithSocialInfo.map(function(p) {
          return p.pid;
        });
        console.log('mike1234', pids.length);

        let pidToData = _.indexBy(participantsWithSocialInfo, "pid"); // TODO this is extra work, probably not needed after some rethinking
        console.log('mike12345', pidToData);

        // polisSocialSettings.forEach(function(p) {
        //     if (shouldSkip(p)) {
        //         return;
        //     }
        //     pids.push(p.pid);
        //     pidToData[p.pid] = pidToData[p.pid] || {};
        //     pidToData[p.pid].polis = p;
        // });

        // facebookFriends.forEach(function(p) {
        //     if (shouldSkip(p)) {
        //         return;
        //     }
        //     pids.push(p.pid);
        //     pidToData[p.pid] = pidToData[p.pid] || {};
        //     pidToData[p.pid].facebook = _.pick(p,
        //         'fb_link',
        //         'fb_name',
        //         'fb_user_id',
        //         'fb_link',
        //         'location');
        // });
        // twitterParticipants.forEach(function(p) {
        //     if (shouldSkip(p)) {
        //         return;
        //     }
        //     // clobber the reference for the twitter profile pic, with our proxied version.
        //     // This is done because the reference we have can be stale.
        //     // Twitter has a bulk info API, which would work, except that it's slow, so proxying these and letting CloudFlare cache them seems better.
        //     p.profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + p.twitter_user_id;

        //     pids.push(p.pid);
        //     pidToData[p.pid] = pidToData[p.pid] || {};
        //     pidToData[p.pid].twitter = _.pick(p,
        //         'followers_count',
        //         'friends_count',
        //         'verified',
        //         'profile_image_url_https',
        //         'location',
        //         'name',
        //         'screen_name');
        // });

        // ensure that anon users get an entry for themselves. this ensures that they will be shown as a ptptoi, and get included in a group
        // if (pids.indexOf(myPid) === -1) {
        //     pids.push(myPid);
        // }
        // pidToData[myPid]= pidToData[myPid] || {};

        pids.sort(function(a, b) {
          return a - b;
        });
        pids = _.uniq(pids, true);

        console.log('mike12346', pids);

        return getVotesForZidPidsWithTimestampCheck(zid, pids, math_tick).then(function(vectors) {

          // TODO parallelize with above query
          return getBidsForPids(zid, -1, pids).then(function(pidsToBids) {
            _.each(vectors, function(value, pid, list) {
              pid = parseInt(pid);
              let bid = pidsToBids[pid];
              let notInBucket = _.isUndefined(bid);
              let isSelf = pidToData[pid].isSelf;
              // winston.log("info","pidToData", pid, myPid, isSelf);
              // winston.log("info",pidToData[pid]);
              if (notInBucket && !isSelf) {
                // pidToData[pid].ignore = true;
                console.log('mike12347', 'deleting', pid);
                delete pidToData[pid]; // if the participant isn't in a bucket, they probably haven't voted enough for the math worker to bucketize them.
              } else if (!!pidToData[pid]) {
                console.log('mike12348', 'keeping', pid);
                pidToData[pid].votes = value; // no separator, like this "adupuuauuauupuuu";
                pidToData[pid].bid = bid;
              }
            });
            return pidToData;
          }, function(err) {
            // looks like there is no pca yet, so nothing to return.
            return {};
          });
        });
      });
    });
  } // end doFamousQuery

  function handle_GET_twitter_users(req, res) {
    let uid = req.p.uid;
    let p;
    if (uid) {
      p = pg.queryP_readOnly("select * from twitter_users where uid = ($1);", [uid]);
    } else if (req.p.twitter_user_id) {
      p = pg.queryP_readOnly("select * from twitter_users where twitter_user_id = ($1);", [req.p.twitter_user_id]);
    } else {
      fail(res, 401, "polis_err_missing_uid_or_twitter_user_id");
      return;
    }
    p.then(function(data) {
      data = data[0];
      data.profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + data.twitter_user_id;
      res.status(200).json(data);
    }).catch(function(err) {
      fail(res, 500, "polis_err_twitter_user_info_get", err);
    });
  }

  function doSendEinvite(req, email) {
    return generateTokenP(30, false).then(function(einvite) {
      return pg.queryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function(rows) {
        return sendEinviteEmail(req, email, einvite);
      });
    });
  }

  function doSendVerification(req, email) {
    return generateTokenP(30, false).then(function(einvite) {
      return pg.queryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function(rows) {
        return sendVerificaionEmail(req, email, einvite);
      });
    });
  }



  function handle_GET_slack_login(req, res) {

    function finish(uid) {
      startSessionAndAddCookies(req, res, uid).then(function() {
        res.set({
          'Content-Type': 'text/html',
        });
        let html = "" +
          "<!DOCTYPE html><html lang='en'>" +
          '<head>' +
          '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
          '</head>' +
          "<body style='max-width:320px; font-family: Futura, Helvetica, sans-serif;'>" +
          "logged in!" +
          "</body></html>";
        res.status(200).send(html);
      }).catch((err) => {
        fail(res, 500, "polis_err_slack_login_session_start", err);
      });
    }

    const existing_uid_for_client = req.p.uid;
    const token = /\/slack_login_code\/([^\/]*)/.exec(req.path)[1];

    pg.queryP("select * from slack_user_invites where token = ($1);", [
      token,
    ]).then((rows) => {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_slack_login_unknown_token " + token);
        return;
      }
      const row = rows[0];
      // if (row.created > foo) {
      //   fail(res, 500, "polis_err_slack_login_token_expired");
      //   return;
      // }
      const slack_team = row.slack_team;
      const slack_user_id = row.slack_user_id;
      pg.queryP("select * from slack_users where slack_team = ($1) and slack_user_id = ($2);", [
        slack_team,
        slack_user_id,
      ]).then((rows) => {

        if (!rows || !rows.length) {
          // create new user (or use existing user) and associate a new slack_user entry
          const uidPromise = existing_uid_for_client ? Promise.resolve(existing_uid_for_client) : createDummyUser();
          uidPromise.then((uid) => {
            return pg.queryP("insert into slack_users (uid, slack_team, slack_user_id) values ($1, $2, $3);", [
              uid,
              slack_team,
              slack_user_id,
            ]).then((rows) => {
              finish(uid);
            }, function(err) {
              fail(res, 500, "polis_err_slack_login_03", err);
            });
          }).catch((err) => {
            fail(res, 500, "polis_err_slack_login_02", err);
          });
        } else {
          // slack_users entry exists, so log in as that user
          finish(rows[0].uid);
        }
      }, (err) => {
        fail(res, 500, "polis_err_slack_login_01", err);
      });

    }, (err) => {
      fail(res, 500, "polis_err_slack_login_misc", err);
    });
  }

  function postMessageUsingHttp(o) {
    return new Promise(function(resolve, reject) {
      web.chat.postMessage(o.channel, o.text, o, (err, info) => {
        if (err) {
          reject(err);
        } else {
          resolve(info);
        }
      });
    });
  }


  function handle_POST_slack_interactive_messages(req, res) {
    const payload = JSON.parse(req.p.payload);

    // const attachments = payload.attachments;
    // const bot_id = payload.bot_id;
    // const callback_id = payload.callback_id;
    // const original_message = payload.original_message;
    // const subtype = payload.subtype;
    // const ts = payload.ts;
    // const type = payload.type;
    // const username = payload.username;
    const channel = payload.channel;
    const response_url = payload.response_url;
    const team = payload.team;
    const actions = payload.actions;
    // const user = payload.user;

    console.dir(response_url);
    console.dir(payload);



    postMessageUsingHttp({
      channel: channel.id,
      team: team.id,
      text: "woo! you voted: " + actions[0].name,
      "attachments": [
        {
          "text": Math.random(),
          "fallback": "You are unable to choose a game",
          "callback_id": "wopr_game",
          "color": "#3AA3E3",
          "attachment_type": "default",
          "actions": [
            {
              "name": "chess",
              "text": "Chess",
              "type": "button",
              "value": "chess",
            },
            {
              "name": "maze",
              "text": "Falken's Maze",
              "type": "button",
              "value": "maze",
            },
            {
              "name": "war",
              "text": "Thermonuclear War",
              "style": "danger",
              "type": "button",
              "value": "war",
              "confirm": {
                "title": "Are you sure?",
                "text": "Wouldn't you prefer a good game of chess?",
                "ok_text": "Yes",
                "dismiss_text": "No",
              },
            },
          ],
        },
      ],
    }).then((result) => {
      // console.dir(req.p);
      res.status(200).send("");
    }).catch((err) => {
      fail(res, 500, "polis_err_slack_interactive_messages_000", err);
    });
  }

  function handle_POST_slack_user_invites(req, res) {
    const slack_team = req.p.slack_team;
    const slack_user_id = req.p.slack_user_id;
    generateTokenP(99, false).then(function(token) {
      pg.queryP("insert into slack_user_invites (slack_team, slack_user_id, token) values ($1, $2, $3);", [
        slack_team,
        slack_user_id,
        token,
      ]).then((rows) => {
        res.json({
          url: getServerNameWithProtocol(req) + "/slack_login_code/" + token,
        });
      }, (err) => {
        fail(res, 500, "polis_err_creating_slack_user_invite", err);
      });
    });
  }

  function handle_POST_einvites(req, res) {
    let email = req.p.email;
    doSendEinvite(req, email).then(function() {
      res.status(200).json({});
    }).catch(function(err) {
      fail(res, 500, "polis_err_sending_einvite", err);
    });
  }

  // function handle_GET_cache_purge(req, res) {

  //   let hostname = "pol.is";
  //   // NOTE: can't purge preprod independently unless we set up a separate domain on cloudflare, AFAIK

  //   request.post("https://www.cloudflare.com/api_json.html").form({
  //     a: 'fpurge_ts',
  //     tkn: process.env.CLOUDFLARE_API_KEY,
  //     email: process.env.CLOUDFLARE_API_EMAIL,
  //     z: hostname,
  //     v: 1,
  //   })
  //   .pipe(res);

  // }


  function handle_GET_einvites(req, res) {
    let einvite = req.p.einvite;

    winston.log("info", "select * from einvites where einvite = ($1);", [einvite]);
    pg.queryP("select * from einvites where einvite = ($1);", [einvite]).then(function(rows) {
      if (!rows.length) {
        throw new Error("polis_err_missing_einvite");
      }
      res.status(200).json(rows[0]);
    }).catch(function(err) {
      fail(res, 500, "polis_err_fetching_einvite", err);
    });
  }


  function handle_POST_contributors(req, res) {
    const uid = req.p.uid || null;
    const agreement_version = req.p.agreement_version;
    const name = req.p.name;
    const email = req.p.email;
    const github_id = req.p.github_id;
    const company_name = req.p.company_name;

    pg.queryP("insert into contributor_agreement_signatures (uid, agreement_version, github_id, name, email, company_name) " +
      "values ($1, $2, $3, $4, $5, $6);", [uid, agreement_version, github_id, name, email, company_name]).then(() => {

        emailTeam("contributer agreement signed",  [uid, agreement_version, github_id, name, email, company_name].join("\n"));

        res.json({});

      }, (err) => {
        fail(res, 500, "polis_err_POST_contributors_misc", err);
      });
  }

  function handle_POST_waitinglist(req, res) {
    let intercom_lead_user_id;
    intercomClient.leads.create().then((x) => {

      intercom_lead_user_id = x.body.user_id;
      return intercom_lead_user_id;
    }).then(() => {

      var custom = {
        campaign: req.p.campaign,
      };
      if (req.p.affiliation) {
        custom.affiliation = req.p.affiliation;
      }
      if (req.p.role) {
        custom.role = req.p.role;
      }
      return intercomClient.leads.update({
        user_id: intercom_lead_user_id,
        email: req.p.email,
        last_request_at: Date.now(),
        name: req.p.name,
        custom_attributes: custom,
      });
    }).then(() => {
      return pg.queryP(
        "insert into waitinglist (email, campaign, affiliation, role, intercom_lead_user_id, name) values ($1, $2, $3, $4, $5, $6);", [
          req.p.email,
          req.p.campaign,
          req.p.affiliation || null,
          req.p.role || null,
          intercom_lead_user_id,
          req.p.name,
        ]);
    }).then(() => {
      res.json({});
    }).catch((err) => {
      fail(res, 500, "polis_err_POST_waitinglist", err);
    });
  }


  function generateSingleUseUrl(req, conversation_id, suzinvite) {
    return getServerNameWithProtocol(req) + "/ot/" + conversation_id + "/" + suzinvite;
  }


  function buildConversationUrl(req, zinvite) {
    return getServerNameWithProtocol(req) + "/" + zinvite;
  }

  function buildConversationDemoUrl(req, zinvite) {
    return getServerNameWithProtocol(req) + "/demo/" + zinvite;
  }

  function buildModerationUrl(req, zinvite) {
    return getServerNameWithProtocol(req) + "/m/" + zinvite;
  }

  function buildSeedUrl(req, zinvite) {
    return buildModerationUrl(req, zinvite) + "/comments/seed";
  }

  function getConversationUrl(req, zid, dontUseCache) {
    return getZinvite(zid, dontUseCache).then(function(zinvite) {
      return buildConversationUrl(req, zinvite);
    });
  }


  function createOneSuzinvite(xid, zid, owner, generateSingleUseUrl) {
    return generateSUZinvites(1).then(function(suzinviteArray) {
      let suzinvite = suzinviteArray[0];
      return pg.queryP(
          "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ($1, $2, $3, $4);", [suzinvite, xid, zid, owner])
        .then(function(result) {
          return getZinvite(zid);
        }).then(function(conversation_id) {
          return {
            zid: zid,
            conversation_id: conversation_id,
          };
        }).then(function(o) {
          return {
            zid: o.zid,
            conversation_id: o.conversation_id,
            suurl: generateSingleUseUrl(o.conversation_id, suzinvite),
          };
        });
    });
  }



  function renderLtiLinkagePage(req, res, afterJoinRedirectUrl) {
    let context_id = req.p.context_id;
    let user_id = req.p.user_id;
    let user_image = req.p.user_image;
    let tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;

    let greeting = '';


    // TODO If we're doing this basic form, we can't just return json from the /login call

    let form1 = '' +
      '<h2>create a new <img src="https://pol.is/polis-favicon_favicon.png" height="20px"> pol<span class="Logo--blue">.</span>is account</h2>' +
      '<p><form role="form" class="FormVertical" action="' + getServerNameWithProtocol(req) + '/api/v3/auth/new" method="POST">' +
      '<div class="FormVertical-group">' +
      '<label class="FormLabel" for="gatekeeperLoginEmail">Email</label>' +
      '<input type="text" id="email" name="email" id="gatekeeperLoginEmail" style="width: 100%;"  class="FormControl" value="' + (req.p.lis_person_contact_email_primary || "") + '">' +
      '</div>' +
      '<label class="FormLabel" for="gatekeeperLoginName">Full Name</label>' +
      '<input type="text" id="hname" name="hname" id="gatekeeperLoginName" style="width: 100%;"  class="FormControl" value="' + (req.p.lis_person_name_full || "") + '">' +
      '<div class="FormVertical-group">' +
      '<label class="FormLabel" for="gatekeeperLoginPassword">' +
      'Password' +
      '</label>' +
      '<input type="password" id="password" name="password" style="width: 100%;" id="gatekeeperLoginPassword" class="FormControl">' +
      '<div>' +
      '<label class="FormLabel" for="gatekeeperLoginPassword2">' +
      'Repeat Password' +
      '</label>' +
      '<input type="password" id="password2" name="password2" style="width: 100%;" id="gatekeeperLoginPassword2" class="FormControl">' +
      '</div>' +
      '<input type="hidden" name="lti_user_id" value="' + user_id + '">' +
      '<input type="hidden" name="lti_user_image" value="' + user_image + '">' +
      '<input type="hidden" name="lti_context_id" value="' + context_id + '">' +
      '<input type="hidden" name="tool_consumer_instance_guid" value="' + tool_consumer_instance_guid + '">' +
      '<input type="hidden" name="afterJoinRedirectUrl" value="' + afterJoinRedirectUrl + '">' +
      '</div>' +
      '<input type="checkbox" name="gatekeeperTosPrivacy" id="gatekeeperTosPrivacy" style="position: relative; top: -1px"> &nbsp; By signing up, you agree to our <a href="https://pol.is/tos"> terms of use</a> and <a href="https://pol.is/privacy"> privacy policy </a>' +
      '<div class="row" id="errorDiv"></div>' +
      '<div class="FormVertical-group">' +
      '<button type="submit" class="Btn Btn-primary">Create new pol.is account</button>' +
      '</div>' +
      '</form></p>';

    let form2 = '' +
      '<p> - OR - </p>' +
      '<h2>sign in with an existing pol.is account</h2>' +
      '<p><form role="form" class="FormVertical" action="' + getServerNameWithProtocol(req) + '/api/v3/auth/login" method="POST">' +
      '<div class="FormVertical-group">' +
      '<label class="FormLabel" for="gatekeeperLoginEmail">Email</label>' +
      '<input type="text" id="email" name="email" id="gatekeeperLoginEmail" style="width: 100%;" class="FormControl">' +
      '</div>' +
      '<div class="FormVertical-group">' +
      '<label class="FormLabel" for="gatekeeperLoginPassword">' +
      'Password' +
      '</label>' +
      '<input type="password" id="password" name="password" id="gatekeeperLoginPassword" style="width: 100%;" class="FormControl">' +
      '<input type="hidden" name="lti_user_id" value="' + user_id + '">' +
      '<input type="hidden" name="lti_user_image" value="' + user_image + '">' +
      '<input type="hidden" name="lti_context_id" value="' + context_id + '">' +
      '<input type="hidden" name="tool_consumer_instance_guid" value="' + tool_consumer_instance_guid + '">' +
      '<input type="hidden" name="afterJoinRedirectUrl" value="' + afterJoinRedirectUrl + '">' +
      '<a href="/pwresetinit" class="FormLink">Forgot your password?</a>' +
      '</div>' +
      '' +
      '<div class="row" id="errorDiv"></div>' +
      '<div class="FormVertical-group">' +
      '<button type="submit" class="Btn Btn-primary">Sign In</button>' +
      '</div>' +
      '</form></p>';


    res.set({
      'Content-Type': 'text/html',
    });
    // let customPart = isInstructor ? "you are the instructor" : "you are a Student";

    let html = "" +
      "<!DOCTYPE html><html lang='en'>" +
      '<head>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
      '</head>' +
      "<body style='max-width:320px; font-family: Futura, Helvetica, sans-serif;'>" +
      greeting +
      form1 +
      form2 +
      // " <p style='background-color: yellow;'>" +
      //     JSON.stringify(req.body)+
      //     "<img src='"+req.p.user_image+"'></img>"+
      // "</p>"+
      "</body></html>";

    res.status(200).send(html);
  }


  // team meetings - schedule with others, smart converence room
  // or redirect tool
  // students already pay an online fee

  // ADA? 508 compliance
  // accessibility - Teach Act: those who don't have dexterity
  // colors
  // screen readers
  // A compromise would be this:
  // Instructors see a custom inbox for the course, and can create conversations there. make it easy to copy and paste links..
  // how do we deal with sections? can't do this.
  // Conversations created here will be under the uid of the account owner... which may be problematic later with school-wide accounts... if we ever offer that
  //
  // Complication: sections -- are they needed this quarter? maybe better to just do the linkage, and then try to make it easy to post the stuff...
  //  it is possible for teachers to create a duplicate assignment, and have it show for certain sections...
  //     so we can rely on custom_canvas_assignment_id

  // TODO rename to LTI/launch
  // TODO save launch contexts in mongo. For now, to err on the side of collecting extra data, let them be duplicated. Attach a timestamp too.
  // TODO return HTML from the auth functions. the html should contain the token? so that ajax calls can be made.
  function handle_POST_lti_setup_assignment(req, res) {
    winston.log("info", req);
    // let roles = req.p.roles;
    // let isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
    let user_id = req.p.user_id;
    let context_id = req.p.context_id;
    // let user_image = req.p.user_image || "";
    if (!req.p.tool_consumer_instance_guid) {
      emailBadProblemTime("couldn't find tool_consumer_instance_guid, maybe this isn't Canvas?");
    }

    // TODO SECURITY we need to verify the signature
    // let oauth_consumer_key = req.p.oauth_consumer_key;

    let dataSavedPromise = pg.queryP("insert into lti_single_assignment_callback_info (lti_user_id, lti_context_id, lis_outcome_service_url, stringified_json_of_post_content) values ($1, $2, $3, $4);", [
      user_id,
      context_id,
      req.p.lis_outcome_service_url || "",
      JSON.stringify(req.p),
    ]);

    Promise.all([
      dataSavedPromise,
    ]).then(function() {
      // check if signed in (NOTE that if they're in the Canvas mobile app, the cookies may be shared with the browser on the device)
      if (req.p.uid) {

        // Check if linked to this uid.
        pg.queryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_user_id = ($1);", [user_id]).then(function(rows) {

          // find the correct one - note: this loop may be useful in warning when people have multiple linkages
          let userForLtiUserId = null;
          (rows || []).forEach(function(row) {
            if (row.uid === req.p.uid) {
              userForLtiUserId = row;
            }
          });
          if (userForLtiUserId) {
            // if (teacher pays) {
            //     // you're good!
            // } else {
            //     if (you paid) {
            renderLtiLinkageSuccessPage(req, res, {
              context_id: context_id,
              // user_image: userForLtiUserId.user_image,
              email: userForLtiUserId.email,
            });
            // } else { // you (student) have not yet paid
            //     // gotta pay
            // }
            // }
          } else {
            // you are signed in, but not linked to the signed in user
            // WARNING! CLEARING COOKIES - since it's difficult to have them click a link to sign out, and then re-initiate the LTI POST request from Canvas, just sign them out now and move on.
            clearCookies(req, res);
            winston.log("info", 'lti_linkage didnt exist');
            // Have them sign in again, since they weren't linked.
            // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
            renderLtiLinkagePage(req, res);
          }
        }).catch(function(err) {
          fail(res, 500, "polis_err_launching_lti_finding_user", err);
        });
      } else { // no uid (no cookies)
        // Have them sign in to set up the linkage
        winston.log("info", 'lti_linkage - no uid');
        renderLtiLinkagePage(req, res);
      }
    }).catch(function(err) {
      fail(res, 500, "polis_err_launching_lti_save", err);
    });
  } // end /api/v3/LTI/setup_assignment



  // function handle_POST_lti_canvas_nav(req, res) {
  //     winston.log("info",req);
  //     let roles = req.p.roles;
  //     let isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
  //     let user_id = req.p.user_id;
  //     let context_id = req.p.context_id;
  //     let user_image = req.p.user_image || "";
  //     // if (!req.p.tool_consumer_instance_guid) {
  //     //     emailBadProblemTime("couldn't find tool_consumer_instance_guid, maybe this isn't Canvas?");
  //     // }

  //     winston.log("info",req.p);

  //     // // TODO SECURITY we need to verify the signature
  //     // let oauth_consumer_key = req.p.oauth_consumer_key;

  //     // Check if linked to this uid.
  //     pg.queryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {


  //         let userForLtiUserId = null;
  //         if (rows.length) {
  //             userForLtiUserId = rows[0];
  //         }

  //         winston.log("info",'got user for lti_user_id:' + JSON.stringify(userForLtiUserId));

  //         if (userForLtiUserId) {
  //             // if (teacher pays) {
  //             //     // you're good!
  //             // } else {
  //             //     if (you paid) {


  //                     // renderLtiLinkageSuccessPage(req, res, {
  //                     //     context_id: context_id,
  //                     //     // user_image: userForLtiUserId.user_image,
  //                     //     email: userForLtiUserId.email,
  //                     // });


  //                     let inboxLaunchParams = encodeParams({
  //                         context: context_id, // we're using the LTI context_id as a polis conversation context. scope the inbox to the course
  //                         xPolisLti: createPolisLtiToken(req.p.tool_consumer_instance_guid, req.p.user_id),  // x-polis-lti header
  //                         // TODO add token
  //                     });
  //                     res.redirect("https://preprod.pol.is/inbox/" + inboxLaunchParams);



  //                 // } else { // you (student) have not yet paid
  //                 //     // gotta pay
  //                 // }
  //             // }
  //         } else {
  //             // not linked yet. send them to an auth page, which should do the linkage, then send them to inbox with the funky params...

  //             // you are signed in, but not linked to the signed in user
  //             // WARNING! CLEARING COOKIES - since it's difficult to have them click a link to sign out, and then re-initiate the LTI POST request from Canvas, just sign them out now and move on.
  //             clearCookies(req, res);
  //             winston.log("info",'lti_linkage didnt exist');
  //             // Have them sign in again, since they weren't linked.
  //             // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
  //             renderLtiLinkagePage(req, res);
  //         }
  //     }).catch(function(err) {
  //         fail(res, 500, "polis_err_launching_lti_finding_user", err);
  //     });

  // } // end /api/v3/LTI/canvas_nav



  function addCanvasAssignmentConversationInfoIfNeeded(zid, tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id) {
    return getCanvasAssignmentInfo(tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id).then(function(rows) {
      let exists = rows && rows.length;
      if (exists) {
        return exists;
      } else {
        return pg.queryP("insert into canvas_assignment_conversation_info (zid, tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id) values ($1, $2, $3, $4);", [
          zid,
          tool_consumer_instance_guid,
          lti_context_id,
          custom_canvas_assignment_id,
        ]);
      }
    });
  }

  function getCanvasAssignmentInfo(tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id) {
    winston.log("info", 'grades select * from canvas_assignment_conversation_info where tool_consumer_instance_guid = ' + tool_consumer_instance_guid + ' and lti_context_id = ' + lti_context_id + ' and custom_canvas_assignment_id = ' + custom_canvas_assignment_id + ';');
    return pg.queryP("select * from canvas_assignment_conversation_info where tool_consumer_instance_guid = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3);", [
      tool_consumer_instance_guid,
      lti_context_id,
      custom_canvas_assignment_id,
    ]);
  }

  function addCanvasAssignmentConversationCallbackParamsIfNeeded(lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid, lis_outcome_service_url, lis_result_sourcedid, stringified_json_of_post_content) {
    return getCanvasAssignmentConversationCallbackParams(lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid).then(function(rows) {
      if (rows && rows.length) {
        // update
        // this is failing, but it has been ok, since the insert worked (i assume)
        return pg.queryP("update canvas_assignment_callback_info set lis_outcome_service_url = ($5), lis_result_sourcedid = ($6), stringified_json_of_post_content = ($7) where lti_user_id = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3) and tool_consumer_instance_guid = ($4);", [
          lti_user_id,
          lti_context_id,
          custom_canvas_assignment_id,
          tool_consumer_instance_guid,
          lis_outcome_service_url,
          lis_result_sourcedid,
          stringified_json_of_post_content,
        ]);
      } else {
        // insert
        return pg.queryP("insert into canvas_assignment_callback_info (lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid, lis_outcome_service_url, lis_result_sourcedid, stringified_json_of_post_content) values ($1, $2, $3, $4, $5, $6, $7);", [
          lti_user_id,
          lti_context_id,
          custom_canvas_assignment_id,
          tool_consumer_instance_guid,
          lis_outcome_service_url,
          lis_result_sourcedid,
          stringified_json_of_post_content,
        ]);
      }
    });
  }

  function getCanvasAssignmentConversationCallbackParams(lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid) {
    return pg.queryP("select * from canvas_assignment_callback_info where lti_user_id = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3) and tool_consumer_instance_guid = ($4);", [
      lti_user_id,
      lti_context_id,
      custom_canvas_assignment_id,
      tool_consumer_instance_guid,
    ]);
  }


  function handle_POST_lti_conversation_assignment(req, res) {
    let roles = req.p.roles;
    let isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
    // let isLearner = /[lL]earner/.exec(roles);
    let user_id = req.p.user_id;
    let context_id = req.p.context_id;
    // let user_image = req.p.user_image || "";

    winston.log("info", "grades req.body " + JSON.stringify(req.body));
    winston.log("info", "grades req.p " + JSON.stringify(req.p));

    // TODO SECURITY we need to verify the signature
    // let oauth_consumer_key = req.p.oauth_consumer_key;

    function getPolisUserForLtiUser() {
      return pg.queryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {
        let userForLtiUserId = null;
        if (rows.length) {
          userForLtiUserId = rows[0];
          winston.log("info", 'got user for lti_user_id:' + JSON.stringify(userForLtiUserId));
        }
        return userForLtiUserId;
      });
    }

    if (req.p.lis_result_sourcedid) {
      addCanvasAssignmentConversationCallbackParamsIfNeeded(req.p.user_id, req.p.context_id, req.p.custom_canvas_assignment_id, req.p.tool_consumer_instance_guid, req.p.lis_outcome_service_url, req.p.lis_result_sourcedid, JSON.stringify(req.body)).then(function() {
        winston.log("info", "grading info added");
      }).catch(function(err) {
        winston.log("info", "grading info error ");
        winston.log("info", err);
      });
    }


    function constructConversationUrl(zid) {
      // sweet! the instructor has created the conversation. send students here. (instructors too)
      return getZinvite(zid).then(function(zinvite) {
        return getServerNameWithProtocol(req) + "/" + zinvite + "/" + encodeParams({
          forceEmbedded: true,
          // this token is used to support cookie-less participation, mainly needed within Canvas's Android webview
          xPolisLti: createPolisLtiToken(req.p.tool_consumer_instance_guid, req.p.user_id), // x-polis-lti header
        });
      });
    }

    // pg.queryP("insert into lti_single_assignment_callback_info (lti_user_id, lti_context_id, lis_outcome_service_url, lis_result_sourcedid, custom_canvas_assignment_id, tool_consumer_instance_guid, stringified_json_of_post_content) values ($1, $2, $3, $4, $5, $6, $7);", [
    //     req.p.lti_user_id,
    //     req.p.lti_context_id,
    //     req.p.lis_outcome_service_url,
    //     req.p.lis_result_sourcedid,
    //     req.p.custom_canvas_assignment_id,
    //     req.p.tool_consumer_instance_guid,
    //     JSON.stringify(req.body),
    // ]).thennnnn

    Promise.all([
      getCanvasAssignmentInfo(
        req.p.tool_consumer_instance_guid,
        req.p.context_id,
        req.p.custom_canvas_assignment_id),
      getPolisUserForLtiUser(),
    ]).then(function(results) {
      let infos = results[0];
      let exists = infos && infos.length;
      let info = infos[0];

      let user = results[1];

      if (exists) {
        return constructConversationUrl(info.zid).then(function(url) {
          if (user) {
            // we're in business, user can join the conversation
            res.redirect(url);
          } else {
            // not linked yet.
            // send them to an auth page, which should do the linkage, then send them to inbox with the funky params...

            // you are signed in, but not linked to the signed in user
            // WARNING! CLEARING COOKIES - since it's difficult to have them click a link to sign out, and then re-initiate the LTI POST request from Canvas, just sign them out now and move on.
            clearCookies(req, res);
            winston.log("info", 'lti_linkage didnt exist');
            // Have them sign in again, since they weren't linked.
            // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
            renderLtiLinkagePage(req, res, url);
          }
        }).catch(function(err) {
          fail(res, 500, "polis_err_lti_generating_conversation_url", err);
        });

      } else {
        // uh oh, not ready. If this is an instructor, we'll send them to the create/conversation page.
        if (isInstructor) {
          if (user) {
            res.redirect(getServerNameWithProtocol(req) + "/conversation/create/" + encodeParams({
              forceEmbedded: true,
              // this token is used to support cookie-less participation, mainly needed within Canvas's Android webview. It is needed to ensure the canvas user is bound to the polis user, regardless of who is signed in on pol.is
              xPolisLti: createPolisLtiToken(req.p.tool_consumer_instance_guid, req.p.user_id), // x-polis-lti header
              tool_consumer_instance_guid: req.p.tool_consumer_instance_guid,
              context: context_id,
              custom_canvas_assignment_id: req.p.custom_canvas_assignment_id,
            }));
          } else {
            let url = getServerNameWithProtocol(req) + "/conversation/create/" + encodeParams({
              forceEmbedded: true,
              tool_consumer_instance_guid: req.p.tool_consumer_instance_guid,
              context: context_id,
              custom_canvas_assignment_id: req.p.custom_canvas_assignment_id,
            });
            renderLtiLinkagePage(req, res, url);
          }
        } else {
          // double uh-oh, a student is seeing this before the instructor created a conversation...

          // TODO email polis team, email instructor?
          // TODO or just auto-generate a conversation for the instructor, and have no topic and description, then show that?
          // TODO or make a dummy "not ready yet" page

          console.error("Student saw conversation before it was set up. For instructor with key: oauth_consumer_key: " + req.p.oauth_consumer_key);
          res.set({
            'Content-Type': 'text/html',
          });
          res.send(
            '<head><meta name="viewport" content="width=device-width, initial-scale=1;"></head>' +
            "<body><h1 style='max-width:320px'>Sorry, the pol.is conversation has not been created yet. Please try back later.</h1></body>"
          );
        }
      }
    }).catch(function(err) {
      fail(res, 500, "polis_err_checking_grading_context", err);
    });

    // store info about class, if not there already
    // pg.queryP("insert into canvas_assignment_conversation_info (

    // we could store them all
    // we could upsert
    // but we'll need to know the uid to post the grades when the vote happens.
    // ON VOTE?
    // nope. Canvas sends them an email. It would be weird to vote once and then get an email saying you have 10/10.
    //check if conversation has context
    // if so, fetch lti_user_id for the uid and the correct tool_consumer_instance_guid (TODO)
    // lti_single_assignment_callback_info for the context, custom_canvas_assignment_id, lti_user_id
    // and do the post with that info...

    // ON CLOSE?
    // teacher has to manually close the conversation.
    // we need to provide UI for that. either in the custom inbox, or in the conversation itself.
    // so, on conversation close... we should keep "canvas_assignment_conversation_info": a many-to-many mapping of {zid <=> (tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id)}
    // so iterate over all triples for the zid, and find the corresponding callback record, and make a signed request for each student's record.
    // Note that if the student somehow joined the conversation, but not through canvas, then they can't get credit.


    // wait! how do we know what the conversation should have for topic / description?

  }



  function handle_GET_setup_assignment_xml(req, res) {
    let xml = '' +
      '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

      '<blti:title>Polis Setup Assignment</blti:title>' +
      '<blti:description>based on Minecraft LMS integration</blti:description>' +
      '<blti:icon>' +
      'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
      '</blti:icon>' +
      '<blti:launch_url>https://preprod.pol.is/api/v3/LTI/setup_assignment</blti:launch_url>' +

      '<blti:custom>' +
      '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
      '</blti:custom>' +

      '<blti:extensions platform="canvas.instructure.com">' +

      '<lticm:property name="tool_id">polis_lti</lticm:property>' +
      '<lticm:property name="privacy_level">public</lticm:property>' +

      // homework 1 (link accounts)
      // https://canvas.instructure.com/doc/api/file.homework_submission_tools.html
      '<lticm:options name="homework_submission">' +
      // This is the URL that will be POSTed to when users click the button in any rich editor.
      '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/setup_assignment</lticm:property>' +
      '<lticm:property name="icon_url">' +
      'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
      '</lticm:property>' +

      '<lticm:property name="text">polis accout setup (first assignment)</lticm:property>' +
      '<lticm:property name="selection_width">400</lticm:property>' +
      '<lticm:property name="selection_height">300</lticm:property>' +
      '<lticm:property name="enabled">true</lticm:property>' +
      '</lticm:options>' +

      // nav
      // '<lticm:options name="course_navigation">' +
      //     '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/setup_assignment</lticm:property>' +
      //     '<lticm:property name="text">polis setup from nav</lticm:property>' +
      //     '<lticm:property name="visibility">public</lticm:property>' +
      //     '<lticm:property name="default">enabled</lticm:property>' +
      //     '<lticm:property name="enabled">true</lticm:property>' +
      // '</lticm:options>' +



      '</blti:extensions>' +

      '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
      '<cartridge_icon identifierref="BLTI001_Icon"/>' +
      '</cartridge_basiclti_link>';

    res.set('Content-Type', 'text/xml');
    res.status(200).send(xml);
  }


  function handle_GET_conversation_assigmnent_xml(req, res) {
    let serverName = getServerNameWithProtocol(req);

    let xml = '' +
      '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

      '<blti:title>Polis Conversation Setup</blti:title>' +
      '<blti:description>Polis conversation</blti:description>' +
      // '<blti:icon>' +
      // 'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
      // '</blti:icon>' +
      '<blti:launch_url>' + serverName + '/api/v3/LTI/conversation_assignment</blti:launch_url>' +

      '<blti:custom>' +
      '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
      '</blti:custom>' +

      '<blti:extensions platform="canvas.instructure.com">' +

      '<lticm:property name="tool_id">polis_conversation_lti</lticm:property>' +
      '<lticm:property name="privacy_level">public</lticm:property>' +

      // homework 2 (polis discussions)
      // https://canvas.instructure.com/doc/api/file.homework_submission_tools.html
      '<lticm:options name="homework_submission">' +
      // '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/homework_submission</lticm:property>' +
      '<lticm:property name="url">' + serverName + '/api/v3/LTI/conversation_assignment</lticm:property>' + // ?
      '<lticm:property name="icon_url">' +
      'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
      '</lticm:property>' +

      '<lticm:property name="text">polis setup</lticm:property>' +
      '<lticm:property name="selection_width">400</lticm:property>' +
      '<lticm:property name="selection_height">300</lticm:property>' +
      '<lticm:property name="enabled">true</lticm:property>' +
      '</lticm:options>' +

      '</blti:extensions>' +

      '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
      '<cartridge_icon identifierref="BLTI001_Icon"/>' +
      '</cartridge_basiclti_link>';

    res.set('Content-Type', 'text/xml');
    res.status(200).send(xml);
  }


  function handle_GET_canvas_app_instructions_png(req, res) {
    let path = "/landerImages/";
    if (/Android/.exec(req.headers['user-agent'])) {
      path += "app_instructions_android.png";
    } else if (/iPhone.*like Mac OS X/.exec(req.headers['user-agent'])) {
      path += "app_instructions_ios.png";
    } else {
      path += "app_instructions_blank.png";
    }
    let doFetch = makeFileFetcher(hostname, portForParticipationFiles, path, {
      'Content-Type': "image/png",
    });
    doFetch(req, res);
  }



  // function handle_POST_users_invite(req, res) {
  //     let owner = req.p.uid;
  //     let xids = req.p.xids;
  //     let zid = req.p.zid;


  //     // generate some tokens
  //     // add them to a table paired with user_ids
  //     // return URLs with those.
  //     generateSUZinvites(xids.length).then(function(suzinviteArray) {
  //         let pairs = _.zip(xids, suzinviteArray);

  //         let valuesStatements = pairs.map(function(pair) {
  //             let xid = escapeLiteral(pair[0]);
  //             let suzinvite = escapeLiteral(pair[1]);
  //             let statement = "("+ suzinvite + ", " + xid + "," + zid+","+owner+")";
  //             winston.log("info",statement);
  //             return statement;
  //         });
  //         let query = "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " + valuesStatements.join(",") + ";";
  //         winston.log("info",query);
  //         pg.queryP(query, [], function(err, results) {
  //             if (err) { fail(res, 500, "polis_err_saving_invites", err); return; }
  //             getZinvite(zid).then(function(conversation_id) {
  //                 res.json({
  //                     urls: suzinviteArray.map(function(suzinvite) {
  //                         return generateSingleUseUrl(req, conversation_id, suzinvite);
  //                     }),
  //                     xids: xids,
  //                 });
  //             }, function(err) {
  //                 fail(res, 500, "polis_err_generating_single_use_invites_missing_conversation_id", err);
  //             }).catch(function(err) {
  //                 fail(res, 500, "polis_err_generating_single_use_invites", err);
  //             });
  //         });
  //     }).catch(function(err) {
  //         fail(res, 500, "polis_err_generating_single_use_invites", err);
  //     });
  // }



  function hangle_GET_testConnection(req, res) {
    res.status(200).json({
      status: "ok",
    });
  }

  function hangle_GET_testDatabase(req, res) {
    pg.queryP("select uid from users limit 1", []).then((rows) => {
      res.status(200).json({
        status: "ok",
      });
    }, (err) => {
      fail(res, 500, "polis_err_testDatabase", err);
    });
  }

  function sendSuzinviteEmail(req, email, conversation_id, suzinvite) {
    let serverName = getServerNameWithProtocol(req);
    let body = "" +
      "Welcome to pol.is!\n" +
      "\n" +
      "Click this link to open your account:\n" +
      "\n" +
      serverName + "/ot/" + conversation_id + "/" + suzinvite + "\n" +
      "\n" +
      "Thank you for using Polis\n";

    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      "Join the pol.is conversation!",
      body);
  }

  function addInviter(inviter_uid, invited_email) {
    return pg.queryP("insert into inviters (inviter_uid, invited_email) VALUES ($1, $2);", [inviter_uid, invited_email]);
  }

  function handle_POST_users_invite(req, res) {
    let uid = req.p.uid;
    let emails = req.p.emails;
    let zid = req.p.zid;
    let conversation_id = req.p.conversation_id;

    getConversationInfo(zid).then(function(conv) {

      let owner = conv.owner;

      // generate some tokens
      // add them to a table paired with user_ids
      // return URLs with those.
      generateSUZinvites(emails.length).then(function(suzinviteArray) {
        let pairs = _.zip(emails, suzinviteArray);

        let valuesStatements = pairs.map(function(pair) {
          let xid = escapeLiteral(pair[0]);
          let suzinvite = escapeLiteral(pair[1]);
          let statement = "(" + suzinvite + ", " + xid + "," + zid + "," + owner + ")";
          winston.log("info", statement);
          return statement;
        });
        let query = "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " + valuesStatements.join(",") + ";";
        winston.log("info", query);
        pg.queryP(query, [], function(err, results) {
          if (err) {
            fail(res, 500, "polis_err_saving_invites", err);
            return;
          }

          Promise.all(pairs.map(function(pair) {
            let email = pair[0];
            let suzinvite = pair[1];
            return sendSuzinviteEmail(req, email, conversation_id, suzinvite).then(function() {
              return addInviter(uid, email);
            }, function(err) {
              fail(res, 500, "polis_err_sending_invite", err);
            });
          })).then(function() {
            res.status(200).json({
              status: ":-)",
            });
          }).catch(function(err) {
            fail(res, 500, "polis_err_sending_invite", err);
          });

        });
      }).catch(function(err) {
        fail(res, 500, "polis_err_generating_invites", err);
      });
    }).catch(function(err) {
      fail(res, 500, "polis_err_getting_conversation_info", err);
    });
  }



  function initializeImplicitConversation(site_id, page_id, o) {

    // find the user with that site_id.. wow, that will be a big index..
    // I suppose we could duplicate the site_ids that actually have conversations
    // into a separate table, and search that first, only searching users if nothing is there.
    return pg.queryP_readOnly("select uid from users where site_id = ($1) and site_owner = TRUE;", [site_id]).then(function(rows) {
      if (!rows || !rows.length) {
        throw new Error("polis_err_bad_site_id");
      }
      return new Promise(function(resolve, reject) {


        let uid = rows[0].uid;
        //    create a conversation for the owner we got,
        let generateShortUrl = false;

        isUserAllowedToCreateConversations(uid, function(err, isAllowed) {
          if (err) {
            reject(err);
            return;
          }
          if (!isAllowed) {
            reject(err);
            return;
          }

          let params = Object.assign(o, {
            owner: uid,
            org_id: uid,
            // description: req.p.description,
            is_active: true,
            is_draft: false,
            is_public: true, // TODO remove this column
            is_anon: false,
            profanity_filter: true, // TODO this could be drawn from config for the owner
            spam_filter: true, // TODO this could be drawn from config for the owner
            strict_moderation: false, // TODO this could be drawn from config for the owner
            // context: req.p.context,
            owner_sees_participation_stats: false, // TODO think, and test join
          });

          let q = sql_conversations.insert(params).returning('*').toString();

          pg.queryP(q, [], function(err, result) {
            if (err) {
              if (isDuplicateKey(err)) {
                yell(err);
                reject("polis_err_create_implicit_conv_duplicate_key");
              } else {
                reject("polis_err_create_implicit_conv_db");
              }
            }

            let zid = result && result.rows && result.rows[0] && result.rows[0].zid;

            Promise.all([
              registerPageId(site_id, page_id, zid),
              generateAndRegisterZinvite(zid, generateShortUrl),
            ]).then(function(o) {
              // let notNeeded = o[0];
              let zinvite = o[1];
              // NOTE: OK to return conversation_id, because this conversation was just created by this user.
              resolve({
                owner: uid,
                zid: zid,
                zinvite: zinvite,
              });
            }).catch(function(err) {
              reject("polis_err_zinvite_create_implicit", err);
            });
          }); // end insert
        }); // end isUserAllowedToCreateConversations

        //    add a record to page_ids
        //    (put the site_id in the smaller site_ids table)
        //    redirect to the zinvite url for the conversation

      });
    });
  }

  function sendImplicitConversationCreatedEmails(site_id, page_id, url, modUrl, seedUrl) {
    let body = "" +
      "Conversation created!" + "\n" +
      "\n" +
      "You can find the conversation here:\n" +
      url + "\n" +
      "You can moderate the conversation here:\n" +
      modUrl + "\n" +
      "\n" +
      "We recommend you add 2-3 short statements to start things off. These statements should be easy to agree or disagree with. Here are some examples:\n \"I think the proposal is good\"\n \"This topic matters a lot\"\n or \"The bike shed should have a metal roof\"\n\n" +
      "You can add statements here:\n" +
      seedUrl + "\n" +
      "\n" +
      "Feel free to reply to this email if you have questions." +
      "\n" +
      "\n" +
      "Additional info: \n" +
      "site_id: \"" + site_id + "\"\n" +
      "page_id: \"" + page_id + "\"\n" +
      "\n";

    return pg.queryP("select email from users where site_id = ($1)", [site_id]).then(function(rows) {

      let emails = _.pluck(rows, "email");
      emails = _.union(emails, [
        "m@bjorkegren.com",
      ]);

      return sendMultipleTextEmails(
        POLIS_FROM_ADDRESS,
        emails,
        "Polis conversation created",
        body);
    });
  }

  function registerPageId(site_id, page_id, zid) {
    return pg.queryP("insert into page_ids (site_id, page_id, zid) values ($1, $2, $3);", [
      site_id,
      page_id,
      zid,
    ]);
  }

  function doGetConversationPreloadInfo(conversation_id) {
    // return Promise.resolve({});
    return getZidFromConversationId(conversation_id).then(function(zid) {
      return Promise.all([
        getConversationInfo(zid),
      ]);
    }).then(function(a) {
      let conv = a[0];

      let auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(conv.auth_opt_allow_3rdparty, true);
      let auth_opt_fb_computed = auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_fb, true);
      let auth_opt_tw_computed = auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_tw, true);

      conv = {
        topic: conv.topic,
        description: conv.description,
        created: conv.created,
        link_url: conv.link_url,
        parent_url: conv.parent_url,
        vis_type: conv.vis_type,
        write_type: conv.write_type,
        help_type: conv.help_type,
        socialbtn_type: conv.socialbtn_type,
        bgcolor: conv.bgcolor,
        help_color: conv.help_color,
        help_bgcolor: conv.help_bgcolor,
        style_btn: conv.style_btn,
        auth_needed_to_vote: ifDefinedFirstElseSecond(conv.auth_needed_to_vote, false),
        auth_needed_to_write: ifDefinedFirstElseSecond(conv.auth_needed_to_write, true),
        auth_opt_allow_3rdparty: auth_opt_allow_3rdparty,
        auth_opt_fb_computed: auth_opt_fb_computed,
        auth_opt_tw_computed: auth_opt_tw_computed,
      };
      conv.conversation_id = conversation_id;
      // conv = Object.assign({}, optionalResults, conv);
      return conv;
    });
  }

  function handle_GET_conversationPreloadInfo(req, res) {
    return doGetConversationPreloadInfo(req.p.conversation_id).then((conv) => {
      res.status(200).json(conv);
    }, (err) => {
      fail(res, 500, "polis_err_get_conversation_preload_info", err);
    });
  }



  // NOTE: this isn't optimal
  // rather than code for a new URL scheme for implicit conversations,
  // the idea is to redirect implicitly created conversations
  // to their zinvite based URL after creating the conversation.
  // To improve conversation load time, this should be changed so that it
  // does not redirect, and instead serves up the index.
  // The routers on client and server will need to be updated for that
  // as will checks like isParticipationView on the client.
  function handle_GET_implicit_conversation_generation(req, res) {
    let site_id = /polis_site_id[^\/]*/.exec(req.path);
    let page_id = /\S\/([^\/]*)/.exec(req.path);
    if (!site_id.length || page_id.length < 2) {
      fail(res, 404, "polis_err_parsing_site_id_or_page_id");
    }
    site_id = site_id[0];
    page_id = page_id[1];

    let demo = req.p.demo;
    let ucv = req.p.ucv;
    let ucw = req.p.ucw;
    let ucsh = req.p.ucsh;
    let ucst = req.p.ucst;
    let ucsd = req.p.ucsd;
    let ucsv = req.p.ucsv;
    let ucsf = req.p.ucsf;
    let ui_lang = req.p.ui_lang;
    let subscribe_type = req.p.subscribe_type;
    let xid = req.p.xid;
    let x_name = req.p.x_name;
    let x_profile_image_url = req.p.x_profile_image_url;
    let x_email = req.p.x_email;
    let parent_url = req.p.parent_url;
    let dwok = req.p.dwok;
    let build = req.p.build;
    let o = {};
    ifDefinedSet("parent_url", req.p, o);
    ifDefinedSet("auth_needed_to_vote", req.p, o);
    ifDefinedSet("auth_needed_to_write", req.p, o);
    ifDefinedSet("auth_opt_fb", req.p, o);
    ifDefinedSet("auth_opt_tw", req.p, o);
    ifDefinedSet("auth_opt_allow_3rdparty", req.p, o);
    ifDefinedSet("topic", req.p, o);
    if (!_.isUndefined(req.p.show_vis)) {
      o.vis_type = req.p.show_vis ? 1 : 0;
    }
    if (!_.isUndefined(req.p.bg_white)) {
      o.bgcolor = req.p.bg_white ? "#fff" : null;
    }
    o.socialbtn_type = req.p.show_share ? 1 : 0;


    // Set stuff in cookies to be retrieved when POST participants is called.
    let setOnPolisDomain = !domainOverride;
    let origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
      setOnPolisDomain = false;
    }
    if (req.p.referrer) {
      setParentReferrerCookie(req, res, setOnPolisDomain, req.p.referrer);
    }
    if (req.p.parent_url) {
      setParentUrlCookie(req, res, setOnPolisDomain, req.p.parent_url);
    }

    function appendParams(url) {
      // These are needed to disambiguate postMessages from multiple polis conversations embedded on one page.
      url += "?site_id=" + site_id + "&page_id=" + page_id;
      if (!_.isUndefined(ucv)) {
        url += ("&ucv=" + ucv);
      }
      if (!_.isUndefined(ucw)) {
        url += ("&ucw=" + ucw);
      }
      if (!_.isUndefined(ucst)) {
        url += ("&ucst=" + ucst);
      }
      if (!_.isUndefined(ucsd)) {
        url += ("&ucsd=" + ucsd);
      }
      if (!_.isUndefined(ucsv)) {
        url += ("&ucsv=" + ucsv);
      }
      if (!_.isUndefined(ucsf)) {
        url += ("&ucsf=" + ucsf);
      }
      if (!_.isUndefined(ui_lang)) {
        url += ("&ui_lang=" + ui_lang);
      }
      if (!_.isUndefined(ucsh)) {
        url += ("&ucsh=" + ucsh);
      }
      if (!_.isUndefined(subscribe_type)) {
        url += ("&subscribe_type=" + subscribe_type);
      }
      if (!_.isUndefined(xid)) {
        url += ("&xid=" + xid);
      }
      if (!_.isUndefined(x_name)) {
        url += ("&x_name=" + encodeURIComponent(x_name));
      }
      if (!_.isUndefined(x_profile_image_url)) {
        url += ("&x_profile_image_url=" + encodeURIComponent(x_profile_image_url));
      }
      if (!_.isUndefined(x_email)) {
        url += ("&x_email=" + encodeURIComponent(x_email));
      }
      if (!_.isUndefined(parent_url)) {
        url += ("&parent_url=" + encodeURIComponent(parent_url));
      }
      if (!_.isUndefined(dwok)) {
        url += ("&dwok=" + dwok);
      }
      if (!_.isUndefined(build)) {
        url += ("&build=" + build);
      }
      return url;
    }

    // also parse out the page_id after the '/', and look that up, along with site_id in the page_ids table
    pg.queryP_readOnly("select * from page_ids where site_id = ($1) and page_id = ($2);", [site_id, page_id]).then(function(rows) {
      if (!rows || !rows.length) {
        // conv not initialized yet
        initializeImplicitConversation(site_id, page_id, o).then(function(conv) {
          let url = _.isUndefined(demo) ?
            buildConversationUrl(req, conv.zinvite) :
            buildConversationDemoUrl(req, conv.zinvite);
          let modUrl = buildModerationUrl(req, conv.zinvite);
          let seedUrl = buildSeedUrl(req, conv.zinvite);
          sendImplicitConversationCreatedEmails(site_id, page_id, url, modUrl, seedUrl).then(function() {
            winston.log("info", 'email sent');
          }).catch(function(err) {
            console.error('email fail');
            console.error(err);
          });

          url = appendParams(url);
          res.redirect(url);

        }).catch(function(err) {
          fail(res, 500, "polis_err_creating_conv", err);
        });
      } else {
        // conv was initialized, nothing to set up
        getZinvite(rows[0].zid).then(function(conversation_id) {
          let url = buildConversationUrl(req, conversation_id);
          url = appendParams(url);
          res.redirect(url);
        }).catch(function(err) {
          fail(res, 500, "polis_err_finding_conversation_id", err);
        });
      }
    }).catch(function(err) {
      fail(res, 500, "polis_err_redirecting_to_conv", err);
    });
  }

  let routingProxy = new httpProxy.RoutingProxy();

  function addStaticFileHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', 0);
  }

  function proxy(req, res) {
		let hostname;
    if (localServer) {
      let origin = config.get('STATIC_FILES_ORIGIN');
      hostname = /^https?:\/\/([^\/:]+).*$/.exec(origin)[1];
    } else {
      hostname = buildStaticHostname(req, res);
      if (!hostname) {
        let host = req.headers.host || "";
        let re = new RegExp(process.env.SERVICE_HOSTNAME + "$");
        if (host.match(re)) {
          // don't alert for this, it's probably DNS related
          // TODO_SEO what should we return?
          userFail(res, 500, "polis_err_proxy_serving_to_domain", new Error(host));
        } else {
          fail(res, 500, "polis_err_proxy_serving_to_domain", new Error(host));
        }
        console.error(req.headers.host);
        console.error(req.path);
        return;
      }
    }
	

    if (devMode) {
      addStaticFileHeaders(res);
    }
    // if (/MSIE [^1]/.exec(req.headers['user-agent'])) { // older than 10
    //     // http.get(process.env.STATIC_FILES_HOST + "/unsupportedBrowser.html", function(page) {
    //     //     res.status(200).end(page);
    //     // }).on('error', function(e) {
    //     //     res.status(200).end("Apollogies, this browser is not supported. We recommend Chrome, Firefox, or Safari.");
    //     // });
    //     getStaticFile("./unsupportedBrowser.html", res);
    // } else {


    let port = getStaticFilePort();
    // set the host header too, since S3 will look at that (or the routing proxy will patch up the request.. not sure which)
    req.headers.host = hostname;
    routingProxy.proxyRequest(req, res, {

      host: hostname,
      port: port,
    });
    // }
  }

	function getStaticFilePort() {
	  if (process.env.STATIC_FILES_PORT) {
	    return process.env.STATIC_FILES_PORT;
	  }
	  let origin = config.get('STATIC_FILES_ORIGIN');
	  if (!origin) {
	    console.error('STATIC_FILES_ORIGIN and STATIC_FILES_PORT is not set.');
	    return 80;
	  }
	  let exp = /^.+:\/\/.+:(\d+)$/g;
	  let match = exp.exec(origin);
	  if (match != null) {
	    return parseInt(match[1]);
	  } else {
	    if (origin.indexOf('https') >= 0) {
  	    return 443;
	    } else if (origin.indexOf('http') >= 0) {
	      return 80;
	    } else {
	      console.error('STATIC_FILES_ORIGIN does not have a http or https sceheme');
	      return 80;
	    }
	  }
	}

  function buildStaticHostname(req, res) {
    // Cannot understand why this need to be whitelisted
		if (localServer) {
			return config.get('STATIC_FILES_ORIGIN').split('//')[1];
		}

    if (devMode) {
      return process.env.STATIC_FILES_HOST;
    } else {
      let origin = req.headers.host;
	  console.log(origin);
      if (!whitelistedBuckets[origin]) {
        if (hasWhitelistMatches(origin)) {
          // Use the prod bucket for non pol.is domains
          return whitelistedBuckets["pol.is"] + "." + process.env.STATIC_FILES_HOST;
        } else {
          console.error("got request with host that's not whitelisted: (" + req.headers.host + ")");
          return;
        }

      }
      origin = whitelistedBuckets[origin];
      return origin + "." + process.env.STATIC_FILES_HOST;
    }
  }

  function makeRedirectorTo(path) {
    return function(req, res) {
      let protocol = devMode ? "http://" : "https://";
      let url = protocol + req.headers.host + path;
      res.writeHead(302, {
        Location: url,
      });
      res.end();
    };
  }


  function makeFileFetcher(hostname, port, path, headers, preloadData) {

    return function(req, res) {
      let hostname = buildStaticHostname(req, res);
      if (!hostname) {
        fail(res, 500, "polis_err_file_fetcher_serving_to_domain");
        console.error(req.headers.host);
        console.error(req.path);
        return;
      }
      let url;
		  if (localServer) {
		    url = process.env.STATIC_FILES_ORIGIN + path;
		  } else {
	      if (devMode) {
	        url = "http://" + hostname + ":" + port + path;
	      } else {
	        // pol.is.s3-website-us-east-1.amazonaws.com
	        // preprod.pol.is.s3-website-us-east-1.amazonaws.com
	
	        // TODO https - buckets would need to be renamed to have dashes instead of dots.
	        // http://stackoverflow.com/questions/3048236/amazon-s3-https-ssl-is-it-possible
	        url = "http://" + hostname + path;
	      }
		  }
      winston.log("info", "fetch file from " + url);
      let x = request(url);
      req.pipe(x);
      if (!_.isUndefined(preloadData)) {
        x = x.pipe(replaceStream("\"REPLACE_THIS_WITH_PRELOAD_DATA\"", JSON.stringify(preloadData)));
      }
      // let title = "foo";
      // let description = "bar";
      // let site_name = "baz";

      let fbMetaTagsString = "<meta property=\"og:image\" content=\"https://s3.amazonaws.com/pol.is/polis_logo.png\" />\n";
      if (preloadData && preloadData.conversation) {
        fbMetaTagsString += "    <meta property=\"og:title\" content=\"" + preloadData.conversation.topic + "\" />\n";
        fbMetaTagsString += "    <meta property=\"og:description\" content=\"" + preloadData.conversation.description + "\" />\n";
        // fbMetaTagsString += "    <meta property=\"og:site_name\" content=\"" + site_name + "\" />\n";
      }
      x = x.pipe(replaceStream("<!-- REPLACE_THIS_WITH_FB_META_TAGS -->", fbMetaTagsString));

      res.set(headers);

      x.pipe(res);
      x.on("error", function(err) {
        fail(res, 500, "polis_err_finding_file " + path, err);
      });
      // http.get(url, function(proxyResponse) {
      //     if (devMode) {
      //         addStaticFileHeaders(res);
      //     }
      //     res.setHeader('Content-Type', contentType);
      //     proxyResponse.on('data', function (chunk) {
      //         res.write(chunk);
      //     });
      //     proxyResponse.on('end', function () {
      //         res.end();
      //     });
      // }).on("error", function(e) {
      //     fail(res, 500, "polis_err_serving_file", new Error("polis_err_serving_file"));
      // });
    };
  }

  // function isIE(req) {
  //   let h = req.headers['user-agent'];
  //   return /MSIE [0-9]/.test(h) || /Trident/.test(h);
  // }

  function isUnsupportedBrowser(req) {
    return /MSIE [234567]/.test(req.headers['user-agent']);
  }

  function browserSupportsPushState(req) {
    return !/MSIE [23456789]/.test(req.headers['user-agent']);
  }

  // serve up index.html in response to anything starting with a number
  let hostname = process.env.STATIC_FILES_HOST;
  let portForParticipationFiles = process.env.STATIC_FILES_PORT;
  let portForAdminFiles = process.env.STATIC_FILES_ADMINDASH_PORT;


  let fetchUnsupportedBrowserPage = makeFileFetcher(hostname, portForParticipationFiles, "/unsupportedBrowser.html", {
    'Content-Type': "text/html",
  });

  function fetchIndex(req, res, preloadData, port, buildNumber) {
    let headers = {
      'Content-Type': "text/html",
    };
    if (!devMode) {
      Object.assign(headers, {
        // 'Cache-Control': 'no-transform,public,max-age=60,s-maxage=60', // Cloudflare will probably cache it for one or two hours
        'Cache-Control': 'no-cache', // Cloudflare will probably cache it for one or two hours
      });
    }

    setCookieTestCookie(req, res, shouldSetCookieOnPolisDomain(req));

    if (devMode) {
      buildNumber = null;
    }

    let indexPath = (buildNumber ? ("/cached/" + buildNumber) : "") + "/index.html";

    let doFetch = makeFileFetcher(hostname, port, indexPath, headers, preloadData);
    if (isUnsupportedBrowser(req)) {

      return fetchUnsupportedBrowserPage(req, res);

    } else if (!browserSupportsPushState(req) &&
      req.path.length > 1 &&
      !/^\/api/.exec(req.path) // TODO probably better to create a list of client-side route regexes (whitelist), rather than trying to blacklist things like API calls.
    ) {

      // Redirect to the same URL with the path behind the fragment "#"
      res.writeHead(302, {
        Location: "https://" + req.headers.host + "/#" + req.path,
      });

      return res.end();
    } else {
      return doFetch(req, res);
    }
  }

  function fetchIndexWithoutPreloadData(req, res, port) {

    return fetchIndex(req, res, {}, port);
  }


  function ifDefinedFirstElseSecond(first, second) {
    return _.isUndefined(first) ? second : first;
  }


  let fetch404Page = makeFileFetcher(hostname, portForAdminFiles, "/404.html", {
    'Content-Type': "text/html",
  });

  function fetchIndexForConversation(req, res) {
    console.log("fetchIndexForConversation", req.path);
    let match = req.path.match(/[0-9][0-9A-Za-z]+/);
    let conversation_id;
    if (match && match.length) {
      conversation_id = match[0];
    }
    let buildNumber = null;
    if (req.query.build) {
      buildNumber = req.query.build;
      console.log('loading_build', buildNumber);
    }

    setTimeout(function() {
      // Kick off requests to twitter and FB to get the share counts.
      // This will be nice because we cache them so it will be fast when
      // client requests these later.
      // TODO actually store these values in a cache that is shared between
      // the servers, probably just in the db.
      getTwitterShareCountForConversation(conversation_id).catch(function(err) {
        console.log("fetchIndexForConversation/getTwitterShareCountForConversation err " + err);
      });
      getFacebookShareCountForConversation(conversation_id).catch(function(err) {
        console.log("fetchIndexForConversation/getFacebookShareCountForConversation err " + err);
      });
    }, 100);

    doGetConversationPreloadInfo(conversation_id).then(function(x) {
      let preloadData = {
        conversation: x,
        // Nothing user-specific can go here, since we want to cache these per-conv index files on the CDN.
      };
      fetchIndex(req, res, preloadData, portForParticipationFiles, buildNumber);
    }).catch(function(err) {
      fetch404Page(req, res);
      // fail(res, 500, "polis_err_fetching_conversation_info2", err);
    });
  }


  let fetchIndexForAdminPage = makeFileFetcher(hostname, portForAdminFiles, "/index_admin.html", {
    'Content-Type': "text/html",
  });
  let fetchIndexForReportPage = makeFileFetcher(hostname, portForAdminFiles, "/index_report.html", {
    'Content-Type': "text/html",
  });



  function handle_GET_iip_conversation(req, res) {
    let conversation_id = req.params.conversation_id;
    res.set({
      'Content-Type': 'text/html',
    });
    res.send("<a href='https://pol.is/" + conversation_id + "' target='_blank'>" + conversation_id + "</a>");
  }


  function handle_GET_iim_conversation(req, res) {
    let zid = req.p.zid;
    let conversation_id = req.params.conversation_id;
    getConversationInfo(zid).then(function(info) {
      res.set({
        'Content-Type': 'text/html',
      });
      let title = info.topic || info.created;
      res.send("<a href='https://pol.is/" + conversation_id + "' target='_blank'>" + title + "</a>" +
        "<p><a href='https://pol.is/m" + conversation_id + "' target='_blank'>moderate</a></p>" +
        (info.description ? "<p>" + info.description + "</p>" : "")
      );
    }).catch(function(err) {
      fail(res, 500, "polis_err_fetching_conversation_info", err);
    });
  }



  function handle_GET_twitter_image(req, res) {
    console.log("handle_GET_twitter_image", req.p.id);
    getTwitterUserInfo({
      twitter_user_id: req.p.id,
    }, true).then(function(data) {
      data = JSON.parse(data);
      if (!data || !data.length) {
        fail(res, 500, "polis_err_finding_twitter_user_info");
        return;
      }
      data = data[0];
      let url = data.profile_image_url; // not https to save a round-trip

      let finished = false;
      http.get(url, function(twitterResponse) {
        if (!finished) {
          clearTimeout(timeoutHandle);
          finished = true;
          res.setHeader('Cache-Control', 'no-transform,public,max-age=18000,s-maxage=18000');
          twitterResponse.pipe(res);
        }
      }).on("error", function(err) {
        finished = true;
        fail(res, 500, "polis_err_finding_file " + url, err);
      });

      let timeoutHandle = setTimeout(function() {
        if (!finished) {
          finished = true;
          res.writeHead(504);
          res.end("request timed out");
          console.log("twitter_image timeout");
        }
      }, 9999);

    }).catch(function(err) {
      console.error("polis_err_missing_twitter_image", err);
      if (err && err.stack) {
        console.error(err.stack);
      }
      res.status(500).end();
    });
  }


  let handle_GET_conditionalIndexFetcher = (function() {
    return function(req, res) {
      if (hasAuthToken(req)) {
        // user is signed in, serve the app
        return fetchIndexForAdminPage(req, res);
      } else if (!browserSupportsPushState(req)) {
        // TEMPORARY: Don't show the landing page.
        // The problem is that /user/create redirects to #/user/create,
        // which ends up here, and since there's no auth token yet,
        // we would show the lander. One fix would be to serve up the auth page
        // as a separate html file, and not rely on JS for the routing.
        return fetchIndexForAdminPage(req, res);
      } else {
        // user not signed in, redirect to landing page
        res.redirect('/home');
      }
    };
  }());



  function handle_GET_localFile_dev_only(req, res) {
    let filename = String(req.path).split("/");
    filename.shift();
    filename.shift();
    filename = filename.join('/');
    if (!devMode) {
      // pretend this route doesn't exist.
      return proxy(req, res);
    }
    fs.readFile(filename, function(error, content) {
      if (error) {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/html',
        });
        res.end(content, 'utf-8');
      }
    });
  }

  function middleware_log_request_body(req, res, next) {
    if (devMode) {
      let b = "";
      if (req.body) {
        let temp = _.clone(req.body);
        // if (temp.email) {
        //     temp.email = "foo@foo.com";
        // }
        if (temp.password) {
          temp.password = "some_password";
        }
        if (temp.newPassword) {
          temp.newPassword = "some_password";
        }
        if (temp.password2) {
          temp.password2 = "some_password";
        }
        if (temp.hname) {
          temp.hname = "somebody";
        }
        if (temp.polisApiKey) {
          temp.polisApiKey = "pkey_somePolisApiKey";
        }
        b = JSON.stringify(temp);
      }
      winston.log("info", req.path + " " + b);
    } else {
      // don't log the route or params, since Heroku does that for us.
    }
    next();
  }

  function middleware_log_middleware_errors(err, req, res, next) {
    if (!err) {
      return next();
    }
    winston.log("info", "error found in middleware");
    console.error(err);
    if (err && err.stack) {
      console.error(err.stack);
    }
    yell(err);
    next(err);
  }

  function middleware_check_if_options(req, res, next) {
    if (req.method.toLowerCase() !== "options") {
      return next();
    }
    return res.send(204);
  }

  let middleware_responseTime_start = responseTime(function(req, res, time) {
    if (req && req.route && req.route.path) {
      let path = req.route.path;
      time = Math.trunc(time);
      addInRamMetric(path, time);
    }
  });

  console.log('end initializePolisHelpers');

  return {
    addCorsHeader,
    assignToP,
    assignToPCustom,
    auth,
    authOptional,
    COOKIES,
    denyIfNotFromWhitelistedDomain,
    devMode,
    emailTeam,
    enableAgid,
    fail,
    fetchIndexForAdminPage,
    fetchIndexForConversation,
    fetchIndexForReportPage,
    fetchIndexWithoutPreloadData,
    getArrayOfInt,
    getArrayOfStringLimitLength,
    getArrayOfStringNonEmpty,
    getArrayOfStringNonEmptyLimitLength,
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
    needHeader,
    pidCache,
    portForAdminFiles,
    portForParticipationFiles,
    proxy,
    redirectIfApiDomain,
    redirectIfHasZidButNoConversationId,
    redirectIfNotHttps,
    resolve_pidThing,
    sendTextEmail,
    timeout,
    want,
    wantCookie,
    wantHeader,
    winston,
    writeDefaultHead,
    yell,


    middleware_check_if_options,
    middleware_log_middleware_errors,
    middleware_log_request_body,
    middleware_responseTime_start,


    // handlers
    handle_DELETE_metadata_answers,
    handle_DELETE_metadata_questions,
    handle_GET_bid,
    handle_GET_bidToPid,
    handle_GET_canvas_app_instructions_png,
    handle_GET_changePlanWithCoupon,
    handle_GET_comments,
    handle_GET_comments_translations,
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
    handle_GET_logMaxmindResponse,
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
    hangle_GET_testConnection,
    hangle_GET_testDatabase,
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
    handle_POST_math_update,
    handle_POST_metadata_answers,
    handle_POST_metadata_questions,
    handle_POST_metrics,
    handle_POST_notifyTeam,
    handle_POST_participants,
    handle_POST_ptptCommentMod,
    handle_POST_query_participants_by_metadata,
    handle_POST_reportCommentSelections,
    handle_POST_reports,
    handle_POST_reserve_conversation_id,
    handle_POST_sendCreatedLinkToEmail,
    handle_POST_sendEmailExportReady,
    handle_POST_slack_interactive_messages,
    handle_POST_slack_user_invites,
    handle_POST_stars,
    handle_POST_stripe_cancel,
    handle_POST_stripe_save_token,
    handle_POST_stripe_upgrade,
    handle_POST_trashes,
    handle_POST_tutorial,
    handle_POST_upvotes,
    handle_POST_users_invite,
    handle_POST_votes,
    handle_POST_waitinglist,
    handle_POST_xidWhitelist,
    handle_POST_zinvites,
    handle_PUT_comments,
    handle_PUT_conversations,
    handle_PUT_participants_extended,
    handle_PUT_ptptois,
    handle_PUT_reports,
    handle_PUT_users,

    // Debugging
    //getNextPrioritizedComment,
    //getPca
  };

} // End of initializePolisHelpers


// debugging
//let ph = initializePolisHelpers()

//if (false) {
  //let nextP = ph.getNextPrioritizedComment(17794, 100, [], true);
//};


function initi18n(app) {
  app.use(i18n.init);
}

module.exports = {
  initializePolisHelpers,
  initi18n
};
