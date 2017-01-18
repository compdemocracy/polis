// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const akismetLib = require('akismet');
const badwords = require('badwords/object');
const Promise = require('bluebird');
const http = require('http');
const httpProxy = require('http-proxy');
// const Promise = require('es6-promise').Promise,
const sql = require("sql"); // see here for useful syntax: https://github.com/brianc/node-sql/blob/bbd6ed15a02d4ab8fbc5058ee2aff1ad67acd5dc/lib/node/valueExpression.js
const escapeLiteral = require('pg').Client.prototype.escapeLiteral;
const pg = require('pg').native; //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
const parsePgConnectionString = require('pg-connection-string').parse;
const async = require('async');
const FB = require('fb');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Intercom = require('intercom.io'); // https://github.com/tarunc/intercom.io
const IntercomOfficial = require('intercom-client');
const intercomClient = new IntercomOfficial.Client('nb5hla8s', process.env.INTERCOM_API_KEY).usePromises();
const OAuth = require('oauth');
// const Pushover = require('pushover-notifications');
// const pushoverInstance = new Pushover({
//   user: process.env.PUSHOVER_GROUP_POLIS_DEV,
//   token: process.env.PUSHOVER_POLIS_PROXY_API_KEY,
// });
const Mailgun = require('mailgun').Mailgun;
const mailgun = new Mailgun(process.env.MAILGUN_API_KEY);
const postmark = require("postmark")(process.env.POSTMARK_API_KEY);
const querystring = require('querystring');
const devMode = "localhost" === process.env.STATIC_FILES_HOST;
const replaceStream = require('replacestream');
const responseTime = require('response-time');
const request = require('request-promise'); // includes Request, but adds promise methods
const LruCache = require("lru-cache");
const timeout = require('connect-timeout');
const isValidUrl = require('valid-url');
const zlib = require('zlib');
const _ = require('underscore');
var WebClient = require('@slack/client').WebClient;
var web = new WebClient(process.env.SLACK_API_TOKEN);
// const winston = require("winston");
const winston = console;





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


const polisDevs = [
  // Mike
  125,
  26347, // polis
  91268, // facebook and twiter attached

  // Colin
  186, // gmail

  // Chris
  302, //  gmail
  36140, // polis
];

function isPolisDev(uid) {
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


const POLIS_FROM_ADDRESS = `Polis Team <${process.env.EMAIL_MIKE}>`;

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


// heroku pg standard plan has 120 connections
// plus a dev poller connection and a direct db connection
// 3 devs * (2 + 1 + 1) = 12 for devs
// plus the prod and preprod pollers = 14
// round up to 20
// so we can have 25 connections per server, of of which is the preprod server
// so we can have 1 preprod/3 prod servers, or 2 preprod / 2 prod.

if (devMode) {
  pg.defaults.poolSize = 2;
} else {
  pg.defaults.poolSize = 12;
}

// let SELF_HOSTNAME = "localhost:" + process.env.PORT;
// if (!devMode) {
// ^^^ possible to use localhost on Heroku?
//  SELF_HOSTNAME = process.env.SERVICE_HOSTNAME
//}



// metric name => {
//    values: [circular buffers of values (holds 1000 items)]
//    index: index in circular buffer
//}
const METRICS_IN_RAM = {};
const SHOULD_ADD_METRICS_IN_RAM = false;

function addInRamMetric(metricName, val) {
  if (!SHOULD_ADD_METRICS_IN_RAM) {
    return;
  }
  if (!METRICS_IN_RAM[metricName]) {
    METRICS_IN_RAM[metricName] = {
      values: new Array(1000),
      index: 0,
    };
  }
  let index = METRICS_IN_RAM[metricName].index;
  METRICS_IN_RAM[metricName].values[index] = val;
  METRICS_IN_RAM[metricName].index = (index + 1) % 1000;
}



// metered promise
function MPromise(name, f) {
  let p = new Promise(f);
  let start = Date.now();
  setTimeout(function() {
    addInRamMetric(name + ".go", 1, start);
  }, 100);
  p.then(function() {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".ok", duration, end);
    }, 100);
  }, function() {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".fail", duration, end);
    }, 100);
  }).catch(function(err) {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".fail", duration, end);
      console.log("MPromise internal error");
    }, 100);
  });
  return p;
}



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
  INFO = function() {};

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

const errorNotifications = (function() {
  let errors = [];

  function sendAll() {
    if (errors.length === 0) {
      return;
    }
    // pushoverInstance.send({
    //     title: "err",
    //     message: _.uniq(errors).join("\n"),
    // }, function(err, result) {
    //     winston.log("info","pushover " + err?"failed":"ok");
    //     winston.log("info",err);
    //     winston.log("info",result);
    // });
    errors = [];
  }
  setInterval(sendAll, 60 * 1000);
  return {
    add: function(token) {
      if (devMode && !_.isString(token)) {
        throw new Error("empty token for pushover");
      }
      console.error(token);
      errors.push(token);
    },
  };
}());
const yell = errorNotifications.add;


const intercom = new Intercom({
  apiKey: process.env.INTERCOM_API_KEY,
  appId: "nb5hla8s",
});


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
const sql_votes = sql.define({
  name: 'votes',
  columns: [
    "zid",
    "tid",
    "pid",
    "created",
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


// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI

winston.log("info", process.env.MONGOLAB_URI);

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
  pgQuery("select uid from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
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
//   return pgQueryP("insert into slack_bot_events (slack_team, event) values ($1, $2);", [slack_team, o]);
// }
function sendSlackEvent(o) {
  return pgQueryP("insert into slack_bot_events (event) values ($1);", [o]);
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
  return pgQueryP("select uid from lti_users where tool_consumer_instance_guid = $1 and lti_user_id = $2", [
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
  pgQuery("insert into auth_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(err, repliesSetToken) {
    if (err) {
      cb(err);
      return;
    }
    winston.log("info", 'startSession: token set.');
    cb(null, token);
  });
}

function endSession(sessionToken, cb) {
  pgQuery("delete from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
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
  pgQuery("insert into pwreset_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(errSetToken, repliesSetToken) {
    if (errSetToken) {
      cb(errSetToken);
      return;
    }
    cb(null, token);
  });
}

function getUidForPwResetToken(pwresettoken, cb) {
  // TODO "and created > timestamp - x"
  pgQuery("select uid from pwreset_tokens where token = ($1);", [pwresettoken], function(errGetToken, results) {
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
  pgQuery("delete from pwreset_tokens where token = ($1);", [pwresettoken], function(errDelToken, repliesSetToken) {
    if (errDelToken) {
      cb(errDelToken);
      return;
    }
    cb(null);
  });
}



// Same syntax as pg.client.query, but uses connection pool
// Also takes care of calling 'done'.
function pgQueryImpl() {
  let args = arguments;
  let queryString = args[0];
  let params;
  let callback;
  if (_.isFunction(args[2])) {
    params = args[1];
    callback = args[2];
  } else if (_.isFunction(args[1])) {
    params = [];
    callback = args[1];
  } else {
    throw "unexpected db query syntax";
  }

  pg.connect(this.pgConfig, function(err, client, done) {
    if (err) {
      callback(err);
      // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the done() callback
      done(err);
      yell("pg_connect_pool_fail");
      return;
    }
    client.query(queryString, params, function(err) {
      if (err) {
        // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the done() callback
        done(err);
      } else {
        done();
      }
      callback.apply(this, arguments);
    });
  });
}


const usingReplica = process.env.DATABASE_URL !== process.env[process.env.DATABASE_FOR_READS_NAME];
const prodPoolSize = usingReplica ? 3 : 12; /// 39
const pgPoolLevelRanks = ["info", "verbose"];
const pgPoolLoggingLevel = -1; // -1 to get anything more important than info and verbose. // pgPoolLevelRanks.indexOf("info");

const queryReadWriteObj = {
  isReadOnly: false,
  pgConfig: Object.assign(parsePgConnectionString(process.env.DATABASE_URL), {
    poolSize: (devMode ? 2 : prodPoolSize),
    // poolIdleTimeout: 30000, // max milliseconds a client can go unused before it is removed from the pool and destroyed
    // reapIntervalMillis: 1000, //frequeny to check for idle clients within the client pool
    poolLog: function(str, level) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        console.log("pool.primary." + level + " " + str);
      }
    },
  }),
};
const queryReadOnlyObj = {
  isReadOnly: true,
  pgConfig: Object.assign(parsePgConnectionString(process.env[process.env.DATABASE_FOR_READS_NAME]), {
    poolSize: (devMode ? 2 : prodPoolSize),
    // poolIdleTimeout: 30000, // max milliseconds a client can go unused before it is removed from the pool and destroyed
    // reapIntervalMillis: 1000, //frequeny to check for idle clients within the client pool
    poolLog: function(str, level) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        console.log("pool.replica." + level + " " + str);
      }
    },
  }),
};

function pgQuery() {
  return pgQueryImpl.apply(queryReadWriteObj, arguments);
}

function pgQuery_readOnly() {
  return pgQueryImpl.apply(queryReadOnlyObj, arguments);
}

function pgQueryP_impl(queryString, params) {
  if (!_.isString(queryString)) {
    return Promise.reject("query_was_not_string");
  }
  let f = this.isReadOnly ? pgQuery_readOnly : pgQuery;
  return new Promise(function(resolve, reject) {
    f(queryString, params, function(err, result) {
      if (err) {
        return reject(err);
      }
      if (!result || !result.rows) {
        // caller is responsible for testing if there are results
        return resolve([]);
      }
      resolve(result.rows);
    });
  });
}

function pgQueryP(queryString, params) {
  return pgQueryP_impl.apply(queryReadWriteObj, arguments);
}

function pgQueryP_readOnly(queryString, params) {
  return pgQueryP_impl.apply(queryReadOnlyObj, arguments);
}

function pgQueryP_readOnly_wRetryIfEmpty(queryString, params) {
  return pgQueryP_impl.apply(queryReadOnlyObj, arguments).then(function(rows) {
    if (!rows.length) {
      // the replica DB didn't have it (yet?) so try the master.
      return pgQueryP(queryString, params);
    }
    return rows;
  }); // NOTE: this does not retry in case of errors. Not sure what's best in that case.
}



function pgQueryP_metered_impl(name, queryString, params) {
  let f = this.isReadOnly ? pgQueryP_readOnly : pgQueryP;
  return new MPromise(name, function(resolve, reject) {
    f(queryString, params).then(resolve, reject);
  });
}

function pgQueryP_metered(name, queryString, params) {
  return pgQueryP_metered_impl.apply(queryReadWriteObj, arguments);
}

function pgQueryP_metered_readOnly(name, queryString, params) {
  return pgQueryP_metered_impl.apply(queryReadOnlyObj, arguments);
}

function hasAuthToken(req) {
  return !!req.cookies[COOKIES.TOKEN];
}



function getUidForApiKey(apikey) {
  return pgQueryP_readOnly_wRetryIfEmpty("select uid from apikeysndvweifu WHERE apikey = ($1);", [apikey]);
}


// http://en.wikipedia.org/wiki/Basic_access_authentication#Client_side
function doApiKeyBasicAuth(assigner, isOptional, req, res, next) {
  let header = req.headers.authorization || '', // get the header
    token = header.split(/\s+/).pop() || '', // and the encoded auth token
    auth = new Buffer(token, 'base64').toString(), // convert from base64
    parts = auth.split(/:/), // split on colon
    username = parts[0],
    // password = parts[1], // we don't use the password part (just use "apikey:")
    apikey = username;
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
    next("polis_err_auth_no_such_api_token");
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

// conversation_id is the client/ public API facing string ID
const parseConversationId = getStringLimitLength(1, 100);

function getConversationIdFetchZid(s) {
  return parseConversationId(s).then(function(conversation_id) {
    return getZidFromConversationId(conversation_id).then(function(zid) {
      return Number(zid);
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

function getArrayOfString(a) {
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

function getArrayOfStringNonEmpty(a) {
  if (!a || !a.length) {
    return Promise.reject("polis_fail_parse_string_array_empty");
  }
  return getArrayOfString(a);
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
  };
}());
const need = prrrams.need;
const want = prrrams.want;
// let needCookie = prrrams.needCookie;
const wantCookie = prrrams.wantCookie;

const COOKIES = {
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



function initializePolisHelpers(mongoParams) {

  let collectionOfPcaResults = mongoParams.mongoCollectionOfPcaResults;
  let collectionOfBidToPidResults = mongoParams.mongoCollectionOfBidToPidResults;
  let collectionOfPcaPlaybackResults = mongoParams.mongoCollectionOfPcaPlaybackResults;

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
  // pgQuery("select * from comments", [], function(err, comments) {
  //     pgQuery("select * from votes", [], function(err, votes) {
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

  function addCookies(req, res, token, uid) {
    return getUserInfoForUid2(uid).then(function(o) {
      let email = o.email;
      let created = o.created;
      let plan = o.plan;

      let setOnPolisDomain = !domainOverride;
      let origin = req.headers.origin || "";
      if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        setOnPolisDomain = false;
      }

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
      return pgQueryP("insert into permanentCookieZidJoins (cookie, zid) values ($1, $2);", [permanentCookieToken, zid]);
    }
    return pgQueryP("select zid from permanentCookieZidJoins where cookie = ($1) and zid = ($2);", [permanentCookieToken, zid]).then(
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


  function doVotesPost(uid, pid, conv, tid, voteType, weight, shouldNotify) {
    let zid = conv.zid;
    weight = weight || 0;
    let weight_x_32767 = Math.trunc(weight * 32767); // weight is stored as a SMALLINT, so convert from a [-1,1] float to [-32767,32767] int
    return new Promise(function(resolve, reject) {
      let query = "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, created) VALUES ($1, $2, $3, $4, $5, default) RETURNING *;";
      let params = [pid, zid, tid, voteType, weight_x_32767];
      pgQuery(query, params, function(err, result) {
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
    return pgQueryP_readOnly("select * from conversations where zid = ($1);", [zid]).then(function(rows) {
      if (!rows || !rows.length) {
        throw "polis_err_unknown_conversation";
      }
      let conv = rows[0];
      if (!conv.is_active) {
        throw "polis_err_conversation_is_closed";
      }
      if (conv.auth_needed_to_vote) {
        return getSocialInfoForUsers([uid]).then((info) => {
          var socialAccountIsLinked = info.length > 0;
          if (socialAccountIsLinked) {
            return conv;
          } else {
            throw "polis_err_post_votes_social_needed";
          }
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
      let q = sql_votes.select(sql_votes.star())
        .where(sql_votes.zid.equals(p.zid));

      if (!_.isUndefined(p.pid)) {
        q = q.where(sql_votes.pid.equals(p.pid));
      }
      if (!_.isUndefined(p.tid)) {
        q = q.where(sql_votes.tid.equals(p.tid));
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

  function redirectIfWrongDomain(req, res, next) {
    // let reServiceHostname = new RegExp(process.env.SERVICE_HOSTNAME);
    if (
      // reServiceHostname.test(req.headers.host) || // needed for heroku integrations (like slack?)
      /www.pol.is/.test(req.headers.host)
    ) {
      res.writeHead(302, {
        Location: "https://pol.is" + req.url,
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


  function createDummyUser() {
    return new MPromise("createDummyUser", function(resolve, reject) {
      pgQuery("INSERT INTO users (created) VALUES (default) RETURNING uid;", [], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
          console.error(err);
          reject(new Error("polis_err_create_empty_user"));
          return;
        }
        resolve(results.rows[0].uid);
      });
    });
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
  //         pgQuery(query,[], function(err, results) {
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


  function auth(assigner, isOptional) {
    return function(req, res, next) {
      //var token = req.body.token;
      let token = req.cookies[COOKIES.TOKEN];
      let xPolisToken = req.headers["x-polis"];

      if (xPolisToken && isPolisLtiToken(xPolisToken)) {
        doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, next);
      } else if (xPolisToken && isPolisSlackTeamUserToken(xPolisToken)) {
        doPolisSlackTeamUserTokenHeaderAuth(assigner, isOptional, req, res, next);
      } else if (xPolisToken) {
        doHeaderAuth(assigner, isOptional, req, res, next);
      } else if (token) {
        doCookieAuth(assigner, isOptional, req, res, next);
      } else if (req.headers.authorization) {
        doApiKeyBasicAuth(assigner, isOptional, req, res, next);
      } else if (req.body.agid) { // Auto Gen user  ID
        createDummyUser().then(function(uid) {
          return startSessionAndAddCookies(req, res, uid).then(function() {
            req.p = req.p || {};
            req.p.uid = uid;
            next();
          }, function(err) {
            res.status(500);
            console.error(err);
            next("polis_err_auth_token_error_2343");
          });
        }, function(err) {
          res.status(500);
          console.error(err);
          next("polis_err_auth_token_error_1241");
        }).catch(function(err) {
          res.status(500);
          console.error(err);
          next("polis_err_auth_token_error_5345");
        });
      } else if (isOptional) {
        next();
      } else {
        res.status(401);
        next("polis_err_auth_token_not_supplied");
      }
    };
  }


  // input token from body or query, and populate req.body.u with userid.
  function authOptional(assigner) {
    return auth(assigner, true);
  }


  function enableAgid(req, res, next) {
    req.body.agid = 1;
    next();
  }


  /*
  function meter(name) {
      return function (req, res, next){
          let start = Date.now();
          setTimeout(function() {
              metric(name + ".go", 1, start);
          }, 1);
          res.on('finish', function(){
            let end = Date.now();
            let duration = end - start;
            let status = ".ok";
            if (!res.statusCode || res.statusCode >= 500) {
              status = ".fail";
            } else if (res.statusCode >= 400) {
              status = ".4xx";
            }
            setTimeout(function() {
                metric(name + status, duration, end);
            }, 1);
          });
          next();
      };
  }
  */


  // 2xx
  // 4xx
  // 5xx
  // logins
  // failed logins
  // forgot password



  let whitelistedCrossDomainRoutes = [
    /^\/api\/v[0-9]+\/launchPrep/,
    /^\/api\/v[0-9]+\/setFirstCookie/,
  ];

  let whitelistedDomains = [
    "http://pol.is",
    "https://pol.is",
    "http://api.pol.is", // TODO delete?
    "https://api.pol.is",
    "http://www.pol.is",
    "https://www.pol.is",
    "http://preprod.pol.is",
    "https://preprod.pol.is",
    "http://gamma.pol.is",
    "https://gamma.pol.is",
    "http://embed.pol.is",
    "https://embed.pol.is",
    "http://survey.pol.is",
    "https://survey.pol.is",
    process.env.DOMAIN_WHITELIST_ITEM_01,
    process.env.DOMAIN_WHITELIST_ITEM_02,
    "http://localhost:5001",
    "http://localhost:5002",
    "https://canvas.instructure.com", // LTI
    "http://canvas.uw.edu", // LTI
    "https://canvas.uw.edu", // LTI
    "http://canvas.shoreline.edu", // LTI
    "https://canvas.shoreline.edu", // LTI
    "http://shoreline.instructure.com", // LTI
    "https://shoreline.instructure.com", // LTI
    "https://www.facebook.com",
    "https://facebook.com",
    "http://www.facebook.com",
    "http://m.facebook.com",
    "https://m.facebook.com",
    "http://facebook.com",
    "https://api.twitter.com",
    "", // for API
  ];

  let whitelistedBuckets = {
    "pol.is": "pol.is",
    "embed.pol.is": "pol.is",
    "survey.pol.is": "survey.pol.is",
    "preprod.pol.is": "preprod.pol.is",
  };

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

    if (!domainOverride && !whitelistedDomains.includes(host) && !routeIsWhitelistedForAnyDomain) {
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

  let lastPrefetchedVoteTimestamp = -1;

  // this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
  function fetchAndCacheLatestPcaData() {
    let lastPrefetchPollStartTime = Date.now();

    function waitTime() {
      let timePassed = Date.now() - lastPrefetchPollStartTime;
      return Math.max(0, 2500 - timePassed);
    }

    INFO("mathpoll begin", lastPrefetchedVoteTimestamp);
    let cursor = collectionOfPcaResults.find({
      lastVoteTimestamp: {
        $gt: lastPrefetchedVoteTimestamp,
      },
    });
    // cursor.sort([["lastVoteTimestamp", "asc"]]);

    function processItem(err, item) {
      if (err) {
        console.error(err);
        console.error("mathpoll err", "polis_err_prefetch_pca_results_iter");
        setTimeout(fetchAndCacheLatestPcaData, 10 * waitTime());
        return;
      }
      if (item === null) {
        // call again
        INFO("mathpoll done");
        setTimeout(fetchAndCacheLatestPcaData, waitTime());
        return;
      }

      INFO("mathpoll updating", item.lastVoteTimestamp, item.zid);

      // let prev = pcaCache.get(item.zid);

      updatePcaCache(item.zid, item).then(function(o) {
        if (item.lastVoteTimestamp > lastPrefetchedVoteTimestamp) {
          lastPrefetchedVoteTimestamp = item.lastVoteTimestamp;
        }
        cursor.nextObject(processItem);
      }, function(err) {
        cursor.nextObject(processItem);
      });
    }
    cursor.nextObject(processItem);
  }

  // don't start immediately, let other things load first.
  setTimeout(fetchAndCacheLatestPcaData, 3000);

  function getPca(zid, lastVoteTimestamp) {
    let cached = pcaCache.get(zid);
    let cachedPOJO = cached && cached.asPOJO;
    if (cachedPOJO) {
      if (cachedPOJO.lastVoteTimestamp <= lastVoteTimestamp) {
        INFO("mathpoll related", "math was cached but not new", zid, lastVoteTimestamp);
        return Promise.resolve(null);
      } else {
        INFO("mathpoll related", "math from cache", zid, lastVoteTimestamp);
        return Promise.resolve(cached);
      }
    }

    INFO("mathpoll cache miss", zid, lastVoteTimestamp);

    // NOTE: not caching results from this query for now, think about this later.
    // not caching these means that conversations without new votes might not be cached. (closed conversations may be slower to load)
    // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down with the poll.
    return new MPromise("pcaGet", function(resolve, reject) {
      let queryStart = Date.now();
      collectionOfPcaResults.find({
        zid: zid,
      }, function(err, cursor) {
        if (err) {
          reject("polis_err_get_pca_results_find");
          return;
        }

        let queryEnd = Date.now();
        let queryDuration = queryEnd - queryStart;
        addInRamMetric("pcaGetQuery", queryDuration);

        let nextObjectStart = Date.now();
        cursor.nextObject(function(err, item) {

          let nextObjectEnd = Date.now();
          let nextObjectDuration = nextObjectEnd - nextObjectStart;
          addInRamMetric("pcaGetToArray", nextObjectDuration);

          if (err) {
            reject("polis_err_get_pca_results_find_toarray");
          } else if (!item) {
            INFO("mathpoll related", "after cache miss, unable to find item", zid, lastVoteTimestamp);
            resolve(null);
          } else if (item.lastVoteTimestamp <= lastVoteTimestamp) {
            INFO("mathpoll related", "after cache miss, unable to find newer item", zid, lastVoteTimestamp);
            resolve(null);
          } else {
            INFO("mathpoll related", "after cache miss, found item, adding to cache", zid, lastVoteTimestamp);

            updatePcaCache(zid, item).then(function(o) {
              resolve(o);
            }, function(err) {
              reject(err);
            });
          }
        });
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
        };
        // save in LRU cache, but don't update the lastPrefetchedVoteTimestamp
        pcaCache.set(zid, o);
        resolve(o);
      });
    });
  }


  function getPcaPlaybackByLastVoteTimestamp(zid, lastVoteTimestamp) {
    return new Promise(function(resolve, reject) {
      collectionOfPcaPlaybackResults.find({
        $and: [{
          zid: zid,
        }, {
          lastVoteTimestamp: lastVoteTimestamp,
        }],
      }, function(err, cursor) {
        if (err) {
          reject("polis_err_get_pca_playback_result_find");
          return;
        }
        cursor.toArray(function(err, docs) {
          if (err) {
            reject("polis_err_get_pca_playback_result_find_toarray");
          } else if (!docs.length) {
            resolve(null);
          } else {
            resolve(docs[0]);
          }
        });
      });
    });
  }


  function getPcaPlaybackList(zid) {
    return new Promise(function(resolve, reject) {
      collectionOfPcaPlaybackResults.find({
        zid: zid,
      }, function(err, cursor) {
        if (err) {
          reject("polis_err_get_pca_playback_results_list_find");
          return;
        }
        // TODO save some memory by using the cursor as a cursor
        cursor.toArray(function(err, docs) {
          if (err) {
            reject("polis_err_get_pca_playback_results_list_find_toarray");
          } else if (!docs.length) {
            resolve(null);
          } else {
            let summaries = [];
            if (docs.length) {
              summaries = docs.map(function(doc) {
                return {
                  lastVoteTimestamp: doc.lastVoteTimestamp,
                  "n-cmts": doc["n-cmts"],
                  n: doc.n,
                };
              });
            }
            resolve(summaries);
          }
        });
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
    let lastVoteTimestamp = req.p.lastVoteTimestamp;

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

    getPca(zid, lastVoteTimestamp).then(function(data) {
      if (data) {
        // The buffer is gzipped beforehand to cut down on server effort in re-gzipping the same json string for each response.
        // We can't cache this endpoint on Cloudflare because the response changes too freqently, so it seems like the best way
        // is to cache the gzipped json'd buffer here on the server.
        res.set({
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
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

  /*
      addConversationId(o).then(function(item) {
          // ensure we don't expose zid
          if (item.zid) {
              delete item.zid;
          }
          res.status(200).json(item);
      }, function(err) {
          fail(res, 500, "polis_err_finishing_responseA", err);
      }).catch(function(err) {
          fail(res, 500, "polis_err_finishing_response", err);
      });
  */



  function doProxyDataExportCall(retryCount, req, res, urlBuilderFunction, returnImmediately) {
    Promise.all([
      getUserInfoForUid2(req.p.uid),
      getConversationInfo(req.p.zid),
    ]).then(function(a) {
      let user = a[0];
      let conv = a[1];
      let isOwner = req.p.uid === conv.owner;
      let isAllowed = isOwner || isPolisDev(req.p.uid) || conv.is_data_open;

      if (!isAllowed) {
        fail(res, 403, "polis_err_permission");
        return;
      }
      let exportServerUser = process.env.EXPORT_SERVER_AUTH_USERNAME;
      let exportServerPass = process.env.EXPORT_SERVER_AUTH_PASS;

      let url = urlBuilderFunction(exportServerUser, exportServerPass, user.email);

      let x = request({
        method: "GET",
        uri: url,
        followRedirect: false,
      });
      req.pipe(x);
      x.on("error", function(err) {
        if (retryCount < 3) {
          doProxyDataExportCall(retryCount + 1, req, res, urlBuilderFunction, returnImmediately);
        } else {
          emailBadProblemTime("darwin call failed after " + retryCount + " tries - " + JSON.stringify(err));
        }
      });
      if (returnImmediately) {
        res.status(200).json({});
      } else {
        x.pipe(res);
        x.on("error", function(err) {
          fail(res, 500, "polis_err_data_export1", err);
        });
      }
    }, function(err) {
      fail(res, 500, "polis_err_data_export2", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_data_export3", err);
    });
  }


  function handle_GET_dataExport(req, res) {
    doProxyDataExportCall(0, req, res, function(exportServerUser, exportServerPass, email) {
      return "https://" +
        exportServerUser + ":" + exportServerPass +
        "@"+process.env.SERVICE_MATHAPI_HOSTNAME+"/datadump/get?zinvite=" +
        req.p.conversation_id +
        "&format=" + req.p.format + "&email=" +
        email +
        (req.p.unixTimestamp ? ("&at-date=" + req.p.unixTimestamp * 1000) : "");
    }, true);
  }


  function handle_GET_dataExport_results(req, res) {
    doProxyDataExportCall(0, req, res, function(exportServerUser, exportServerPass, email) {
      return "https://" +
        exportServerUser + ":" + exportServerPass +
        "@"+process.env.SERVICE_MATHAPI_HOSTNAME+"/datadump/results?zinvite=" +
        req.p.conversation_id +
        "&filename=" + req.p.filename;
    }, false);
  }


  function handle_GET_pcaPlaybackList(req, res) {
    let zid = req.p.zid;
    getPcaPlaybackList(zid).then(function(summaries) {
      res.status(200).json(summaries);
    }).catch(function(err) {
      fail(res, 500, err);
    });
  }


  function handle_GET_pcaPlaybackByLastVoteTimestamp(req, res) {
    let zid = req.p.zid;
    let lastVoteTimestamp = req.p.lastVoteTimestamp;
    getPcaPlaybackByLastVoteTimestamp(zid, lastVoteTimestamp).then(function(data) {
      res.status(200).json(data);
    }).catch(function(err) {
      fail(res, 500, err);
    });
  }

  function getBidToPidMapping(zid, lastVoteTimestamp) {
    lastVoteTimestamp = lastVoteTimestamp || -1;
    return new MPromise("getBidToPidMapping", function(resolve, reject) {
      collectionOfBidToPidResults.find({
        zid: zid,
      }, function(err, cursor) {
        if (err) {
          reject("polis_err_get_pca_results_find");
          return;
        }
        cursor.toArray(function(err, docs) {
          if (err) {
            reject(new Error("polis_err_get_pca_results_find_toarray"));
            return;
          }
          if (!docs.length) {
            // Could actually be a 404, would require more work to determine that.
            reject(new Error("polis_err_get_pca_results_missing"));
          } else if (docs[0].lastVoteTimestamp <= lastVoteTimestamp) {
            reject(new Error("polis_err_get_pca_results_not_new"));
          } else {
            resolve(docs[0]);
          }
        });
      });
    });
  }


  function handle_GET_bidToPid(req, res) {
    let zid = req.p.zid;
    let lastVoteTimestamp = req.p.lastVoteTimestamp;
    getBidToPidMapping(zid, lastVoteTimestamp).then(function(doc) {
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
        " where owner in (select owner from conversations where zid = ($1));", [zid],
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


  function getBidsForPids(zid, lastVoteTimestamp, pids) {
    let dataPromise = getBidToPidMapping(zid, lastVoteTimestamp);
    let mathResultsPromise = getPca(zid, lastVoteTimestamp);

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

  function getClusters(zid, lastVoteTimestamp) {
    return getPca(zid, lastVoteTimestamp).then(function(pcaData) {
      return pcaData.asPOJO["group-clusters"];
    });
  }


  function handle_GET_bid(req, res) {
    let uid = req.p.uid;
    let zid = req.p.zid;
    let lastVoteTimestamp = req.p.lastVoteTimestamp;

    let dataPromise = getBidToPidMapping(zid, lastVoteTimestamp);
    let pidPromise = getPidPromise(zid, uid);
    let mathResultsPromise = getPca(zid, lastVoteTimestamp);

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
        return pgQueryP("insert into jianiuevyew (uid, pwhash) values "+
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
      return pgQueryP("insert into slack_oauth_access_tokens (slack_access_token, slack_scope, slack_auth_response) values ($1, $2, $3);", [
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
    return pgQueryP_readOnly("SELECT uid FROM users where LOWER(email) = ($1);", [email]).then(function(rows) {
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

    pgQueryP("insert into metrics (uid, type, dur, hashedPc, created) values "+ entries.join(",") +";", []).then(function(result) {
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
  //     return pgQueryP("insert into apikeysndvweifu (uid, apikey)  VALUES ($1, $2);", [uid, apikey]);
  //   });
  // }


  // function getApiKeysTruncated(uid) {
  //   return pgQueryP_readOnly("select * from apikeysndvweifu WHERE uid = ($1);", [uid]).then(function(rows) {
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
  //     return pgQueryP("insert into apikeysndvweifu (uid, apikey) values ($1, $2) returning *;", [uid, apikey]).then(function(row) {
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
  //   return pgQueryP("delete from apikeysndvweifu where uid = ($1) and apikey ~ '^" + apikeyTruncated + "';", [uid]);
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
  //         return pgQueryP(query, []);
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
      return pgQueryP('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite]).then(function(rows) {
        return zinvite;
      });
    });
  }



  function handle_POST_zinvites(req, res) {
    let generateShortUrl = req.p.short_url;

    pgQuery('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
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
    return pgQueryP_metered("getZinvite", "select * from zinvites where zid = ($1);", [zid]).then(function(rows) {
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
    pgQuery('SELECT * FROM suzinvites WHERE zid = ($1) AND suzinvite = ($2);', [zid, suzinvite], function(err, results) {
      if (err || !results || !results.rows || !results.rows.length) {
        callback(1);
      } else {
        callback(null); // ok
      }
    });
  }

  function getSUZinviteInfo(suzinvite) {
    return new Promise(function(resolve, reject) {
      pgQuery('SELECT * FROM suzinvites WHERE suzinvite = ($1);', [suzinvite], function(err, results) {
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
      pgQuery("DELETE FROM suzinvites WHERE suzinvite = ($1);", [suzinvite], function(err, results) {
        if (err) {
          // resolve, but complain
          yell("polis_err_removing_suzinvite");
        }
        resolve();
      });
    });
  }

  function xidExists(xid, owner, uid) {
    return pgQueryP("select * from xids where xid = ($1) and owner = ($2) and uid = ($3);", [xid, owner, uid]).then(function(rows) {
      return rows && rows.length;
    });
  }

  function createXidEntry(xid, owner, uid) {
    return new Promise(function(resolve, reject) {
      pgQuery("INSERT INTO xids (uid, owner, xid) VALUES ($1, $2, $3);", [uid, owner, xid], function(err, results) {
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

    pgQuery(q, [zid], function(err, qa_results) {
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
          pgQuery(
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
    return pgQueryP("insert into participant_locations (zid, uid, pid, lat, lng, source) values ($1,$2,$3,$4,$5,$6);", [
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
      pgQueryP_readOnly("select * from facebook_users where uid = ($1);", [uid]),
      pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [uid]),
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
    return pgQueryP("update participants set last_interaction = now_as_millis() where zid = ($1) and uid = ($2);", [zid, uid]);
  }


  function addExtendedParticipantInfo(zid, uid, data) {
    if (!data || !_.keys(data).length) {
      return Promise.resolve();
    }
    let params = Object.assign({}, data, {
      zid: zid,
      uid: uid,
    });
    let q = sql_participants_extended.insert(params);
    return pgQueryP(q.toString(), [])
      .catch(function() {
        let params2 = Object.assign({
          created: 9876543212345, // hacky string, will be replaced with the word "default".
        }, params);
        // TODO replace all this with an upsert once heroku upgrades postgres
        let qUpdate = sql_participants_extended.update(params2)
          .where(sql_participants_extended.zid.equals(zid))
          .and(sql_participants_extended.uid.equals(uid));
        let qString = qUpdate.toString();
        qString = qString.replace("9876543212345", "default");
        return pgQueryP(qString, []);
      });
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
    return pgQueryP_readOnly("select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1);", [zid, uid]).then(function(rows) {
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
      POLIS_FROM_ADDRESS, [process.env.EMAIL_MIKE, process.env.EMAIL_COLIN, process.env.EMAIL_CHRIS],
      "Dummy button clicked!!!",
      body)
    .catch(function(err) {
      yell("polis_err_failed_to_email_for_dummy_button");
      yell(message);
    });
  }

  function emailTeam(subject, body) {
    return sendMultipleTextEmails(
      POLIS_FROM_ADDRESS, [process.env.EMAIL_MIKE, process.env.EMAIL_COLIN, process.env.EMAIL_CHRIS],
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


  function sendTextEmailWithMailgun(sender, recipient, subject, text) {
    winston.log("info", "sending email with mailgun: " + [sender, recipient, subject, text].join(" "));
    let servername = "";
    let options = {};
    return new Promise(function(resolve, reject) {
      mailgun.sendText(sender, [recipient], subject, text, servername, options, function(err) {
        if (err) {
          console.error("Unable to send email via mailgun to " + recipient + " " + err);
          yell("polis_err_mailgun_email_send_failed");
          reject(err);
        } else {
          winston.log("info", "sent email with mailgun to " + recipient);
          resolve();
        }
      });
    });
  }

  function sendTextEmailWithPostmark(sender, recipient, subject, text) {
    winston.log("info", "sending email with postmark: " + [sender, recipient, subject, text].join(" "));
    return new Promise(function(resolve, reject) {
      postmark.send({
        "From": sender,
        "To": recipient,
        "Subject": subject,
        "TextBody": text,
      }, function(error, success) {
        if (error) {
          console.error("Unable to send email via postmark to " + recipient + " " + error.message);
          yell("polis_err_postmark_email_send_failed");
          reject(error);
        } else {
          winston.log("info", "sent email with postmark to " + recipient);
          resolve();
        }
      });
    });
  }

  function sendTextEmail(sender, recipient, subject, text) {
    let promise = sendTextEmailWithMailgun(sender, recipient, subject, text).catch(function(err) {
      yell("polis_err_primary_email_sender_failed");
      return sendTextEmailWithPostmark(sender, recipient, subject, text);
    });
    promise.catch(function(err) {
      yell("polis_err_backup_email_sender_failed");
    });
    return promise;
  }

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

  function trySendingBackupEmailTest() {
    let d = new Date();
    if (d.getDay() === 1) {
      // send the monday backup email system test
      // If the sending fails, we should get an error ping.
      sendTextEmailWithMailgun(POLIS_FROM_ADDRESS, process.env.EMAIL_MIKE, "monday backup email system test (mailgun)", "seems to be working");
    }
  }
  setInterval(trySendingBackupEmailTest, 1000 * 60 * 60 * 23); // try every 23 hours (so it should only try roughly once a day)
  trySendingBackupEmailTest();


  function sendEinviteEmail(req, email, einvite) {
    let serverName = getServerNameWithProtocol(req);
    const body =
`Welcome to pol.is!

Click this link to open your account:

${serverName}/welcome/${einvite}

Thank you for using Polis`;

    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      "Get Started with Polis",
      body);
  }

  function sendVerificaionEmail(req, email, einvite) {
    let serverName = getServerNameWithProtocol(req);
    let body =
`Welcome to pol.is!

Click this link to verify your email address:

${serverName}/api/v3/verify?e=${einvite}`;

    return sendTextEmail(
      POLIS_FROM_ADDRESS,
      email,
      "Polis verification",
      body);
  }

  function isEmailVerified(email) {
    return pgQueryP("select * from email_validations where email = ($1);", [email]).then(function(rows) {
      return rows.length > 0;
    });
  }

  function handle_GET_verification(req, res) {
    let einvite = req.p.e;
    pgQueryP("select * from einvites where einvite = ($1);", [einvite]).then(function(rows) {
      if (!rows.length) {
        fail(res, 500, "polis_err_verification_missing");
      }
      let email = rows[0].email;
      return pgQueryP("select email from email_validations where email = ($1);", [email]).then(function(rows) {
        if (rows && rows.length > 0) {
          return true;
        }
        return pgQueryP("insert into email_validations (email) values ($1);", [email]);
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

    pgQueryP_readOnly("select * from participants where uid = ($1) and zid = ($2)", [uid, zid]).then(function(rows) {
      let ptpt = rows && rows.length && rows[0] || null;
      res.status(200).json(ptpt);
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_participant", err);
    });

    // function fetchOne() {
    //     pgQuery("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
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
    //     pgQuery("SELECT users.hname, users.email, participants.pid FROM users INNER JOIN participants ON users.uid = participants.uid WHERE zid = ($1) ORDER BY participants.pid;", [zid], function(err, result) {
    //         if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
    //         res.json(result.rows);
    //     });
    // }
    // pgQuery("SELECT is_anon FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
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
    pgQueryP_readOnly("select * from conversations where "+field+" >= ($1);", [time]).then((rows) => {
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
            pgQueryP("select * from lti_users where uid = ($1)", [uid]).then(function(rows) {
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
    return pgQueryP("select * from lti_users where lti_user_id = ($1) and tool_consumer_instance_guid = ($2);", [lti_user_id, tool_consumer_instance_guid]).then(function(rows) {
      if (!rows || !rows.length) {
        return pgQueryP("insert into lti_users (uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) values ($1, $2, $3, $4);", [uid, lti_user_id, tool_consumer_instance_guid, lti_user_image]);
      }
    });
  }

  function addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) {
    return pgQueryP("select * from lti_context_memberships where uid = $1 and lti_context_id = $2 and tool_consumer_instance_guid = $3;", [uid, lti_context_id, tool_consumer_instance_guid]).then(function(rows) {
      if (!rows || !rows.length) {
        return pgQueryP("insert into lti_context_memberships (uid, lti_context_id, tool_consumer_instance_guid) values ($1, $2, $3);", [uid, lti_context_id, tool_consumer_instance_guid]);
      }
    });
  }


  function checkPassword(uid, password) {
    return pgQueryP_readOnly_wRetryIfEmpty("select pwhash from jianiuevyew where uid = ($1);", [uid]).then(function(rows) {
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

  function subscribeToNotifications(zid, uid) {
    let type = 1; // 1 for email
    winston.log("info", "subscribeToNotifications", zid, uid);
    return pgQueryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
      return type;
    });
  }

  function unsubscribeFromNotifications(zid, uid) {
    let type = 0; // 1 for nothing
    return pgQueryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
      return type;
    });
  }

  function getParticipantsThatNeedNotifications() {

    // TODO: currently this will currently err on the side of notifying people for comments that are pending moderator approval.

    // check it out! http://sqlformat.org/
    // let q = "SELECT * ";
    //     q += "FROM  ";
    //     q += "  (SELECT zid,  ";
    //     q += "          max(created) AS max_comment_time ";
    //     q += "   FROM comments  ";
    //     q += "   WHERE MOD >= 0 ";
    //     q += "   GROUP BY zid ";
    //     q += "   ORDER BY zid) AS foo ";
    //     q += "INNER JOIN participants AS p ON p.zid = foo.zid  ";
    //     q += "WHERE subscribed > 0 ";
    //     q += "  AND last_notified < (now_as_millis() - 3*60*60*1000) ";
    //     q += "  AND last_interaction < foo.max_comment_time;";



    // let q = "WITH needed_totals AS  ";
    // q += "  (SELECT zid,  ";
    // q += "          COUNT(*) AS total ";
    // q += "   FROM comments  ";
    // q += "   WHERE MOD >= 0 ";
    // q += "   GROUP BY zid),  ";
    // q += "     foo AS  ";
    // q += "  (SELECT voted.zid,  ";
    // q += "          voted.pid,  ";
    // q += "          COUNT(*) AS valid_votes ";
    // q += "   FROM  ";
    // q += "     (SELECT comments.zid,  ";
    // q += "             comments.tid ";
    // q += "      FROM comments  ";
    // q += "      WHERE MOD >= 0) AS needed ";
    // q += "   LEFT JOIN  ";
    // q += "     (SELECT zid,  ";
    // q += "             tid,  ";
    // q += "             pid ";
    // q += "      FROM votes) AS voted ON voted.tid = needed.tid ";
    // q += "   AND voted.zid = needed.zid ";
    // q += "   GROUP BY voted.zid,  ";
    // q += "            voted.pid ";
    // q += "   ORDER BY voted.zid,  ";
    // q += "            voted.pid),  ";
    // q += "     bar AS  ";
    // q += "  (SELECT foo.zid,  ";
    // q += "          foo.pid,  ";
    // q += "          participants.uid,  ";
    // q += "          participants.last_interaction,  ";
    // q += "          participants.subscribed,  ";
    // q += "          participants.last_notified,  ";
    // q += "          (total - valid_votes) AS remaining ";
    // q += "   FROM foo ";
    // q += "   INNER JOIN needed_totals ON needed_totals.zid = foo.zid ";
    // q += "   INNER JOIN participants ON foo.zid = participants.zid ";
    // q += "   AND foo.pid = participants.pid)  ";
    // q += "SELECT * ";
    // q += "FROM bar  ";
    // q += "WHERE subscribed = 1  ";
    // q += "  AND (last_notified + 30*60*1000) < last_interaction";
    // // q += "  AND remaining > 0";
    // q += ";";



    let q = "WITH needed_totals AS  ";
    q += "  (SELECT zid,  ";
    q += "          COALESCE(COUNT(*), 0) AS total ";
    q += "   FROM comments  ";
    q += "   WHERE MOD >= 0 AND ACTIVE = TRUE";
    q += "   GROUP BY zid),  ";
    q += "  participant_vote_counts AS (SELECT voted.zid,  ";
    q += "          voted.pid,  ";
    q += "          COUNT(*) AS valid_votes ";
    q += "   FROM  ";
    q += "     (SELECT comments.zid,  ";
    q += "             comments.tid ";
    q += "      FROM comments  ";
    q += "      WHERE MOD >= 0 AND ACTIVE = TRUE) AS needed ";
    q += "   LEFT JOIN  ";
    q += "     (SELECT zid,  ";
    q += "             tid,  ";
    q += "             pid ";
    q += "      FROM votes) AS voted ON voted.tid = needed.tid  ";
    q += "   AND voted.zid = needed.zid ";
    q += "   GROUP BY voted.zid, voted.pid ";
    q += "   ORDER BY voted.zid, voted.pid),  ";

    q += "  people_wo_votes AS (SELECT participants.zid,  ";
    q += "          participants.pid,  ";
    q += "          uid,  ";
    q += "          last_interaction,  ";
    q += "          subscribed,  ";
    q += "          last_notified,  ";
    q += "          COALESCE(needed_totals.total, 0) AS remaining ";
    q += "   FROM participants ";
    q += "   LEFT JOIN needed_totals ON participants.zid = needed_totals.zid ";
    q += "   LEFT JOIN participant_vote_counts ON participants.zid = participant_vote_counts.zid  ";
    q += "   AND participants.pid = participant_vote_counts.pid  ";
    q += "   WHERE participant_vote_counts.pid IS NULL ";
    q += "     AND participants.subscribed = 1),  ";

    q += "  bar AS  (SELECT participant_vote_counts.zid,  ";
    q += "          participant_vote_counts.pid,  ";
    q += "          participants.uid,  ";
    q += "          participants.last_interaction,  ";
    q += "          participants.subscribed,  ";
    q += "          participants.last_notified,  ";
    q += "          COALESCE(total - valid_votes, 0) AS remaining ";
    q += "   FROM participant_vote_counts ";
    q += "   INNER JOIN needed_totals ON needed_totals.zid = participant_vote_counts.zid ";
    q += "   INNER JOIN participants ON participant_vote_counts.zid = participants.zid  ";
    q += "   AND participant_vote_counts.pid = participants.pid),  ";

    // q += "  latest_comment_times AS (SELECT zid, modified as latest_comment_time from get_times_for_most_recent_visible_comments(), ";

    q += "  ppl AS (SELECT * ";
    q += "   FROM bar ";
    q += "   UNION SELECT * ";
    q += "   FROM people_wo_votes)  ";

    q += "SELECT * FROM ppl  ";
    q += " LEFT JOIN users";
    q += "  ON users.uid = ppl.uid";
    q += " LEFT JOIN conversations";
    q += "  ON conversations.zid = ppl.zid";
    // q += " LEFT JOIN latest_comment_times";
    // q += "  ON latest_comment_times.zid = ppl.zid";
    q += " LEFT JOIN zinvites";
    q += "  ON zinvites.zid = ppl.zid";
    q += " WHERE subscribed = 1 ";
    // q += "  AND (latest_comment_time + 30*60*1000) <= now_as_millis() "; // sub last_interaction with last_comment_time
    q += "  AND (last_notified + 24*60*60*1000) <= now_as_millis() "; // limit to one per day
    q += "  AND (last_interaction + 5*60*1000) <= now_as_millis() "; // wait 5 minutes after their last interaction
    q += "  AND remaining > 0 ";
    q += " ORDER BY ppl.zid, ppl.uid;";



    /*
    WITH
    needed_totals AS (SELECT
      zid,
      COALESCE(COUNT(*), 0) AS total
    FROM comments
    WHERE mod >= 0
    GROUP BY zid),

    foo AS (SELECT
      voted.zid,
      voted.pid,
      COUNT(*) AS valid_votes
    FROM (SELECT
      comments.zid,
      comments.tid
    FROM comments
    WHERE mod >= 0) AS needed
    LEFT JOIN (SELECT
      zid,
      tid,
      pid
    FROM votes) AS voted
      ON voted.tid = needed.tid
      AND voted.zid = needed.zid
    GROUP BY voted.zid,
             voted.pid
    ORDER BY voted.zid, voted.pid),

    people_wo_votes AS (SELECT
      participants.zid,
      participants.pid,
      uid,
      last_interaction,
      subscribed,
      last_notified,
      COALESCE(needed_totals.total, 0) as remaining
    FROM participants
    LEFT JOIN needed_totals
      ON participants.zid = needed_totals.zid
    LEFT JOIN foo
      ON participants.zid = foo.zid
      AND participants.pid = foo.pid
    WHERE foo.pid IS NULL AND participants.subscribed = 1),

    bar AS (SELECT
      foo.zid,
      foo.pid,
      participants.uid,
      participants.last_interaction,
      participants.subscribed,
      participants.last_notified,
      COALESCE(total - valid_votes, 0) AS remaining
    FROM foo
    INNER JOIN needed_totals
      ON needed_totals.zid = foo.zid
    INNER JOIN participants
      ON foo.zid = participants.zid
      AND foo.pid = participants.pid),

    ppl as (
    select * from bar
    UNION select * from people_wo_votes)

    SELECT *
    FROM ppl
    LEFT JOIN users
     ON users.uid = ppl.uid
    LEFT JOIN conversations
     ON conversations.zid = ppl.zid
    LEFT JOIN zinvites
     ON zinvites.zid = ppl.zid
    WHERE subscribed = 1
     ORDER BY ppl.zid, ppl.uid;
    -- AND (last_notified + 30*60*1000) <= last_interaction
    -- AND remaining > 0;
    */
    return pgQueryP_readOnly(q, []);
  }


  function sendNotificationEmail(uid, url, conversation_id, email, remaining) {
    let subject = "New comments to vote on";
    let body = "There are new comments available for you to vote on here:\n";
    body += "\n";
    body += url + "\n";
    body += "\n";
    body += "You're receiving this message because you're signed up to receive Polis notifications for this conversation. You can unsubscribe from these emails by clicking this link:\n";
    body += createNotificationsUnsubscribeUrl(conversation_id, email) + "\n";
    body += "\n";
    body += "\n";
    return sendEmailByUid(uid, subject, body);
  }

  function notifyParticipantsOfNewComments() {
    getParticipantsThatNeedNotifications().then(function(rows) {
      rows = rows || [];
      winston.log("info", "getParticipantsThatNeedNotifications", rows.length);
      winston.log("info", rows);
      rows.forEach(function(row) {
        let last_notified = row.last_notified; // only send an email if last_notified matches the one in the query above. This should prevent race conditions between multiple server instances.
        let url = row.parent_url;
        if (!url) {
          url = "https://pol.is/" + row.zinvite;
        }
        // NOTE: setting the DB status first to prevent a race condition where there can be multiple emails sent (one from each server)
        pgQueryP("update participants set last_notified = now_as_millis() where uid = ($1) and zid = ($2) and last_notified = ($3);", [row.uid, row.zid, last_notified]).then(function() {
          return sendNotificationEmail(row.uid, url, row.zinvite, row.email, row.remaining);
        }).catch(function(err) {
          yell("polis_err_notifying_participants_misc");
          console.error(err);
        });
      });
      winston.log("info", "end getParticipantsThatNeedNotifications");
    }).catch(function(err) {
      winston.log("info", "error getParticipantsThatNeedNotifications");
      console.error(err);
      // yell("polis_err_notifying_participants");
    });

  }

  if (!devMode) {
    notifyParticipantsOfNewComments();
    setInterval(function() {
      notifyParticipantsOfNewComments();
    }, 5 * 60 * 1000);
  }

  function updateEmail(uid, email) {
    return pgQueryP("update users set email = ($2) where uid = ($1);", [uid, email]);
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
      return pgQueryP("update participants set subscribed = 1 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
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
      email: req.p.email,
    };
    params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
    verifyHmacForQueryParams("api/v3/notifications/unsubscribe", params).then(function() {
      return pgQueryP("update participants set subscribed = 0 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
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
    let emailSetPromise = email ? updateEmail(uid, email) : Promise.resolve();
    emailSetPromise.then(function() {
      if (type === 1) {
        subscribeToNotifications(zid, uid).then(finish).catch(function(err) {
          fail(res, 500, "polis_err_sub_conv " + zid + " " + uid, err);
        });
      } else if (type === 0) {
        unsubscribeFromNotifications(zid, uid).then(finish).catch(function(err) {
          fail(res, 500, "polis_err_unsub_conv " + zid + " " + uid, err);
        });
      } else {
        fail(res, 400, "polis_err_bad_subscription_type", new Error("polis_err_bad_subscription_type"));
      }
    }, function(err) {
      fail(res, 500, "polis_err_subscribing_with_email", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_subscribing_misc", err);
    });
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
    pgQuery("SELECT * FROM users WHERE LOWER(email) = ($1);", [email], function(err, docs) {
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

      pgQuery("select pwhash from jianiuevyew where uid = ($1);", [uid], function(err, results) {
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
            return pgQueryP("select * from lti_users where uid = ($1)", [o.uid]).then(function(rows) {
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

          return xidExists(o.xid, o.owner, o.uid).then(function(exists) {
            if (exists) {
              // skip creating the entry (workaround for posgres's lack of upsert)
              return o;
            }
            return createXidEntry(o.xid, o.owner, o.uid).then(function() {
              return o;
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
    return pgQueryP("delete from facebook_users where uid = ($1);", [o.uid]);
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
    return pgQueryP("insert into facebook_users (uid, fb_user_id, fb_name, fb_link, fb_public_profile, fb_login_status, fb_access_token, fb_granted_scopes, fb_location_id, location, fb_friends_response, response) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);", [
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
    return pgQueryP("update facebook_users set modified=now_as_millis(), fb_user_id=($2), fb_name=($3), fb_link=($4), fb_public_profile=($5), fb_login_status=($6), fb_access_token=($7), fb_granted_scopes=($8), fb_location_id=($9), location=($10), fb_friends_response=($11), response=($12) where uid = ($1);", [
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
      return pgQueryP("insert into facebook_friends (uid, friend) select ($1), uid from facebook_users where fb_user_id in (" + fbFriendIds.join(",") + ");", [
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


  function isParentDomainWhitelisted(domain, zid, isWithinIframe) {
    return pgQueryP_readOnly(
        "select domain_whitelist from site_domain_whitelist where site_id = " +
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

    isParentDomainWhitelisted(ref, zid, isWithinIframe).then(function(isOk) {
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
    return pgQueryP("select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));", [uid])
      .then(function(rows) {
        if (!rows || !rows.length) {
          return pgQueryP("insert into site_domain_whitelist (site_id, domain_whitelist) values ((select site_id from users where uid = ($1)), $2);", [uid, newWhitelist]);
        } else {
          return pgQueryP("update site_domain_whitelist set domain_whitelist = ($2) where site_id = (select site_id from users where uid = ($1));", [uid, newWhitelist]);
        }
      });
  }

  function getDomainWhitelist(uid) {
    return pgQueryP("select * from site_domain_whitelist where site_id = (select site_id from users where uid = ($1));", [uid]).then(function(rows) {
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
    isModerator(zid, uid).then(function(is_mod) {
      if (!is_mod) {
        fail(res, 403, "polis_err_conversationStats_need_moderation_permission");
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
        pgQueryP_readOnly(q0, args),
        pgQueryP_readOnly(q1, args),
        // pgQueryP_readOnly("select created from participants where zid = ($1) order by created;", [zid]),

        // pgQueryP_readOnly("with pidvotes as (select pid, count(*) as countForPid from votes where zid = ($1)"+
        //     " group by pid order by countForPid desc) select countForPid as n_votes, count(*) as n_ptpts "+
        //     "from pidvotes group by countForPid order by n_ptpts asc;", [zid]),

        // pgQueryP_readOnly("with all_social as (select uid from facebook_users union select uid from twitter_users), "+
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

    if (isPolisDev(uid)) {
      // is polis developer
    } else {
      fail(res, 403, "polis_err_permissions");
    }

    pgQuery(
      "insert into conversations (topic, description, link_url, owner, modified, created, participant_count) " +
      "(select '(SNAPSHOT) ' || topic, description, link_url, $2, now_as_millis(), created, participant_count from conversations where zid = $1) returning *;", [
        zid,
        uid,
      ],
      function(err, result) {
        if (err) {
          fail(res, 500, "polis_err_cloning_conversation", err);
        }
        // winston.log("info",rows);
        let conv = result.rows[0];

        // let conv = rows[0];
        let newZid = conv.zid;
        return pgQueryP(
          "insert into participants (pid, zid, uid, created) " +
          "select pid, ($2), uid, created from participants where zid = ($1);", [
            zid,
            newZid,
          ]).then(function() {
            return pgQueryP(
              "insert into comments (pid, tid, zid, txt, velocity, mod, uid, active, created) " +
              "select pid, tid, ($2), txt, velocity, mod, uid, active, created from comments where zid = ($1);", [
                zid,
                newZid,
              ]).then(function() {
                return pgQueryP(
                  "insert into votes (pid, tid, zid, vote, created) " +
                  "select pid, tid, ($2), vote, created from votes where zid = ($1);", [
                    zid,
                    newZid,
                  ]).then(function() {
                    return generateAndRegisterZinvite(newZid, true).then(function(zinvite) {
                      res.status(200).json({
                        zid: newZid,
                        zinvite: zinvite,
                        url: getServerNameWithProtocol(req) + "/" + zinvite,
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
    let verified = o.info.verified;

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
          pgQueryP("select * from users where uid = ($1);", [uid]),
          pgQueryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, hname]),
          pgQueryP("update users set email = ($2) where uid = ($1) and email is NULL;", [uid, email]),
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
        promise = pgQueryP(query, [email, hname])
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

      pgQueryP("select users.*, facebook_users.fb_user_id from users left join facebook_users on users.uid = facebook_users.uid " +
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
    let hname = req.p.hname;
    let password = req.p.password;
    let password2 = req.p.password2; // for verification
    let email = req.p.email;
    let oinvite = req.p.oinvite;
    let zinvite = req.p.zinvite;
    let referrer = req.cookies[COOKIES.REFERRER];
    let organization = req.p.organization;
    let gatekeeperTosPrivacy = req.p.gatekeeperTosPrivacy;
    let lti_user_id = req.p.lti_user_id;
    let lti_user_image = req.p.lti_user_image;
    let lti_context_id = req.p.lti_context_id;
    let tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    let afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    let site_id = void 0;
    if (req.p.encodedParams) {
      let decodedParams = decodeParams(req.p.encodedParams);
      if (decodedParams.site_id) {
        // NOTE: we could have just allowed site_id to be passed as a normal param, but then we'd need to think about securing that with some other token sooner.
        // I think we can get by with this obscure scheme for a bit.
        // TODO_SECURITY add the extra token associated with the site_id owner.
        site_id = decodedParams.site_id;
      }
    }

    let shouldAddToIntercom = req.p.owner;
    if (req.p.lti_user_id) {
      shouldAddToIntercom = false;
    }

    if (password2 && (password !== password2)) {
      fail(res, 400, "Passwords do not match.");
      return;
    }
    if (!gatekeeperTosPrivacy) {
      fail(res, 400, "polis_err_reg_need_tos");
      return;
    }
    if (!email) {
      fail(res, 400, "polis_err_reg_need_email");
      return;
    }
    if (!hname) {
      fail(res, 400, "polis_err_reg_need_name");
      return;
    }
    if (!password) {
      fail(res, 400, "polis_err_reg_password");
      return;
    }
    if (password.length < 6) {
      fail(res, 400, "polis_err_reg_password_too_short");
      return;
    }
    if (!_.contains(email, "@") || email.length < 3) {
      fail(res, 400, "polis_err_reg_bad_email");
      return;
    }

    pgQueryP("SELECT * FROM users WHERE email = ($1)", [email]).then(function(rows) {

      if (rows.length > 0) {
        fail(res, 403, "polis_err_reg_user_with_that_email_exists");
        return;
      }

      generateHashedPassword(password, function(err, hashedPassword) {
        if (err) {
          fail(res, 500, "polis_err_generating_hash", err);
          return;
        }
        let query = "insert into users " +
          "(email, hname, zinvite, oinvite, is_owner" + (site_id ? ", site_id" : "") + ") VALUES " + // TODO use sql query builder
          "($1, $2, $3, $4, $5" + (site_id ? ", $6" : "") + ") " + // TODO use sql query builder
          "returning uid;";
        let vals =
          [email, hname, zinvite || null, oinvite || null, true];
        if (site_id) {
          vals.push(site_id); // TODO use sql query builder
        }

        pgQuery(query, vals, function(err, result) {
          if (err) {
            winston.log("info", err);
            fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
            return;
          }
          let uid = result && result.rows && result.rows[0] && result.rows[0].uid;

          pgQuery("insert into jianiuevyew (uid, pwhash) values ($1, $2);", [uid, hashedPassword], function(err, results) {
            if (err) {
              winston.log("info", err);
              fail(res, 500, "polis_err_reg_failed_to_add_user_record", err);
              return;
            }


            startSession(uid, function(err, token) {
              if (err) {
                fail(res, 500, "polis_err_reg_failed_to_start_session", err);
                return;
              }
              addCookies(req, res, token, uid).then(function() {

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
                        hname: hname,
                        email: email,
                      });
                    }
                  } else {
                    res.json({
                      uid: uid,
                      hname: hname,
                      email: email,
                      // token: token
                    });
                  }
                }).catch(function(err) {
                  fail(res, 500, "polis_err_creating_user_associating_with_lti_user", err);
                });

                if (shouldAddToIntercom) {
                  let params = {
                    "email": email,
                    "name": hname,
                    "user_id": uid,
                  };
                  let customData = {};
                  if (referrer) {
                    customData.referrer = referrer;
                  }
                  if (organization) {
                    customData.org = organization;
                  }
                  customData.uid = uid;
                  if (_.keys(customData).length) {
                    params.custom_data = customData;
                  }
                  intercom.createUser(params, function(err, res) {
                    if (err) {
                      winston.log("info", err);
                      console.error("polis_err_intercom_create_user_fail");
                      winston.log("info", params);
                      yell("polis_err_intercom_create_user_fail");
                      return;
                    }
                  });
                }
              }, function(err) {
                fail(res, 500, "polis_err_adding_cookies", err);
              }).catch(function(err) {
                fail(res, 500, "polis_err_adding_user", err);
              });
            }); // end startSession
          }); // end insert pwhash
        }); // end insert user
      }); // end generateHashedPassword

    }, function(err) {
      fail(res, 500, "polis_err_reg_checking_existing_users", err);
    });
  } // end /api/v3/auth/new


  function handle_POST_tutorial(req, res) {
    let uid = req.p.uid;
    let step = req.p.step;
    pgQueryP("update users set tut = ($1) where uid = ($2);", [step, uid]).then(function() {
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

    getUser(uid).then(function(user) {
      res.status(200).json(user);
    }, function(err) {
      fail(res, 500, "polis_err_getting_user_info2", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_getting_user_info", err);
    });
  }

  function getUser(uid) {
    if (!uid) {
      // this api may be called by a new user, so we don't want to trigger a failure here.
      return Promise.resolve({});
    }
    return Promise.all([
      getUserInfoForUid2(uid),
      getFacebookInfo([uid]),
      getTwitterInfo([uid]),
    ]).then(function(o) {
      let info = o[0];
      let fbInfo = o[1];
      let twInfo = o[2];

      let hasFacebook = fbInfo && fbInfo.length && fbInfo[0];
      let hasTwitter = twInfo && twInfo.length && twInfo[0];
      if (hasFacebook) {
        let width = 40;
        let height = 40;
        fbInfo.fb_picture = "https://graph.facebook.com/v2.2/" + fbInfo.fb_user_id + "/picture?width=" + width + "&height=" + height;
        delete fbInfo[0].response;
      }
      if (hasTwitter) {
        delete twInfo[0].response;
      }
      return {
        uid: uid,
        email: info.email,
        hname: info.hname,
        hasFacebook: !!hasFacebook,
        facebook: fbInfo && fbInfo[0],
        twitter: twInfo && twInfo[0],
        hasTwitter: !!hasTwitter,
        finishedTutorial: !!info.tut,
        site_ids: [info.site_id],
        created: Number(info.created),
        daysInTrial: 10 + (usersToAdditionalTrialDays[uid] || 0),
        // plan: planCodeToPlanName[info.plan],
        planCode: info.plan,
      };
    });
  }


  function _getCommentsForModerationList(o) {
    let modClause = "";
    let params = [o.zid];
    if (!_.isUndefined(o.mod)) {
      modClause = " and comments.mod = ($2)";
      params.push(o.mod);
    }
    return pgQueryP_metered_readOnly("_getCommentsForModerationList", "select * from (select tid, vote, count(*) from votes_latest_unique where zid = ($1) group by tid, vote) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)" + modClause, params).then((rows) => {
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
              sql_votes.subQuery().select(sql_votes.tid)
              .where(
                sql_votes.zid.equals(o.zid)
              ).and(
                sql_votes.pid.equals(o.not_voted_by_pid)
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
          q = q.order("random()");
        } else {
          q = q.order(sql_comments.created);
        }
        if (!_.isUndefined(o.limit)) {
          q = q.limit(o.limit);
        } else {
          q = q.limit(999); // TODO paginate
        }
        return pgQuery(q.toString(), [], function(err, docs) {
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

  function getComments(o) {
    let commentListPromise = o.moderation ? _getCommentsForModerationList(o) : _getCommentsList(o);

    return commentListPromise.then(function(rows) {
      let cols = [
        "txt",
        "tid",
        "created",
        "uid",
        "tweet_id",
        "quote_src_url",
        "anon",
        "is_seed",
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
      if (o.include_social) {
        let nonAnonComments = comments.filter(function(c) {
          return !c.anon && !c.is_seed;
        });
        let uids = _.pluck(nonAnonComments, "uid");
        return getSocialInfoForUsers(uids).then(function(socialInfos) {
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

  /*
   Rename column 'zid' to 'conversation_id', add a new column called 'zid' and have that be a VARCHAR of limited length.
   Use conversation_id internally, refactor math poller to use conversation_id
   continue to use zid externally, but it will be a string of limited length
   Don't expose the conversation_id to the client.

   plan:
   add the new column conversation_id, copy values from zid
   change the code to look things up by conversation_id

  */



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
        pgQueryP_readOnly("select pid, count(*) from votes where zid = ($1) group by pid;", [zid]),
        pgQueryP_readOnly("select pid, count(*) from comments where zid = ($1) group by pid;", [zid]),
        pgQueryP_readOnly("select pid, xid from xids inner join (select * from participants where zid = ($1)) as p on xids.uid = p.uid;", [zid]),
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


  function handle_GET_comments(req, res) {

    let rid = req.headers["x-request-id"] + " " + req.headers['user-agent'];
    winston.log("info", "getComments " + rid + " begin");

    getComments(req.p).then(function(comments) {

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

      finishArray(res, comments);
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
      body += " Comment is waiting for your review here: ";
    } else {
      body += " Comments are waiting for your review here: ";
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

  function moderateComment(zid, tid, active, mod) {
    return new Promise(function(resolve, reject) {
      pgQuery("UPDATE COMMENTS SET active=($3), mod=($4), modified=now_as_millis() WHERE zid=($1) and tid=($2);", [zid, tid, active, mod], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
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

  // function getComment(zid, tid) {
  //   return new MPromise("getComment", function(resolve, reject) {
  //     pgQuery("select * from comments where zid = ($1) and tid = ($2);", [zid, tid], function(err, results) {
  //       if (err) {
  //         reject(err);
  //       } else if (!results || !results.rows || !results.rows.length) {
  //         reject("polis_err_missing_comment");
  //       } else {
  //         resolve(results.rows[0]);
  //       }
  //     });
  //   });
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


  function getConversationInfo(zid) {
    return new MPromise("getConversationInfo", function(resolve, reject) {
      pgQuery("SELECT * FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(result.rows[0]);
        }
      });
    });
  }

  function commentExists(zid, txt) {
    return pgQueryP("select zid from comments where zid = ($1) and txt = ($2);", [zid, txt]).then(function(rows) {
      return rows && rows.length;
    });
  }

  function handle_POST_comments_slack(req, res) {
    const slack_team = req.p.slack_team;
    const slack_user_id = req.p.slack_user_id;


    pgQueryP("select * from slack_users where slack_team = ($1) and slack_user_id = ($2);", [slack_team, slack_user_id]).then((rows) => {
      if (!rows || !rows.length) {
        const uidPromise = createDummyUser();
        return uidPromise.then((uid) => {
          return pgQueryP("insert into slack_users (uid, slack_team, slack_user_id) values ($1, $2, $3) returning *;", [
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


    // either include txt, or a tweet id
    if (_.isUndefined(txt) &&
      _.isUndefined(twitter_tweet_id) &&
      _.isUndefined(quote_txt)
    ) {
      fail(res, 400, "polis_err_param_missing_txt");
      return;
    }

    if (quote_txt && _.isUndefined(quote_src_url)) {
      fail(res, 400, "polis_err_param_missing_quote_src_url");
      return;
    }

    function doGetPid() {
      // PID_FLOW
      if (_.isUndefined(pid)) {
        return getPidPromise(req.p.zid, req.p.uid, true).then((pid) => {
          if (pid === -1) {
            return addParticipant(req.p.zid, req.p.uid).then(function(rows) {
              let ptpt = rows[0];
              pid = ptpt.pid;
              currentPid = pid;
              return pid;
            });
          } else {
            return pid;
          }
        });
      }
      return Promise.resolve(pid);
    }


    let twitterPrepPromise = Promise.resolve();
    if (twitter_tweet_id) {
      twitterPrepPromise = prepForTwitterComment(twitter_tweet_id, zid);
    } else if (quote_twitter_screen_name) {
      twitterPrepPromise = prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid);
    }

    twitterPrepPromise.then(function(info) {

      let ptpt = info && info.ptpt;
      // let twitterUser = info && info.twitterUser;
      let tweet = info && info.tweet;

      if (tweet) {
        txt = tweet.text;
      } else if (quote_txt) {
        txt = quote_txt;
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

      let pidPromise;
      if (ptpt) {
        pidPromise = Promise.resolve(ptpt.pid);
      } else {
        pidPromise = doGetPid();
      }
      let commentExistsPromise = commentExists(zid, txt);

      Promise.all([pidPromise, conversationInfoPromise, isModeratorPromise, commentExistsPromise]).then(function(results) {
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
          console.dir(req.p);
        }
        let bad = hasBadWords(txt);
        isSpamPromise.then(function(spammy) {
          winston.log("info", "spam test says: " + txt + " " + (spammy ? "spammy" : "not_spammy"));
          return spammy;
        }, function(err) {
          console.error("spam check failed");
          winston.log("info", err);
          return false; // spam check failed, continue assuming "not spammy".
        }).then(function(spammy) {
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

          pgQuery(
            "INSERT INTO COMMENTS " +
            "(pid, zid, txt, velocity, active, mod, uid, tweet_id, quote_src_url, anon, is_seed, created, tid) VALUES " +
            "($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, default, null) RETURNING *;",
            [pid, zid, txt, velocity, active, mod, authorUid, twitter_tweet_id || null, quote_src_url || null, anon || false, is_seed || false],

            function(err, docs) {
              if (err) {
                winston.log("info", err);
                if (err.code === '23505' || err.code === 23505) {
                  // duplicate comment
                  fail(res, 409, "polis_err_post_comment_duplicate", err);
                } else {
                  fail(res, 500, "polis_err_post_comment", err);
                }
                return;
              }
              docs = docs.rows;
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
                  pgQueryP_readOnly("select * from users where site_id = (select site_id from page_ids where zid = ($1)) UNION select * from users where uid = ($2);", [zid, conv.owner]).then(function(users) {
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
                sendCommentModerationEmail(req, 125, zid, "?"); // email mike for all comments, since some people may not have turned on strict moderation, and we may want to babysit evaluation conversations of important customers.              
                sendSlackEvent({
                  type: "comment_mod_needed",
                  data: comment,
                });
              }

              votesPost(uid, pid, zid, tid, vote, 0, false).then(function(o) {
                // let conv = o.conv;
                let vote = o.vote;
                let createdTime = vote.created;

                setTimeout(function() {
                  updateConversationModifiedTime(zid, createdTime);
                  updateLastInteractionTimeForConversation(zid, uid);
                  updateVoteCount(zid, pid);
                }, 100);

                res.json({
                  tid: tid,
                  currentPid: currentPid,
                });
              }, function(err) {
                fail(res, 500, "polis_err_vote_on_create", err);
              });


            }); // insert
        }, function(err) {
          yell("polis_err_unhandled_spam_check_error");

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
    //pgQuery('ROLLBACK', function(err) {
    //if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
    //});
    //};
    //pgQuery('BEGIN;', function(err) {
    //if(err) return rollback(client);
    ////process.nextTick(function() {
    //pgQuery("SET CONSTRAINTS ALL DEFERRED;", function(err) {
    //if(err) return rollback(client);
    //pgQuery("INSERT INTO comments (tid, pid, zid, txt, created) VALUES (null, $1, $2, $3, default);", [pid, zid, txt], function(err, docs) {
    //if(err) return rollback(client);
    //pgQuery('COMMIT;', function(err, docs) {
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

  function getNextCommentRandomly(zid, pid, withoutTids, include_social) {
    let params = {
      zid: zid,
      not_voted_by_pid: pid,
      limit: 1,
      random: true,
      include_social: include_social,
    };
    if (!_.isUndefined(withoutTids) && withoutTids.length) {
      params.withoutTids = withoutTids;
    }
    return getComments(params).then(function(comments) {
      if (!comments || !comments.length) {
        return null;
      } else {
        return comments[0];
      }
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
  //   q += "   FROM votes_lastest_unique($1) ";
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
  //   return pgQueryP_readOnly(q, [zid, pid]).then(function(comments) {
  //     if (!comments || !comments.length) {
  //       return null;
  //     } else {
  //       return comments[0];
  //     }
  //   });
  // }

  function getNextComment(zid, pid, withoutTids, include_social) {
    return getNextCommentRandomly(zid, pid, withoutTids, include_social);
    // return getNextCommentPrioritizingNonPassedComments(zid, pid, withoutTids, !!!!!!!!!!!!!!!!TODO IMPL!!!!!!!!!!!include_social);
  }

  // NOTE: only call this in response to a vote. Don't call this from a poll, like /api/v3/nextComment
  function addNoMoreCommentsRecord(zid, pid) {
    return pgQueryP("insert into event_ptpt_no_more_comments (zid, pid, votes_placed) values ($1, $2, " +
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

    getNextComment(req.p.zid, req.p.not_voted_by_pid, req.p.without, req.p.include_social).then(function(c) {
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


    Promise.all([
      // request.get({uri: "http://" + SELF_HOSTNAME + "/api/v3/users", qs: qs, headers: req.headers, gzip: true}),
      getUser(req.p.uid),
      // getIfConvAndAuth({uri: "http://" + SELF_HOSTNAME + "/api/v3/participants", qs: qs, headers: req.headers, gzip: true}),
      ifConvAndAuth(getParticipant, [req.p.zid, req.p.uid]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/nextComment", qs: nextCommentQs, headers: req.headers, gzip: true}),
      ifConv(getNextComment, [req.p.zid, req.p.pid, [], true]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/conversations", qs: qs, headers: req.headers, gzip: true}),
      ifConv(getOneConversation, [req.p.zid, req.p.uid]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/votes", qs: votesByMeQs, headers: req.headers, gzip: true}),
      ifConv(getVotesForSingleParticipant, [req.p]),
      ifConv(getPca, [req.p.zid, -1]),
      // getWith304AsSuccess({uri: "http://" + SELF_HOSTNAME + "/api/v3/math/pca2", qs: qs, headers: req.headers, gzip: true}),
      ifConv(doFamousQuery, [req.p, req]),
      // getIfConv({uri: "http://" + SELF_HOSTNAME + "/api/v3/votes/famous", qs: famousQs, headers: req.headers, gzip: true}),
    ]).then(function(arr) {
      let o = {
        user: arr[0],
        ptpt: arr[1],
        nextComment: arr[2],
        conversation: arr[3],
        votes: arr[4] || [],
        pca: arr[5] ? (arr[5].asJSON ? arr[5].asJSON : null) : null,
        famous: arr[6],
        // famous: JSON.parse(arr[6]),
        acceptLanguage: req.headers["accept-language"] || req.headers["Accept-Language"],
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
    return pgQueryP(query, params);
  }

  function handle_POST_votes(req, res) {
    let uid = req.p.uid; // PID_FLOW uid may be undefined here.
    let zid = req.p.zid;
    let pid = req.p.pid; // PID_FLOW pid may be undefined here.

    // We allow viewing (and possibly writing) without cookies enabled, but voting requires cookies (except the auto-vote on your own comment, which seems ok)
    let token = req.cookies[COOKIES.TOKEN];
    let apiToken = req.headers.authorization;
    let xPolisHeaderToken = req.headers['x-polis'];
    if (!uid && !token && !apiToken && !xPolisHeaderToken) {
      fail(res, 403, "polis_err_vote_noauth");
      return;
    }

    // PID_FLOW WIP for now assume we have a uid, but need a participant record.
    let pidReadyPromise = _.isUndefined(req.p.pid) ? addParticipant(req.p.zid, req.p.uid).then(function(rows) {
      let ptpt = rows[0];
      pid = ptpt.pid;
    }) : Promise.resolve();


    pidReadyPromise.then(function() {

      // let conv;
      let vote;

      pidReadyPromise.then(function() {
        return votesPost(uid, pid, req.p.zid, req.p.tid, req.p.vote, req.p.weight, true);
      }).then(function(o) {
        // conv = o.conv;
        vote = o.vote;
        let createdTime = vote.created;
        setTimeout(function() {
          updateConversationModifiedTime(req.p.zid, createdTime);
          updateLastInteractionTimeForConversation(zid, uid);

          // NOTE: may be greater than number of comments, if they change votes
          updateVoteCount(req.p.zid, pid);
        }, 100);
        if (_.isUndefined(req.p.starred)) {
          return;
        } else {
          return addStar(req.p.zid, req.p.tid, pid, req.p.starred, createdTime);
        }
      }).then(function() {
        return getNextComment(req.p.zid, pid, [], true);
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
    });
  }



  function handle_POST_ptptCommentMod(req, res) {
    let zid = req.p.zid;
    let pid = req.p.pid;

    let uid = req.p.uid;

    // need('as_important', getBool, assignToP, false),
    // need('as_spam', getBool, assignToP, false),
    // need('as_offtopic', getBool, assignToP, false),



    return pgQueryP("insert into crowd_mod (" +
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
        return getNextComment(req.p.zid, pid, [], true);
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

    pgQueryP("select * from upvotes where uid = ($1) and zid = ($2);", [uid, zid]).then(function(rows) {
      if (rows && rows.length) {
        fail(res, 403, "polis_err_upvote_already_upvoted");
      } else {
        pgQueryP("insert into upvotes (uid, zid) VALUES ($1, $2);", [uid, zid]).then(function() {
          pgQueryP("update conversations set upvotes = (select count(*) from upvotes where zid = ($1)) where zid = ($1);", [zid]).then(function() {
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
    return pgQueryP(query, params);
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
    pgQuery(query, params, function(err, result) {
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

    isModerator(zid, uid).then(function(isModerator) {
      if (isModerator) {
        moderateComment(zid, tid, active, mod).then(function() {
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
        pgQuery("update zinvites set zinvite = ($1) where zid = ($2);", [zinvite, zid], function(err, results) {
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
    let goodLtiUserIdsPromise = pgQueryP(
      "select lti_user_id from " +
      "(select distinct uid from " +
      "(select distinct pid from votes where zid = ($1) UNION " +
      "select distinct pid from comments where zid = ($1)) as x " +
      "inner join participants p on x.pid = p.pid where p.zid = ($1)) as good_uids " +
      "inner join lti_users on good_uids.uid = lti_users.uid;", [zid]);

    let callbackInfoPromise = pgQueryP(
      "select * from canvas_assignment_conversation_info ai " +
      "inner join canvas_assignment_callback_info ci " +
      "on ai.custom_canvas_assignment_id = ci.custom_canvas_assignment_id " +
      "where ai.zid = ($1);", [zid]);

    let ownerLtiCredsPromise = pgQueryP(
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
      return pgQueryP("update canvas_assignment_callback_info set grade_assigned = ($1) where tool_consumer_instance_guid = ($2) and lti_context_id = ($3) and lti_user_id = ($4) and custom_canvas_assignment_id = ($5);", [
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

    pgQueryP("select * from conversations where zid = ($1) and owner = ($2);", [req.p.zid, req.p.uid]).then(function(rows) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      let conv = rows[0];
      // if (conv.is_active) {
      // regardless of old state, go ahead and close it, and update grades. will make testing easier.
      pgQueryP("update conversations set is_active = false where zid = ($1);", [conv.zid]).then(function() {

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

    pgQueryP("select * from conversations where zid = ($1) and owner = ($2);", [req.p.zid, req.p.uid]).then(function(rows) {
      if (!rows || !rows.length) {
        fail(res, 500, "polis_err_closing_conversation_no_such_conversation");
        return;
      }
      let conv = rows[0];
      pgQueryP("update conversations set is_active = true where zid = ($1);", [conv.zid]).then(function() {
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


      let q = sql_conversations.update(
          fields
        )
        .where(
          sql_conversations.zid.equals(req.p.zid)
        )
        // .and( sql_conversations.owner.equals(req.p.uid) )
        .returning('*');
      verifyMetaPromise.then(function() {
        pgQuery(
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
    pgQuery("SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);", [pmaid], function(err, result) {
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
    pgQuery("SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);", [pmqid], function(err, result) {
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
    // pgQuery("update participant_metadata_choices set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
    //     if (err) {callback(34534545); return;}
    pgQuery("update participant_metadata_answers set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
      if (err) {
        callback(err);
        return;
      }
      callback(null);
    });
    // });
  }

  function deleteMetadataQuestionAndAnswers(pmqid, callback) {
    // pgQuery("update participant_metadata_choices set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
    //     if (err) {callback(93847834); return;}
    pgQuery("update participant_metadata_answers set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
      if (err) {
        callback(err);
        return;
      }
      pgQuery("update participant_metadata_questions set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
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
      pgQuery("INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;", [
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
      pgQuery("INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;", [pmqid, zid, value], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
          pgQuery("UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;", [pmqid, zid, value], function(err, results) {
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

  function getOneConversation(zid, uid) {
    return Promise.all([
      pgQueryP_readOnly("select * from conversations left join  (select uid, site_id from users) as u on conversations.owner = u.uid where conversations.zid = ($1);", [zid]),
      getConversationHasMetadata(zid),
      (_.isUndefined(uid) ? Promise.resolve({}) : getUserInfoForUid2(uid)),
    ]).then(function(results) {
      let conv = results[0] && results[0][0];
      let convHasMetadata = results[1];
      let requestingUserInfo = results[2];

      conv.auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(conv.auth_opt_allow_3rdparty, true);
      conv.auth_opt_fb_computed = conv.auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_fb, true);
      conv.auth_opt_tw_computed = conv.auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_tw, true);

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
          let upvotesPromise = (uid && want_upvoted) ? pgQueryP_readOnly("select zid from upvotes where uid = ($1);", [uid]) : Promise.resolve();

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

  function handle_GET_conversations(req, res) {
    let courseIdPromise = Promise.resolve();
    if (req.p.course_invite) {
      courseIdPromise = pgQueryP_readOnly("select course_id from courses where course_invite = ($1);", [req.p.course_invite]).then(function(rows) {
        return rows[0].course_id;
      });
    }
    courseIdPromise.then(function(course_id) {
      if (course_id) {
        req.p.course_id = course_id;
      }
      if (req.p.zid) {
        getOneConversation(req.p.zid, req.p.uid).then(function(data) {
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
    pgQueryP_readOnly("select name from contexts where is_public = TRUE order by name;", []).then(function(contexts) {
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
      return pgQueryP("insert into contexts (name, creator, is_public) values ($1, $2, $3);", [name, uid, true]).then(function() {
        res.status(200).json({});
      }, function(err) {
        fail(res, 500, "polis_err_post_contexts_query", err);
      }).catch(function(err) {
        fail(res, 500, "polis_err_post_contexts_misc", err);
      });
    }
    pgQueryP("select name from contexts where name = ($1);", [name]).then(function(rows) {
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
    // pgQuery("select is_owner from users where uid = ($1);", [uid], function(err, results) {
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
        owner: req.p.uid,
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

      pgQuery(q, [], function(err, result) {
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

  function handle_POST_sendEmailExportReady(req, res) {

    if (req.p.webserver_pass !== process.env.WEBSERVER_PASS || req.p.webserver_username !== process.env.WEBSERVER_USERNAME) {      
      return fail(res, 403, "polis_err_sending_export_link_to_email_auth");
    }

    const email = req.p.email;
    const subject = "Data export for pol.is conversation pol.is/" + req.p.conversation_id;
    const fromAddress = `Polis Team <${process.env.EMAIL_CHRIS}>`;
    const body = `Greetings

You created a data export for pol.is conversation pol.is/${req.p.conversation_id} that has just completed. You can download the results for this conversation at the following url:

https://pol.is/api/v3/dataExport/results?filename=${req.p.filename}&conversation_id=${req.p.conversation_id}

Please let us know if you have any questons about the data.

Thanks for using pol.is!
`;

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
    return pgQueryP_readOnly("select uid, twitter_user_id from twitter_users where modified < (now_as_millis() - 30*60*1000) order by modified desc limit 100;").then(function(results) {
      let twitter_user_ids = _.pluck(results, "twitter_user_id");
      if (results.length === 0) {
        return [];
      }
      twitter_user_ids = _.difference(twitter_user_ids, suspendedOrPotentiallyProblematicTwitterIds);
      if (twitter_user_ids.length === 0) {
        return [];
      }

      getTwitterUserInfoBulk(twitter_user_ids).then(function(info) {
        console.dir(info);

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

          console.log(q);
          return pgQueryP(q, [
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

        return pgQueryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, u.name]).then(function() {
          return twitterUserDbRecord;
        });
      });
    });
  }


  function prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid) {
    let query = pgQueryP("select * from twitter_users where screen_name = ($1);", [quote_twitter_screen_name]);
    return addParticipantByTwitterUserId(query, {
      twitter_screen_name: quote_twitter_screen_name,
    }, zid, null);
  }

  function prepForTwitterComment(twitter_tweet_id, zid) {
    return getTwitterTweetById(twitter_tweet_id).then(function(tweet) {
      let user = tweet.user;
      let twitter_user_id = user.id_str;
      let query = pgQueryP("select * from twitter_users where twitter_user_id = ($1);", [twitter_user_id]);
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
    return pgQueryP("INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;", [zid, uid]);
  }


  function getAndInsertTwitterUser(o, uid) {
    return getTwitterUserInfo(o, false).then(function(u) {
      u = JSON.parse(u)[0];
      winston.log("info", "TWITTER USER INFO");
      winston.log("info", u);
      winston.log("info", "/TWITTER USER INFO");
      return pgQueryP("insert into twitter_users (" +
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



    function maybeAddToIntercom(o) {
      let shouldAddToIntercom = req.p.owner;
      if (shouldAddToIntercom) {
        let params = {
          "email": o.email,
          "name": o.name,
          "user_id": o.uid,
        };
        let customData = {};
        // if (referrer) {
        //     customData.referrer = o.referrer;
        // }
        // if (organization) {
        //     customData.org = organization;
        // }
        // customData.fb = true; // mark this user as a facebook auth user
        customData.tw = true; // mark this user as a twitter auth user
        customData.twitterScreenName = o.screen_name;
        customData.uid = o.uid;
        if (_.keys(customData).length) {
          params.custom_data = customData;
        }
        intercom.createUser(params, function(err, res) {
          if (err) {
            winston.log("info", err);
            console.error("polis_err_intercom_create_user_tw_fail");
            winston.log("info", params);
            yell("polis_err_intercom_create_user_tw_fail");
            return;
          }
        });
      }
    }



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
        if (k === "user_id") {
          v = parseInt(v);
        }
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
        return pgQueryP("insert into twitter_users (" +
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
            pgQueryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, u.name]).then(function() {
              // OK, ready
              maybeAddToIntercom(u);
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
                pgQueryP("select * from twitter_users where uid = ($1);", [uid]),
                pgQueryP("select * from twitter_users where twitter_user_id = ($1);", [u.id]),
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
    return pgQueryP_readOnly("select * from twitter_users where uid in ($1);", uids);
  }

  function getFacebookInfo(uids) {
    return pgQueryP_readOnly("select * from facebook_users where uid in ($1);", uids);
  }

  function getSocialParticipantsForMod(zid, limit, mod) {

    let modClause = "";
    let params = [zid, limit];
    if (!_.isUndefined(mod)) {
      modClause = " and mod = ($3)";
      params.push(mod);
    }

    let q = "with " +
      "p as (select uid, pid, mod from participants where zid = ($1) " + modClause + "), " + // and vote_count >= 1

      "final_set as (select * from p limit ($2)), " +

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
      "final_set.pid " +
      "from final_set " +
      "left join twitter_users on final_set.uid = twitter_users.uid " +
      "left join facebook_users on final_set.uid = facebook_users.uid " +
      ") " +
      "select * from all_rows where (tw__twitter_user_id is not null) or (fb__fb_user_id is not null) " +
      // "select * from all_rows " +
      ";";
    return pgQueryP(q, params);
  }

  let socialParticipantsCache = new LruCache({
    maxAge: 1000 * 30, // 30 seconds
    max: 999,
  });

  function getSocialParticipants(zid, uid, limit, mod, lastVoteTimestamp, authorUids) {
    // NOTE ignoring authorUids as part of cacheKey for now, just because.
    let cacheKey = [zid, limit, mod, lastVoteTimestamp].join("_");
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
      "twitter_ptpts as (select p.uid, 10 as priority from p inner join twitter_users on twitter_users.uid  = p.uid where p.mod >= ($4)), " +
      "all_fb_users as (select p.uid, 9 as priority from p inner join facebook_users on facebook_users.uid = p.uid where p.mod >= ($4)), " +
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
      // "final_set.uid " +
      "p.pid " +
      "from final_set " +
      "left join twitter_users on final_set.uid = twitter_users.uid " +
      "left join facebook_users on final_set.uid = facebook_users.uid " +
      "left join p on final_set.uid = p.uid " +
      // "left join all_fb_usersriends on all_friends.uid = p.uid " +
      ";";

    return pgQueryP_metered_readOnly("getSocialParticipants", q, [zid, uid, limit, mod]).then(function(response) {
      socialParticipantsCache.set(cacheKey, response);
      return response;
    });
  }

  // function getFacebookFriendsInConversation(zid, uid) {
  //   if (!uid) {
  //     return Promise.resolve([]);
  //   }
  //   let p = pgQueryP_readOnly(
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
  //   let p = pgQueryP_readOnly("select * from facebook_users inner join (select * from participants where zid = ($1) and vote_count > 0) as p on facebook_users.uid = p.uid;", [zid]);
  //   return p;
  // }

  function getSocialInfoForUsers(uids) {
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
    return pgQueryP_metered_readOnly("getSocialInfoForUsers", "with fb as (select * from facebook_users where uid in (" + uidString + ")), tw as (select * from twitter_users where uid in (" + uidString + ")) select *, coalesce(fb.uid, tw.uid) as uid from fb full outer join tw on tw.uid = fb.uid;", []);
  }

  function updateVoteCount(zid, pid) {
    // return pgQueryP("update participants set vote_count = vote_count + 1 where zid = ($1) and pid = ($2);",[zid, pid]);
    return pgQueryP("update participants set vote_count = (select count(*) from votes where zid = ($1) and pid = ($2)) where zid = ($1) and pid = ($2)", [zid, pid]);
  }


  // zid_pid => "lastVoteTimestamp:ppaddddaadadaduuuuuuuuuuuuuuuuu"; // not using objects to save some ram
  // TODO consider "p2a24a2dadadu15" format
  let votesForZidPidCache = new LruCache({
    max: 5000,
  });


  function getVotesForZidPidWithTimestampCheck(zid, pid, lastVoteTimestamp) {
    let key = zid + "_" + pid;
    let cachedVotes = votesForZidPidCache.get(key);
    if (cachedVotes) {
      let pair = cachedVotes.split(":");
      let cachedTime = Number(pair[0]);
      let votes = pair[1];
      if (cachedTime >= lastVoteTimestamp) {
        return votes;
      }
    }
    return null;
  }


  function cacheVotesForZidPidWithTimestamp(zid, pid, lastVoteTimestamp, votes) {
    let key = zid + "_" + pid;
    let val = lastVoteTimestamp + ":" + votes;
    votesForZidPidCache.set(key, val);
  }


  // returns {pid -> "adadddadpupuuuuuuuu"}
  function getVotesForZidPidsWithTimestampCheck(zid, pids, lastVoteTimestamp) {
    let cachedVotes = pids.map(function(pid) {
      return {
        pid: pid,
        votes: getVotesForZidPidWithTimestampCheck(zid, pid, lastVoteTimestamp),
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
        cacheVotesForZidPidWithTimestamp(zid, pid, lastVoteTimestamp, votes);
      });
      let cachedPidToVotes = toObj(cachedVotes);
      return Object.assign(newPidToVotes, cachedPidToVotes);
    });
  }


  function getVotesForPids(zid, pids) {
    if (pids.length === 0) {
      return Promise.resolve([]);
    }
    return pgQueryP_readOnly("select * from votes where zid = ($1) and pid in (" + pids.join(",") + ") order by pid, tid, created;", [zid]).then(function(votesRows) {
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
    return pgQueryP_readOnly("select * from participant_locations where zid = ($1);", [zid]);
  }

  function getPidsForGid(zid, gid, lastVoteTimestamp) {
    return Promise.all([
      getClusters(zid, lastVoteTimestamp),
      getBidToPidMapping(zid, lastVoteTimestamp),
    ]).then(function(o) {
      let clusters = o[0];
      let bidToPids = o[1].bidToPid;
      let cluster = clusters[gid];
      if (!cluster) {
        return [];
      }
      let members = cluster.members;
      let pids = [];
      for (var i = 0; i < members.length; i++) {
        let bid = members[i];
        let morePids = bidToPids[bid];
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
    return pgQueryP("select * from geolocation_cache where location = ($1);", [locationString]).then(function(rows) {
      if (!rows || !rows.length) {
        return geoCodeWithGoogleApi(locationString).then(function(result) {
          winston.log("info", result);
          let lat = result.geometry.location.lat;
          let lng = result.geometry.location.lng;
          // NOTE: not waiting for the response to this - it might fail in the case of a race-condition, since we don't have upsert
          pgQueryP("insert into geolocation_cache (location,lat,lng,response) values ($1,$2,$3,$4);", [
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
      return pgQueryP("update participants set mod = ($3) where zid = ($1) and pid = ($2);", [zid, pid, mod]).then(function() {
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

    Promise.all([
      getSocialParticipantsForMod(zid, limit, mod),
      getConversationInfo(zid),
    ]).then(function(a) {
      let ptptois = a[0];
      let conv = a[1];
      let isOwner = uid === conv.owner;
      let isAllowed = isOwner || isPolisDev(req.p.uid) || conv.is_data_open;
      if (isAllowed) {
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
    let lastVoteTimestamp = o.lastVoteTimestamp;

    // NOTE: if this API is running slow, it's probably because fetching the PCA from mongo is slow, and PCA caching is disabled

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
          "u as (select distinct(uid) from comments where zid = ($1) and tid in (" + featuredTids.join(",") + ") order by uid) " +
          "select u.uid from u inner join facebook_users on facebook_users.uid = u.uid " +
          "union " +
          "select u.uid from u inner join twitter_users on twitter_users.uid = u.uid " +
          "order by uid;";

        return pgQueryP_readOnly(q, [zid]).then(function(comments) {
          let uids = _.pluck(comments, "uid");
          uids = _.uniq(uids);
          return uids;
        });
      });
    }


    return getAuthorUidsOfFeaturedComments().then(function(authorUids) {

      return Promise.all([
        getSocialParticipants(zid, uid, hardLimit, mod, lastVoteTimestamp, authorUids),
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
          let x = pullFbTwIntoSubObjects(p);
          // nest the fb and tw properties in sub objects

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

        let pidToData = _.indexBy(participantsWithSocialInfo, "pid"); // TODO this is extra work, probably not needed after some rethinking

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


        return getVotesForZidPidsWithTimestampCheck(zid, pids, lastVoteTimestamp).then(function(vectors) {

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
                delete pidToData[pid]; // if the participant isn't in a bucket, they probably haven't voted enough for the math worker to bucketize them.
              } else if (!!pidToData[pid]) {
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
      p = pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [uid]);
    } else if (req.p.twitter_user_id) {
      p = pgQueryP_readOnly("select * from twitter_users where twitter_user_id = ($1);", [req.p.twitter_user_id]);
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
      return pgQueryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function(rows) {
        return sendEinviteEmail(req, email, einvite);
      });
    });
  }

  function doSendVerification(req, email) {
    return generateTokenP(30, false).then(function(einvite) {
      return pgQueryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function(rows) {
        return sendVerificaionEmail(req, email, einvite);
      });
    });
  }


/*

CREATE TABLE slack_users (
    uid INTEGER NOT NULL REFERENCES users(uid),
    slack_team VARCHAR(20) NOT NULL,
    slack_user_id VARCHAR(20) NOT NULL,
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE(slack_team, slack_user_id)
);
CREATE TABLE slack_user_invites (
    slack_team VARCHAR(20) NOT NULL,
    slack_user_id VARCHAR(20) NOT NULL,
    token VARCHAR(100) NOT NULL,
    created BIGINT DEFAULT now_as_millis()
);
*/



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

    pgQueryP("select * from slack_user_invites where token = ($1);", [
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
      pgQueryP("select * from slack_users where slack_team = ($1) and slack_user_id = ($2);", [
        slack_team,
        slack_user_id,
      ]).then((rows) => {
        
        if (!rows || !rows.length) {
          // create new user (or use existing user) and associate a new slack_user entry
          const uidPromise = existing_uid_for_client ? Promise.resolve(existing_uid_for_client) : createDummyUser();
          uidPromise.then((uid) => {
            return pgQueryP("insert into slack_users (uid, slack_team, slack_user_id) values ($1, $2, $3);", [
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
      pgQueryP("insert into slack_user_invites (slack_team, slack_user_id, token) values ($1, $2, $3);", [
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
    pgQueryP("select * from einvites where einvite = ($1);", [einvite]).then(function(rows) {
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

    pgQueryP("insert into contributor_agreement_signatures (uid, agreement_version, github_id, name, email, company_name) " +
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
      return pgQueryP(
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
      return pgQueryP(
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
  /*
2014-09-21T23:16:15.351247+00:00 app[web.1]: course_setup
2014-09-21T23:16:15.188414+00:00 app[web.1]: { oauth_consumer_key: 'asdfasdf',
2014-09-21T23:16:15.188418+00:00 app[web.1]:   oauth_signature_method: 'HMAC-SHA1',
2014-09-21T23:16:15.188420+00:00 app[web.1]:   oauth_timestamp: '1411341372',
2014-09-21T23:16:15.188422+00:00 app[web.1]:   oauth_nonce: 'JHnE7tcVBHYx9MjLcQS2jWNTGCD56F5wqwePk4tnk',
2014-09-21T23:16:15.188423+00:00 app[web.1]:   oauth_version: '1.0',
2014-09-21T23:16:15.188425+00:00 app[web.1]:   context_id: '543f4cb8ba0ad2939faa5b2643cb1415d3ada3c5',
2014-09-21T23:16:15.188426+00:00 app[web.1]:   context_label: 'polis_demo_course_code',
2014-09-21T23:16:15.188428+00:00 app[web.1]:   context_title: 'polis demo course',
2014-09-21T23:16:15.188430+00:00 app[web.1]:   custom_canvas_enrollment_state: 'active',
2014-09-21T23:16:15.188432+00:00 app[web.1]:   custom_canvas_xapi_url: 'https://canvas.instructure.com/api/lti/v1/tools/46849/xapi',
2014-09-21T23:16:15.188433+00:00 app[web.1]:   launch_presentation_document_target: 'iframe',
2014-09-21T23:16:15.188435+00:00 app[web.1]:   launch_presentation_height: '400',
2014-09-21T23:16:15.188436+00:00 app[web.1]:   launch_presentation_locale: 'en',
2014-09-21T23:16:15.188437+00:00 app[web.1]:   launch_presentation_return_url: 'https://canvas.instructure.com/courses/875179',
2014-09-21T23:16:15.188439+00:00 app[web.1]:   launch_presentation_width: '800',
2014-09-21T23:16:15.188441+00:00 app[web.1]:   lti_message_type: 'basic-lti-launch-request',
2014-09-21T23:16:15.188442+00:00 app[web.1]:   lti_version: 'LTI-1p0',
2014-09-21T23:16:15.188443+00:00 app[web.1]:   oauth_callback: 'about:blank',
2014-09-21T23:16:15.188445+00:00 app[web.1]:   resource_link_id: '543f4cb8ba0ad2939faa5b2643cb1415d3ada3c5',
2014-09-21T23:16:15.188447+00:00 app[web.1]:   resource_link_title: 'polis nav',
2014-09-21T23:16:15.188448+00:00 app[web.1]:   roles: 'Instructor',
2014-09-21T23:16:15.188450+00:00 app[web.1]:   tool_consumer_info_product_family_code: 'canvas',
2014-09-21T23:16:15.188451+00:00 app[web.1]:   tool_consumer_info_version: 'cloud',
2014-09-21T23:16:15.188453+00:00 app[web.1]:   tool_consumer_instance_contact_email: 'notifications@instructure.com',
2014-09-21T23:16:15.188454+00:00 app[web.1]:   tool_consumer_instance_guid: '07adb3e60637ff02d9ea11c7c74f1ca921699bd7.canvas.instructure.com',
2014-09-21T23:16:15.188456+00:00 app[web.1]:   tool_consumer_instance_name: 'Free For Teachers',
2014-09-21T23:16:15.188457+00:00 app[web.1]:   user_id: '15bbe33bd1cf5355011a9ce6ebe1072256beea01',
2014-09-21T23:16:15.188459+00:00 app[web.1]:   user_image: 'https://secure.gravatar.com/avatar/256caee7b9886c54155ef0d316dffabc?s=50&d=https%3A%2F%2Fcanvas.instructure.com%2Fimages%2Fmessages%2Favatar-50.png',
2014-09-21T23:16:15.188461+00:00 app[web.1]:   oauth_signature: 'jJ3TbKvalDUYvELXNvnzOfdCwGo=' }
*/
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

    let dataSavedPromise = pgQueryP("insert into lti_single_assignment_callback_info (lti_user_id, lti_context_id, lis_outcome_service_url, stringified_json_of_post_content) values ($1, $2, $3, $4);", [
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
        pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_user_id = ($1);", [user_id]).then(function(rows) {

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
  //     pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {


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
        return pgQueryP("insert into canvas_assignment_conversation_info (zid, tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id) values ($1, $2, $3, $4);", [
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
    return pgQueryP("select * from canvas_assignment_conversation_info where tool_consumer_instance_guid = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3);", [
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
        return pgQueryP("update canvas_assignment_callback_info set lis_outcome_service_url = ($5), lis_result_sourcedid = ($6), stringified_json_of_post_content = ($7) where lti_user_id = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3) and tool_consumer_instance_guid = ($4);", [
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
        return pgQueryP("insert into canvas_assignment_callback_info (lti_user_id, lti_context_id, custom_canvas_assignment_id, tool_consumer_instance_guid, lis_outcome_service_url, lis_result_sourcedid, stringified_json_of_post_content) values ($1, $2, $3, $4, $5, $6, $7);", [
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
    return pgQueryP("select * from canvas_assignment_callback_info where lti_user_id = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3) and tool_consumer_instance_guid = ($4);", [
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
      return pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {
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

    // pgQueryP("insert into lti_single_assignment_callback_info (lti_user_id, lti_context_id, lis_outcome_service_url, lis_result_sourcedid, custom_canvas_assignment_id, tool_consumer_instance_guid, stringified_json_of_post_content) values ($1, $2, $3, $4, $5, $6, $7);", [
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
    // pgQueryP("insert into canvas_assignment_conversation_info (

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
  //         pgQuery(query, [], function(err, results) {
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
    return pgQueryP("insert into inviters (inviter_uid, invited_email) VALUES ($1, $2);", [inviter_uid, invited_email]);
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
        pgQuery(query, [], function(err, results) {
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
    return pgQueryP_readOnly("select uid from users where site_id = ($1) and site_owner = TRUE;", [site_id]).then(function(rows) {
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

          pgQuery(q, [], function(err, result) {
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
      "We recommend you add 2-3 short comments to start things off. These comments should be easy to agree or disagree with. Here are some examples:\n \"I think the proposal is good\"\n \"This topic matters a lot\"\n or \"The bike shed should have a metal roof\"\n\n" +
      "You can add comments here:\n" +
      seedUrl + "\n" +
      "\n" +
      "Feel free to reply to this email if you have questions." +
      "\n" +
      "\n" +
      "Additional info: \n" +
      "site_id: \"" + site_id + "\"\n" +
      "page_id: \"" + page_id + "\"\n" +
      "\n";

    return pgQueryP("select email from users where site_id = ($1)", [site_id]).then(function(rows) {

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
    return pgQueryP("insert into page_ids (site_id, page_id, zid) values ($1, $2, $3);", [
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

    let ucv = req.p.ucv;
    let ucw = req.p.ucw;
    let ucst = req.p.ucst;
    let ucsd = req.p.ucsd;
    let ucsv = req.p.ucsv;
    let ucsf = req.p.ucsf;
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
      return url;
    }

    // also parse out the page_id after the '/', and look that up, along with site_id in the page_ids table
    pgQueryP_readOnly("select * from page_ids where site_id = ($1) and page_id = ($2);", [site_id, page_id]).then(function(rows) {
      if (!rows || !rows.length) {
        // conv not initialized yet
        initializeImplicitConversation(site_id, page_id, o).then(function(conv) {
          let url = buildConversationUrl(req, conv.zinvite);
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
    let hostname = buildStaticHostname(req, res);
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


    let port = process.env.STATIC_FILES_PORT;
    // set the host header too, since S3 will look at that (or the routing proxy will patch up the request.. not sure which)
    req.headers.host = hostname;
    routingProxy.proxyRequest(req, res, {

      host: hostname,
      port: port,
    });
    // }
  }

  function buildStaticHostname(req, res) {
    if (devMode) {
      return process.env.STATIC_FILES_HOST;
    } else {
      let origin = req.headers.host;
      if (!whitelistedBuckets[origin]) {
        console.error("got request with host that's not whitelisted: (" + req.headers.host + ")");
        return;
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
      if (devMode) {
        url = "http://" + hostname + ":" + port + path;
      } else {
        // pol.is.s3-website-us-east-1.amazonaws.com
        // preprod.pol.is.s3-website-us-east-1.amazonaws.com

        // TODO https - buckets would need to be renamed to have dashes instead of dots.
        // http://stackoverflow.com/questions/3048236/amazon-s3-https-ssl-is-it-possible
        url = "http://" + hostname + path;
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

  function fetchIndex(req, res, preloadData, port) {
    let headers = {
      'Content-Type': "text/html",
    };
    if (!devMode) {
      Object.assign(headers, {
        'Cache-Control': 'no-transform,public,max-age=60,s-maxage=60', // Cloudflare will probably cache it for one or two hours
      });
    }
    let doFetch = makeFileFetcher(hostname, port, "/index.html", headers, preloadData);
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

  function fetchIndexForConversation(req, res) {
    console.log("fetchIndexForConversation", req.path);
    let match = req.path.match(/[0-9][0-9A-Za-z]+/);
    let conversation_id;
    if (match && match.length) {
      conversation_id = match[0];
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
      fetchIndex(req, res, preloadData, portForParticipationFiles);
    }).catch(function(err) {
      fail(res, 500, "polis_err_fetching_conversation_info2", err);
    });
  }


  let fetchIndexForAdminPage = makeFileFetcher(hostname, portForAdminFiles, "/index_admin.html", {
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



  function makeReactClientProxy(hostname, port) {
    return function(req, res) {
      let temp = req.path.split("/");
      temp.shift();
      temp.shift();
      let path = "/" + temp.join("/");
      let url;
      if (devMode) {
        url = "http://" + hostname + ":" + port + path;
      } else {
        fail(res, 404, "polis_err_finding_file " + path);
        return;
      }
      console.log("ORIG", req.path);
      console.log("URL", url);
      let x = request(url);
      req.pipe(x);
      x.pipe(res);
      x.on("error", function(err) {
        fail(res, 500, "polis_err_finding_file " + path, err);
      });
    };
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
        let url = getServerNameWithProtocol(req) + "/gov";
        res.redirect(url);
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
    getStringLimitLength,
    getUrlLimitLength,
    haltOnTimeout,
    HMAC_SIGNATURE_PARAM_NAME,
    hostname,
    makeFileFetcher,
    makeReactClientProxy,
    makeRedirectorTo,
    moveToBody,
    need,
    pgQueryP,
    pgQueryP_metered,
    pgQueryP_metered_readOnly,
    pgQueryP_readOnly,
    pgQueryP_readOnly_wRetryIfEmpty,
    pidCache,
    portForAdminFiles,
    portForParticipationFiles,
    proxy,
    redirectIfApiDomain,
    redirectIfHasZidButNoConversationId,
    redirectIfNotHttps,
    redirectIfWrongDomain,
    resolve_pidThing,
    sendTextEmail,
    timeout,
    want,
    wantCookie,
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
    handle_GET_comments,
    handle_GET_conditionalIndexFetcher,
    handle_GET_contexts,
    handle_GET_conversation_assigmnent_xml,
    handle_GET_conversationPreloadInfo,
    handle_GET_conversations,
    handle_GET_conversationsRecentActivity,
    handle_GET_conversationsRecentlyStarted,
    handle_GET_conversationStats,
    handle_GET_dataExport,
    handle_GET_dataExport_results,
    handle_GET_domainWhitelist,
    handle_GET_dummyButton,
    handle_GET_einvites,
    handle_GET_facebook_delete,
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
    handle_GET_pcaPlaybackByLastVoteTimestamp,
    handle_GET_pcaPlaybackList,
    handle_GET_perfStats,
    handle_GET_ptptois,
    handle_GET_setup_assignment_xml,
    handle_GET_slack_login,
    handle_GET_snapshot,
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
  };

} // End of initializePolisHelpers

module.exports = {
  initializePolisHelpers,
};
