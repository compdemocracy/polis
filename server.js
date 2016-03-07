(function() {
    "use strict";


/*
spinning up a replica:

heroku addons:create --app=polisapp heroku-postgresql:standard-0 --follow HEROKU_POSTGRESQL_BLUE


*/


/*
    DNS notes:

    Mailgun verification:
     mx._domainkey.polis.io
     polis.io TXT record v=spf1 include:mailgun.org ~all

    Mailgun open/click tracking
     CNAME email.polis.io => mailgun.org

*/

//require('nodefly').profile(
    //process.env.NODEFLY_APPLICATION_KEY,
    //[process.env.APPLICATION_NAME,'Heroku']
//);

var akismetLib = require('akismet'),
    badwords = require('badwords/object'),
    Promise = require('bluebird'),
    dgram = require('dgram'),
    http = require('http'),
    httpProxy = require('http-proxy'),
    https = require('https'),
    // Promise = require('es6-promise').Promise,
    express = require('express'),
    app = express(),
    sql = require("sql"), // see here for useful syntax: https://github.com/brianc/node-sql/blob/bbd6ed15a02d4ab8fbc5058ee2aff1ad67acd5dc/lib/node/valueExpression.js
    escapeLiteral = require('pg').Client.prototype.escapeLiteral,
    pg = require('pg').native, //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    parsePgConnectionString = require('pg-connection-string').parse,
    mongo = require('mongodb'),
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    bcrypt = require('bcrypt'),
    crypto = require('crypto'),
    Intercom = require('intercom.io'), // https://github.com/tarunc/intercom.io
    p3p = require('p3p'),
    OAuth = require('oauth'),
    Pushover = require( 'pushover-notifications' ),
    pushoverInstance = new Pushover( {
        user: process.env.PUSHOVER_GROUP_POLIS_DEV,
        token: process.env.PUSHOVER_POLIS_PROXY_API_KEY,
    }),
    // sendgrid = require('sendgrid')(
    //   process.env['SENDGRID_USERNAME'],
    //   process.env['SENDGRID_PASSWORD'],
    //   {api: 'smtp'}
    // ),
    Mailgun = require('mailgun').Mailgun,
    mailgun = new Mailgun(process.env.MAILGUN_API_KEY),
    postmark = require("postmark")(process.env.POSTMARK_API_KEY),
    querystring = require('querystring'),
    devMode = "localhost" === process.env.STATIC_FILES_HOST,
    replaceStream = require('replacestream'),
    responseTime = require('response-time'),
    request = require('request-promise'), // includes Request, but adds promise methods
    LruCache = require("lru-cache"),
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY),
    timeout = require('connect-timeout'),
    zlib = require('zlib'),
    _ = require('underscore');
    // winston = require("winston");

var winston = console;



if (devMode) {
    Promise.longStackTraces();
}

// Bluebird uncaught error handler.
Promise.onPossiblyUnhandledRejection(function(err){
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


var polisDevs = [
    // Mike
    125, // m@bjorkegren.com
    26347, // mike@pol.is
    91268, // michael@bjorkegren.com -- facebook and twiter attached

    // Colin
    186, // colinmegill@gmail.com

    // Chris
    302, //  metasoarous@gmail.com
    36140, // chris@pol.is
];

function isPolisDev(uid) {
    return polisDevs.indexOf(uid) >= 0;
}

// so we can grant extra days to users
// eventually we should probably move this to db.
// for now, use git blame to see when these were added
var usersToAdditionalTrialDays = {
    50756: 14, // julien
    85423: 100, // mike test
};

// log heap stats
setInterval(function() {
    var mem = process.memoryUsage();
    var heapUsed = mem.heapUsed;
    var rss = mem.rss;
    var heapTotal = mem.heapTotal;
    winston.log("info","heapUsed:", heapUsed, "heapTotal:", heapTotal, "rss:", rss);
    // var start = Date.now();

    //metric("api.process.mem.heapUsed", heapUsed, start);
    //metric("api.process.mem.rss", rss, start);
    //metric("api.process.mem.heapTotal", heapTotal, start);
}, 10*1000);


// // BEGIN GITHUB OAUTH2
// var CLIENT_SECRET = "0b178e412a10fa023a0153bf7cefaf6dae0f74b9";
// var CLIENT_ID = "109a1eb4732b3ec1075b";
// var oauth2 = require('simple-oauth2')({
//   clientID: CLIENT_ID,
//   clientSecret: CLIENT_SECRET,
//   site: 'https://github.com/login',
//   tokenPath: '/oauth/access_token'
// });

// winston.log("info",oauth2);

// // Authorization uri definition
// var authorization_uri = oauth2.AuthCode.authorizeURL({
//   redirect_uri: 'https://preprod.pol.is/oauth2/oauth2_github_callback',
//   scope: 'notifications',
//   state: '3(#0/!~'
// });
// // END GITHUB OAUTH2


var POLIS_FROM_ADDRESS = "Polis Team <mike@pol.is>";


var akismet = akismetLib.client({
    blog: 'https://pol.is',  // required: your root level url
    apiKey: process.env.AKISMET_ANTISPAM_API_KEY
});

akismet.verifyKey(function(err, verified) {
  if (verified) {
    winston.log("info",'Akismet: API key successfully verified.');
  } else {
    winston.log("info",'Akismet: Unable to verify API key.');
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

var SELF_HOSTNAME = "localhost:" + process.env.PORT;
// if (!devMode) {
   // ^^^ possible to use localhost on Heroku?
  //  SELF_HOSTNAME = "polisapp.herokuapp.com"
//}



// metric name => {
//    values: [circular buffers of values (holds 1000 items)]
//    index: index in circular buffer
//}
var METRICS_IN_RAM = {};
var SHOULD_ADD_METRICS_IN_RAM = false;
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
    var index = METRICS_IN_RAM[metricName].index;
    METRICS_IN_RAM[metricName].values[index] = val;
    METRICS_IN_RAM[metricName].index = (index + 1) % 1000;
}



// metered promise
function MPromise(name, f) {
    var p = new Promise(f);
    var start = Date.now();
    setTimeout(function() {
        addInRamMetric(name + ".go", 1, start);
    }, 100);
    p.then(function() {
        var end = Date.now();
        var duration = end - start;
        setTimeout(function() {
            addInRamMetric(name + ".ok", duration, end);
        }, 100);
    }, function() {
        var end = Date.now();
        var duration = end - start;
        setTimeout(function() {
            addInRamMetric(name + ".fail", duration, end);
        }, 100);
    }).catch(function(err) {
        var end = Date.now();
        var duration = end - start;
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


app.disable('x-powered-by');
// app.disable('etag'); // seems to be eating CPU, and we're not using etags yet. https://www.dropbox.com/s/hgfd5dm0e29728w/Screenshot%202015-06-01%2023.42.47.png?dl=0


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
    var v = this.f(k);
    this.m[k] = v;
    return v;
};
DD.prototype.s = DA.prototype.s = function(k,v) {
    this.m[k] = v;
};
function emptyArray() {
    return [];
}



var domainOverride = process.env.DOMAIN_OVERRIDE || null;

/*
var metric = (function() {
    var apikey = process.env.HOSTEDGRAPHITE_APIKEY;
    return function(metricName, numberValue, optionalTimestampOverride) {
        return new Promise(function(resolve, reject) {
            var point = {
                dur: numberValue,
                time : new Date(),
            };
            INFO(point);
            metricName = metricName.replace(/[^A-Za-z0-9\.]/g,"");
            INFO(metricName);
            // influx.writePoint(metricName, point, {}, function(err) {
            //     if (err) { reject(err); return; }
            //     resolve();
            // });
            var t = "";
            if (!_.isUndefined(optionalTimestampOverride)) {
                optionalTimestampOverride /= 1000; // graphite wants seconds
                t = " " + optionalTimestampOverride;
            }
            var message = new Buffer(apikey + "." + metricName + " " + numberValue +"\n");
            INFO(message.toString());
            var socket = dgram.createSocket("udp4");
            socket.send(message, 0, message.length, 2003, "carbon.hostedgraphite.com", function(err, bytes) {
                socket.close();
                if (err) {
                    console.error("metric send failed " + err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    };
}());
*/

function haltOnTimeout(req, res, next) {
    if (req.timedout){
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

var errorNotifications = (function() {
    var errors = [];
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
    setInterval(sendAll, 60*1000);
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
var yell = errorNotifications.add;


var intercom = new Intercom({
  apiKey: process.env.INTERCOM_API_KEY,
  appId: "nb5hla8s"
});


//first we define our tables
var sql_conversations = sql.define({
  name: 'conversations',
  columns: [
    "zid",
    "topic",
    "description",
    "participant_count",
    "is_anon",
    "is_active",
    "is_draft",
    "is_public",  // TODO remove this column
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
    ]
});
var sql_votes = sql.define({
  name: 'votes',
  columns: [
    "zid",
    "tid",
    "pid",
    "created",
    "vote",
    ]
});
var sql_comments = sql.define({
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
    ]
});

var sql_participant_metadata_answers = sql.define({
  name: 'participant_metadata_answers',
  columns: [
    "pmaid",
    "pmqid",
    "zid",
    "value",
    "alive",
    ]
});

var sql_participants_extended = sql.define({
  name: 'participants_extended',
  columns: [
    "uid",
    "zid",
    "referrer",
    "parent_url",
    "created",
  ],
});

var sql_courses = sql.define({
  name: 'courses',
  columns: [
    "course_id",
    "course_invite",
    "topic",
    "description",
    "owner",
    "created",
    ]
});
// var sql_otzinvites = sql.define({
//   name: 'otzinvites',
//   columns: [
//     "otzinvite",
//     "zid",
//     "xid",
//     ]
// });


function orderLike(itemsToBeReordered, itemsThatHaveTheRightOrder, fieldName) {
    var i;
    // identity field -> item
    var items = {};
    for (i = 0; i < itemsToBeReordered.length; i++) {
        items[itemsToBeReordered[i][fieldName]] = itemsToBeReordered[i];
    }
    var dest = [];
    for (i = 0; i < itemsThatHaveTheRightOrder.length; i++) {
        dest.push(items[itemsThatHaveTheRightOrder[i][fieldName]]);
    }
    return dest;
}


// // Eventually, the plan is to support a larger number-space by using some lowercase letters.
// // Waiting to implement that since there's cognitive overhead with mapping the IDs to/from
// // letters/numbers.
// // Just using digits [2-9] to start with. Omitting 0 and 1 since they can be confused with
// // letters once we start using letters.
// // This should give us roughly 8^8 = 16777216 conversations before we have to add letters.
// var ReadableIds = (function() {
//     function rand(a) {
//         return _.random(a.length);
//     }
//     // no 1 (looks like l)
//     // no 0 (looks like 0)
//     var numbers8 = "23456789".split("");

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

winston.log("info",process.env.MONGOLAB_URI);

function makeSessionToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 20);
}

// TODO_SECURITY check if this cache is safe to use. (using a closure to keep the )
// But we need to squeeze a bit more out of the db right now,
// and generally remove sources of uncertainty about what makes
// various queries slow. And having every single query talk to PG
// adds a lot of variability across the board.
var userTokenCache = new LruCache({
    max: 9000,
});

function getUserInfoForSessionToken(sessionToken, res, cb) {
    var cachedUid = userTokenCache.get(sessionToken);
    if (cachedUid) {
        cb(null, cachedUid);
        return;
    }
    pgQuery("select uid from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
        if (err) { console.error("token_fetch_error"); cb(500); return; }
        if (!results || !results.rows || !results.rows.length) {
            console.error("token_expired_or_missing");

            cb(403);
            return;
        }
        var uid = results.rows[0].uid;
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
function parsePolisLtiToken(token) {
    var parts = token.split(/:::/);
    var o = {
        // parts[0] === "xPolisLtiToken", don't need that
        tool_consumer_instance_guid: parts[1],
        lti_user_id: parts[2],
    };
    return o;
}


function getUserInfoForPolisLtiToken(token) {
    var o = parsePolisLtiToken(token);
    return pgQueryP("select uid from lti_users where tool_consumer_instance_guid = $1 and lti_user_id = $2", [
        o.tool_consumer_instance_guid,
        o.lti_user_id,
    ]).then(function(rows) {
        return rows[0].uid;
    });
}

function startSession(uid, cb) {
    var token = makeSessionToken();
    //winston.log("info",'startSession: token will be: ' + sessionToken);
    winston.log("info",'startSession');
    pgQuery("insert into auth_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(err, repliesSetToken) {
        if (err) { cb(err); return; }
        winston.log("info",'startSession: token set.');
        cb(null, token);
    });
}

function startSessionP(uid) {
    return new Promise(function(resolve, reject) {
        startSession(uid, function(err, token) {
            if (err) {
                reject(err);
            } else {
                resolve(token);
            }
        });
    });
}

function endSession(sessionToken, cb) {
    pgQuery("delete from auth_tokens where token = ($1);", [sessionToken], function(err, results) {
        if (err) { cb(err); return; }
        cb(null);
    });
}


function setupPwReset(uid, cb) {
    function makePwResetToken() {
        // These can probably be shortened at some point.
        return crypto.randomBytes(140).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 100);
    }
    var token = makePwResetToken();
    pgQuery("insert into pwreset_tokens (uid, token, created) values ($1, $2, default);", [uid, token], function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return; }
        cb(null, token);
    });
}
function getUidForPwResetToken(pwresettoken, cb) {
    // TODO "and created > timestamp - x"
    pgQuery("select uid from pwreset_tokens where token = ($1);", [pwresettoken], function(errGetToken, results) {
        if (errGetToken) { console.error("pwresettoken_fetch_error"); cb(500); return; }
        if (!results || !results.rows || !results.rows.length) {
            console.error("token_expired_or_missing");
            cb(403);
            return;
        }
        cb(null, {uid: results.rows[0].uid});
    });
}
function clearPwResetToken(pwresettoken, cb) {
    pgQuery("delete from pwreset_tokens where token = ($1);", [pwresettoken], function(errDelToken, repliesSetToken) {
        if (errDelToken) { cb(errDelToken); return; }
        cb(null);
    });
}

//var mongoServer = new MongoServer(process.env.MONGOLAB_URI, 37977, {auto_reconnect: true});
//var db = new MongoDb('exampleDb', mongoServer, {safe: true});
function connectToMongo(callback) {
mongo.connect(process.env.MONGOLAB_URI, {
    server: {
        auto_reconnect: true
    },
    db: {
        safe: true
    }
}, function(err, db) {
    if(err) {
        console.error('mongo failed to init');
        console.error(err);
        process.exit(1);
    }

    function mongoCollectionName(basename) {
      var schemaDate = "2014_08_22";
      var envName = process.env.MATH_ENV; // prod, preprod, chris, mike
      var name = ["math", envName, schemaDate, basename].join("_");
      winston.log("info",name);
      return name;
    }

    db.collection(mongoCollectionName('main'), function(err, collectionOfPcaResults) {
    db.collection(mongoCollectionName('bidtopid'), function(err, collectionOfBidToPidResults) {
    db.collection(mongoCollectionName('pcaPlaybackResults'), function(err, collectionOfPcaPlaybackResults) {

        callback(null, {
            mongoCollectionOfPcaResults: collectionOfPcaResults,
            mongoCollectionOfBidToPidResults: collectionOfBidToPidResults,
            mongoCollectionOfPcaPlaybackResults: collectionOfPcaPlaybackResults,
        });
    });
    });
    });
});
}

// Same syntax as pg.client.query, but uses connection pool
// Also takes care of calling 'done'.
function pgQueryImpl() {
    var args = arguments;
    var queryString = args[0];
    var params;
    var callback;
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


var usingReplica = process.env.DATABASE_URL !== process.env[process.env.DATABASE_FOR_READS_NAME];
var prodPoolSize = usingReplica ? 3 : 12; /// 39
var pgPoolLevelRanks=["info", "verbose"];
var pgPoolLoggingLevel = -1;// -1 to get anything more important than info and verbose. // pgPoolLevelRanks.indexOf("info");

var queryReadWriteObj = {
    isReadOnly: false,
    pgConfig: _.extend(parsePgConnectionString(process.env.DATABASE_URL), {
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
var queryReadOnlyObj = {
    isReadOnly: true,
    pgConfig: _.extend(parsePgConnectionString(process.env[process.env.DATABASE_FOR_READS_NAME]), {
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
    var f = this.isReadOnly ? pgQuery_readOnly : pgQuery;
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
    var f = this.isReadOnly ? pgQueryP_readOnly : pgQueryP;
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
    var header=req.headers.authorization || '',        // get the header
        token=header.split(/\s+/).pop() || '',            // and the encoded auth token
        auth=new Buffer(token, 'base64').toString(),    // convert from base64
        parts=auth.split(/:/),                          // split on colon
        username=parts[0],
        password=parts[1], // we don't use the password part, just use "apikey:"
        apikey=username;
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
    var token = req.headers["x-polis"];

    //if (req.body.uid) { next(401); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
    getUserInfoForSessionToken(token, res, function(err, uid) {

        if (err) {
            res.status(403);
            next("polis_err_auth_no_such_token");
            return;
        }
        if ( req.body.uid && req.body.uid !== uid) {
            res.status(401);
            next("polis_err_auth_mismatch_uid");
            return;
        }
        assigner(req, "uid", Number(uid));
        next();
    });
}

function doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, next) {
    var token = req.headers["x-polis"];

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
        _.extend(req.body, req.query);
    }
    if (req.params) {
        req.body = req.body || {};
        _.extend(req.body, req.params);
    }
    // inti req.p if not there already
    req.p = req.p || {};
    next();
}

// function logPath(req, res, next) {
//     winston.log("info",req.method + " " + req.url);
//     next();
// }


String.prototype.hashCode = function(){
    var hash = 0, i, char;
    if (this.length === 0) { return hash; }
    for (i = 0; i < this.length; i++) {
        char = this.charCodeAt(i);
        hash = ((hash<<5)-hash)+char;
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

function getEmail(s) {
    return new Promise(function(resolve, reject) {
        if (typeof s !== "string" || s.length > 999 || -1 === s.indexOf("@")) {
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
            s = s.replace(/^ */,"").replace(/ *$/,"");
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
            s = s.replace(/^ */,"").replace(/ *$/,"");
            resolve(s);
        });
    };
}


function getBool(s) {
    return new Promise(function(resolve, reject) {
        var type = typeof s;
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
        var x = parseInt(s);
        if (isNaN(x)) {
            return reject("polis_fail_parse_int " + s);
        }
        resolve(x);
    });
}


var conversationIdToZidCache = new LruCache({
    max: 1000,
});

// NOTE: currently conversation_id is stored as zinvite
function getZidFromConversationId(conversation_id) {
    return new MPromise("getZidFromConversationId", function(resolve, reject) {
        var cachedZid = conversationIdToZidCache.get(conversation_id);
        if (cachedZid) {
            resolve(cachedZid);
            return;
        }
        pgQuery_readOnly("select zid from zinvites where zinvite = ($1);", [conversation_id], function(err, results) {
            if (err) {
                return reject(err);
            } else if (!results || !results.rows || !results.rows.length) {
                console.error("polis_err_fetching_zid_for_conversation_id" + conversation_id);
                return reject("polis_err_fetching_zid_for_conversation_id");
            } else {
                var zid = results.rows[0].zid;
                conversationIdToZidCache.set(conversation_id, zid);
                return resolve(zid);
            }
        });
    });
}

// conversation_id is the client/ public API facing string ID
var parseConversationId = getStringLimitLength(1, 100);
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
        var x = parseFloat(s);
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
        var s = "clobbering " + name;
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
var prrrams = (function() {
    function buildCallback(config) {
        var name = config.name;
        var parserWhichReturnsPromise = config.parserWhichReturnsPromise;
        var assigner = config.assigner;
        var required = config.required;
        var defaultVal = config.defaultVal;
        var extractor = config.extractor;

        var f = function(req, res, next) {
            var val = extractor(req, name);
            if (!_.isUndefined(val) && !_.isNull(val)) {
                parserWhichReturnsPromise(val).then(function(parsed) {
                    assigner(req, name, parsed);
                    next();
                }, function(e) {
                    var s = "polis_err_param_parse_failed_" + name;
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
                var s = "polis_err_param_missing_" + name;
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
            return buildCallback({name: name, extractor: extractFromBody, parserWhichReturnsPromise: parserWhichReturnsPromise, assigner: assigner, required: true});
        },
        want: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
            return buildCallback({name: name, extractor: extractFromBody, parserWhichReturnsPromise: parserWhichReturnsPromise, assigner: assigner, required: false, defaultVal: defaultVal});
        },
        needCookie: function(name, parserWhichReturnsPromise, assigner) {
            return buildCallback({name: name, extractor: extractFromCookie, parserWhichReturnsPromise: parserWhichReturnsPromise, assigner: assigner, required: true});
        },
        wantCookie: function(name, parserWhichReturnsPromise, assigner, defaultVal) {
            return buildCallback({name: name, extractor: extractFromCookie, parserWhichReturnsPromise: parserWhichReturnsPromise, assigner: assigner, required: false, defaultVal: defaultVal});
        },
    };
}());
var need = prrrams.need;
var want = prrrams.want;
var needCookie = prrrams.needCookie;
var wantCookie = prrrams.wantCookie;

var COOKIES = {
    HAS_EMAIL: 'e',
    TOKEN : 'token2',
    UID : 'uid2',
    REFERRER : 'ref',
    PARENT_REFERRER : 'referrer',
    PARENT_URL : 'parent_url',
    USER_CREATED_TIMESTAMP: 'uc',
    PERMANENT_COOKIE: 'pc',
    TRY_COOKIE: 'tryCookie',
    PLAN_NUMBER: 'plan', // not set if trial user
};
var COOKIES_TO_CLEAR = {
    e: true,
    token2: true,
    uid2: true,
    uc: true,
    plan: true,
    referrer: true,
    parent_url: true,
};



function initializePolisAPI(err, args) {
var mongoParams = args[0];

if (err) {
    console.error("failed to init db connections");
    console.error(err);
    yell("failed_to_init_db_connections");
    return;
}
var collection = mongoParams.mongoCollectionOfEvents;
var collectionOfUsers = mongoParams.mongoCollectionOfUsers;
var collectionOfStimuli = mongoParams.mongoCollectionOfStimuli;
var collectionOfPcaResults = mongoParams.mongoCollectionOfPcaResults;
var collectionOfBidToPidResults = mongoParams.mongoCollectionOfBidToPidResults;
var collectionOfPcaPlaybackResults = mongoParams.mongoCollectionOfPcaPlaybackResults;

var polisTypes = {
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

//         var exists = {};
//         votes.forEach(function(v) {
//             exists[v.zid +"_"+ v.tid] = true;
//         });
//         var missing = [];
//         for (var i = 0 ; i < comments.length; i++) {
//             var c = comments[i];
//             if (!exists[c.zid + "_" + c.tid]) {
//                 missing.push(c);
//             }
//         }
//         async.series(
//             missing.map(function(c) {
//                 return function(callback) {
//                     votesPost(c.pid, c.zid, c.tid, 0)
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



var oneYear = 1000*60*60*24*365;

function setCookie(req, res, setOnPolisDomain, name, value, options) {
    var o = _.clone(options||{});
    o.path = _.isUndefined(o.path) ? '/' : o.path;
    o.maxAge = _.isUndefined(o.maxAge) ? oneYear : o.maxAge;
    if (setOnPolisDomain) {
        o.secure = _.isUndefined(o.secure) ? true : o.secure;
        o.domain = _.isUndefined(o.domain) ? '.pol.is' : o.domain;
        if (/polis.io/.test(req.headers.host)) {
            o.domain = '.polis.io';
        }
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
        var email = o.email;
        var created = o.created;
        var plan = o.plan;

        var setOnPolisDomain = !domainOverride;
        var origin = req.headers.origin || "";
        if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
            setOnPolisDomain = false;
        }

        setTokenCookie(req, res, setOnPolisDomain, token);
        setUidCookie(req, res, setOnPolisDomain, uid);
        setPlanCookie(req, res, setOnPolisDomain, plan);
        setHasEmailCookie(req, res, setOnPolisDomain, email);
        setUserCreatedTimestampCookie(req, res, setOnPolisDomain, o.created);
        if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
            setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
        }
        res.header("x-polis", token);
    });
}


function generateHashedPassword(password, callback) {
    bcrypt.genSalt(12, function(errSalt, salt) {
        if (errSalt) { return callback("polis_err_salt"); }
        bcrypt.hash(password, salt, function(errHash, hashedPassword) {
            if (errHash) { return callback("polis_err_hash");}
            callback(null, hashedPassword);
        });
    });
}

var pidCache = new LruCache({
    max: 9000,
});

// returns a pid of -1 if it's missing
function getPid(zid, uid, callback) {
    var cacheKey = zid + "_" + uid;
    var cachedPid = pidCache.get(cacheKey);
    if (!_.isUndefined(cachedPid)) {
        callback(null, cachedPid);
        return;
    }
    pgQuery_readOnly("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, docs) {
        var pid = -1;
        if (docs && docs.rows && docs.rows[0]) {
            pid = docs.rows[0].pid;
            pidCache.set(cacheKey, pid);
        }
        callback(err, pid);
    });
}

// returns a pid of -1 if it's missing
function getPidPromise(zid, uid) {
    var cacheKey = zid + "_" + uid;
    var cachedPid = pidCache.get(cacheKey);
    return new MPromise("getPidPromise", function(resolve, reject) {
        if (!_.isUndefined(cachedPid)) {
            resolve(cachedPid);
            return;
        }
        pgQuery_readOnly("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, results) {
            if (err) {return reject(err);}
            if (!results || !results.rows || !results.rows.length) {
                resolve(-1);
                return;
            }
            var pid = results.rows[0].pid;
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
        fail(res, 500, "polis_err_this_middleware_should_be_after_auth_and_zid", err);
        next("polis_err_this_middleware_should_be_after_auth_and_zid");
    }
    console.dir(req.p);

    var existingValue = extractFromBody(req, pidThingStringName) || extractFromCookie(req, pidThingStringName);

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
        var zid = req.p.zid;
        var uid = req.p.uid;
        function finish(pid) {
            assigner(req, "pid", pid);
            next();
        }
        getPidPromise(zid, uid).then(function(pid) {
            if (pid === -1) {
                var msg = "polis_err_get_pid_for_participant_missing";
                yell(msg);

                winston.log("info",zid);
                winston.log("info",uid);
                winston.log("info",req.p);
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
        },function(err) {
            console.error(err);
            // hmm, weird, try inserting anyway
            return doInsert();
        });
}


function doVotesPost(pid, zid, tid, voteType) {
    return new Promise(function(resolve, reject) {
        var query = "INSERT INTO votes (pid, zid, tid, vote, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
        var params = [pid, zid, tid, voteType];
        pgQuery(query, params, function(err, result) {
            if (err) {
                if (isDuplicateKey(err)) {
                    reject("polis_err_vote_duplicate");
                } else {
                    reject("polis_err_vote");
                }
                return;
            }
            resolve(result.rows[0].created);
        });
    });
}

function votesPost(pid, zid, tid, voteType) {
    return pgQueryP_readOnly("select is_active from conversations where zid = ($1);", [zid]).then(function(rows) {
        if (!rows || !rows.length) {
            throw "polis_err_unknown_conversation";
        }
        var conv = rows[0];
        if (!conv.is_active) {
            throw "polis_err_conversation_is_closed";
        }
    }).then(function() {
        return doVotesPost(pid, zid, tid, voteType);
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
        var q = sql_votes.select(sql_votes.star())
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

  var exempt = devMode;

  // IE is picky, so use HTTP.
  // TODO figure out IE situation, (proxy static files in worst-case)
 // exempt = exempt || /MSIE/.test(req.headers['user-agent']); // TODO test IE11

  if (exempt) {
    return next();
  }

  if(!/https/.test(req.headers["x-forwarded-proto"])) { // assuming we're running on Heroku, where we're behind a proxy.
    res.writeHead(302, {
        Location: "https://" + req.headers.host + req.url
    });
    return res.end();
  }
  return next();
}

function redirectIfWrongDomain(req, res, next) {
  if(
    // /polis.io/.test(req.headers.host) ||
     // /polisapp.herokuapp.com/.test(req.headers.host) || // needed for heroku integrations (like slack?)
     /www.pol.is/.test(req.headers.host)
     ) {
    res.writeHead(302, {
        Location: "https://pol.is" + req.url
    });
    return res.end();
  }
  return next();
}
function redirectIfApiDomain(req, res, next) {
  if(/api.pol.is/.test(req.headers.host)) {
    if (req.url === "/" || req.url === "") {
        res.writeHead(302, {
            Location: "https://pol.is/docs/api"
        });
        return res.end();
    } else if (!req.url.match(/^\/?api/)) {
        res.writeHead(302, {
            Location: "https://pol.is/" + req.url
        });
        return res.end();
    }
  }
  return next();
}


function createDummyUser() {
    return new MPromise("createDummyUser", function(resolve, reject) {
        pgQuery("INSERT INTO users (created) VALUES (default) RETURNING uid;",[], function(err, results) {
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
//     var query = "insert into users (created) values ";
//     var values = [];
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
//             var uids = results.rows.map(function(row) {
//                 return row.uid;
//             });
//             resolve(uids);
//         });
//     });
// }


function auth(assigner, isOptional) {
    return function(req, res, next) {
        //var token = req.body.token;
        var token = req.cookies[COOKIES.TOKEN];
        var xPolisToken = req.headers["x-polis"];

        if (xPolisToken && isPolisLtiToken(xPolisToken)) {
            doPolisLtiTokenHeaderAuth(assigner, isOptional, req, res, next);
        } else if (xPolisToken) {
            doHeaderAuth(assigner, isOptional, req, res, next);
        } else if (token) {
            doCookieAuth(assigner, isOptional, req, res, next);
        } else if (req.headers.authorization) {
            doApiKeyBasicAuth(assigner, isOptional, req, res, next);
        } else if (req.body.agid) {  // Auto Gen user  ID
            createDummyUser().then(function(uid) {
                return startSessionAndAddCookies(req, res, uid).then(function() {
                    req.p = req.p || {};
                    req.p.uid = uid;
                    next();
                });
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
        var start = Date.now();
        setTimeout(function() {
            metric(name + ".go", 1, start);
        }, 1);
        res.on('finish', function(){
          var end = Date.now();
          var duration = end - start;
          var status = ".ok";
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

app.use(responseTime(function (req, res, time) {
    if (req && req.route && req.route.path) {
        var path = req.route.path;
        time = time << 0;
        addInRamMetric(path, time);
    }
}));

app.use(redirectIfNotHttps);
app.use(express.cookieParser());
app.use(express.bodyParser());
app.use(writeDefaultHead);
var p3pFunction = p3p(p3p.recommended);
app.use(function(req, res, next) {
    if (isIE(req)) {
        return p3pFunction(req, res, next);
    } else {
        return next();
    }
});
app.use(redirectIfWrongDomain);
app.use(redirectIfApiDomain);

var gzipMiddleware = express.compress();
function maybeApplyGzip(req, res, next) {
    if (req.path && req.path.indexOf("/math/pca2") >= 0) {
        // pca2 caches gzipped responses, so no need to gzip again.
        next(null);
    } else {
        return gzipMiddleware(req, res, next);
    }
}


if (devMode) {
    app.use(express.compress());
} else {
    // Cloudflare would apply gzip if we didn't
    // but it's about 2x faster if we do the gzip (for the inbox query on mike's account)
    app.use(express.compress());
}
app.use(function(req, res, next) {
    if (devMode) {
        var b = "";
        if (req.body) {
            var temp = _.clone(req.body);
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
        winston.log("info",req.path + " " + b);
    } else {
        // don't log the route or params, since Heroku does that for us.
    }
    next();
});
app.use(function(err, req, res, next) {
    if(!err) {
        return next();
    }
    winston.log("info","error found in middleware");
    console.error(err);
    if (err && err.stack) {
        console.error(err.stack);
    }
    yell(err);
    next(err);
});


var whitelistedCrossDomainRoutes = [
    /^\/api\/v[0-9]+\/launchPrep/,
    /^\/api\/v[0-9]+\/setFirstCookie/,
];

var whitelistedDomains = [
  "http://beta7816238476123.polis.io",
  "https://beta7816238476123.polis.io",
  "http://about.polis.io",
  "https://about.polis.io",
  "http://www.polis.io",
  "https://www.polis.io",
  "http://bonn83np5g4s6k2am.herokuapp.com/",
  "http://polis.io",
  "https://polis.io",
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
  "http://polisapp.herokuapp.com",
  "https://polisapp.herokuapp.com",
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
  "https://connect.stripe.com",
  "", // for API
];

var whitelistedBuckets = {
    "pol.is": "pol.is",
    "embed.pol.is": "pol.is",
    "survey.pol.is": "survey.pol.is",
    "www.polis.io": "pol.is",
    "preprod.pol.is": "preprod.pol.is",
    "about.polis.io": "about.polis.io",
};

function addCorsHeader(req, res, next) {

  var host = "";
  if (domainOverride) {
      host = req.protocol + "://" + domainOverride;
  } else {
      // TODO does it make sense for this middleware to look
      // at origin || referer? is Origin for CORS preflight?
      // or for everything?
      // Origin was missing from FF, so added Referer.
      host =  req.get("Origin") || req.get("Referer") || "";
  }

  // Somehow the fragment identifier is being sent by IE10????
  // Remove unexpected fragment identifier
  host = host.replace(/#.*$/, "");

  // Remove characters starting with the first slash following the double slash at the beginning.
  var result = /^[^\/]*\/\/[^\/]*/.exec(host);
  if (result && result[0]) {
      host = result[0];
  }


  // check if the route is on a special list that allows it to be called cross domain (by polisHost.js for example)
  var routeIsWhitelistedForAnyDomain = _.some(whitelistedCrossDomainRoutes, function(regex) { return regex.test(req.path);});

  if (!domainOverride && -1 === whitelistedDomains.indexOf(host) && !routeIsWhitelistedForAnyDomain) {
      winston.log("info",'not whitelisted');
      // winston.log("info",req);
      winston.log("info",req.headers);
      winston.log("info",req.path);
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

app.all("/api/v3/*", addCorsHeader);
app.all("/font/*", addCorsHeader);

app.all("/api/v3/*", function(req, res, next) {
  if (req.method.toLowerCase() !== "options") {
    return next();
  }
  return res.send(204);
});


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
var hex, i;
// var str = "\u6f22\u5b57"; // "\u6f22\u5b57" === "漢字"
var result = "";
for (i=0; i<str.length; i++) {
  hex = str.charCodeAt(i).toString(16);
  result += ("000"+hex).slice(-4);
}
return result;
}
function hexToStr(hexString) {
var j;
var hexes = hexString.match(/.{1,4}/g) || [];
var str = "";
for(j = 0; j<hexes.length; j++) {
  str += String.fromCharCode(parseInt(hexes[j], 16));
}
return str;
}

// TODO this should probably be exempt from the CORS restrictions
app.get("/api/v3/launchPrep",
    moveToBody,
    need("dest", getStringLimitLength(1, 10000), assignToP),
function(req, res) {


    var setOnPolisDomain = !domainOverride;
    var origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
        setPermanentCookie(req, res, setOnPolisDomain, makeSessionToken());
    }

    setCookie(req, res, setOnPolisDomain, "top", "ok", {
        httpOnly: false,            // not httpOnly - needed by JS
    });

    // using hex since it doesn't require escaping like base64.
    var dest = hexToStr(req.p.dest);
    res.redirect(dest);
});


// app.get("/api/v3/setFirstCookie",
//     moveToBody,
// function(req, res) {


//     var setOnPolisDomain = !domainOverride;
//     var origin = req.headers.origin || "";
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

app.get("/api/v3/tryCookie",
    moveToBody,
function(req, res) {


    var setOnPolisDomain = !domainOverride;
    var origin = req.headers.origin || "";
    if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        setOnPolisDomain = false;
    }

    if (!req.cookies[COOKIES.TRY_COOKIE]) {
        setCookie(req, res, setOnPolisDomain, COOKIES.TRY_COOKIE, "ok", {
            httpOnly: false,            // not httpOnly - needed by JS
        });
    }
    res.status(200).json({});
});


var pcaCacheSize = (process.env.CACHE_MATH_RESULTS === "true") ? 300 : 1;
var pcaCache = new LruCache({
    max: pcaCacheSize,
});

var lastPrefetchedVoteTimestamp = -1;

// this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
function fetchAndCacheLatestPcaData() {
    var lastPrefetchPollStartTime = Date.now();
    function waitTime() {
        var timePassed = Date.now() - lastPrefetchPollStartTime;
        return Math.max(0, 2500 - timePassed);
    }

    INFO("mathpoll begin", lastPrefetchedVoteTimestamp);
    var cursor = collectionOfPcaResults.find({
        lastVoteTimestamp: {$gt: lastPrefetchedVoteTimestamp}
    });
    // cursor.sort([["lastVoteTimestamp", "asc"]]);

    function processItem(err, item) {
        if (err) {
            console.error(err);
            console.error("mathpoll err", "polis_err_prefetch_pca_results_iter");
            setTimeout(fetchAndCacheLatestPcaData, 10 * waitTime());
            return;
        }
        if(item === null) {
            // call again
            INFO("mathpoll done");
            setTimeout(fetchAndCacheLatestPcaData, waitTime());
            return;
        }

        INFO("mathpoll updating", item.lastVoteTimestamp, item.zid);

        // var prev = pcaCache.get(item.zid);

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
    var cached = pcaCache.get(zid);
    var cachedPOJO = cached && cached.asPOJO;
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
        var queryStart = Date.now();
        collectionOfPcaResults.find({zid: zid}, function(err, cursor) {
            if (err) {
                reject("polis_err_get_pca_results_find");
                return;
            }

            var queryEnd = Date.now();
            var queryDuration = queryEnd - queryStart;
            addInRamMetric("pcaGetQuery", queryDuration);

            var nextObjectStart = Date.now();
            cursor.nextObject(function(err, item) {

                var nextObjectEnd = Date.now();
                var nextObjectDuration = nextObjectEnd - nextObjectStart;
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
        var asJSON = JSON.stringify(item);
        var buf = new Buffer(asJSON, 'utf-8');
        zlib.gzip(buf, function(err, jsondGzipdPcaBuffer) {
            if (err) {
                return reject(err);
            }

            var o = {
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
        collectionOfPcaPlaybackResults.find({$and :[
            {zid: zid},
            {lastVoteTimestamp: lastVoteTimestamp},
            ]}, function(err, cursor) {
            if (err) {
                reject("polis_err_get_pca_playback_result_find");
                return;
            }
            cursor.toArray( function(err, docs) {
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
        collectionOfPcaPlaybackResults.find({zid: zid}, function(err, cursor) {
            if (err) {
                reject("polis_err_get_pca_playback_results_list_find");
                return;
            }
            // TODO save some memory by using the cursor as a cursor
            cursor.toArray( function(err, docs) {
                if (err) {
                    reject("polis_err_get_pca_playback_results_list_find_toarray");
                } else if (!docs.length) {
                    resolve(null);
                } else {
                    var summaries = [];
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
    winston.log("info","redirecting old zid user to about page");
    res.writeHead(302, {
        Location: "https://pol.is/about"
    });
    return res.end();
  }
  return next();
}




app.get("/api/v3/math/pca",
function(req, res) {
    // migrated off this path, old clients were causing timeout issues by polling repeatedly without waiting for a result for a previous poll.
    res.status(304).end();
});

// Cache the knowledge of whether there are any pca results for a given zid.
// Needed to determine whether to return a 404 or a 304.
// zid -> boolean
var pcaResultsExistForZid = {};

app.get("/api/v3/math/pca2",
    //meter("api.math.pca.get"),
    moveToBody,
    redirectIfHasZidButNoConversationId, // TODO remove once
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, -1),
function(req, res) {
    var zid = req.p.zid;
    var lastVoteTimestamp = req.p.lastVoteTimestamp;

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
                    var exists = !!data;
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
});




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



function doProxyDataExportCall(req, res, urlBuilderFunction) {
    Promise.all([
        getUserInfoForUid2(req.p.uid),
        getConversationInfo(req.p.zid),
    ]).then(function(a) {
        var user = a[0];
        var conv = a[1];
        var isOwner = req.p.uid === conv.owner;
        var isAllowed = isOwner || isPolisDev(req.p.uid);

        if (!isAllowed) {
            fail(res, 403, "polis_err_permission", err);
            return;
        }
        var exportServerUser = process.env.EXPORT_SERVER_AUTH_USERNAME;
        var exportServerPass = process.env.EXPORT_SERVER_AUTH_PASS;

        var url = urlBuilderFunction(exportServerUser, exportServerPass, user.email);

        var x = request(url);
        req.pipe(x);
        x.pipe(res);
        x.on("error", function(err) {
            fail(res, 500, "polis_err_data_export1", err);
        });

        // "https://polisdarwin.herokuapp.com/datadump/results?filename=polis-export-2demo-1446053307819.zip&zinvite=2demo"

    }, function(err) {
        fail(res, 500, "polis_err_data_export2", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_data_export3", err);
    });
}



app.get("/api/v3/dataExport",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
    want('format', getStringLimitLength(1, 100), assignToP),
    want('unixTimestamp', getStringLimitLength(99), assignToP),
function(req, res) {
    doProxyDataExportCall(req, res, function(exportServerUser, exportServerPass, email) {
        return "http://" +
            exportServerUser+":"+exportServerPass +
            "@polisdarwin.herokuapp.com/datadump/get?zinvite=" +
            req.p.conversation_id +
            "&format="+req.p.format+"&email=" +
            email +
            (req.p.unixTimestamp ? ("&at-date=" + req.p.unixTimestamp * 1000) : "")
            ;
    });
});

app.get("/api/v3/dataExport/results",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
    want('filename', getStringLimitLength(1, 1000), assignToP),
function(req, res) {
    doProxyDataExportCall(req, res, function(exportServerUser, exportServerPass, email) {
        return "http://" +
            exportServerUser+":"+exportServerPass +
            "@polisdarwin.herokuapp.com/datadump/results?zinvite=" +
            req.p.conversation_id +
            "&filename="+req.p.filename;
    });
});

app.get("/api/v3/math/pcaPlaybackList",
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var zid = req.p.zid;

    getPcaPlaybackList(zid).then(function(summaries) {
        res.status(200).json(summaries);
    }).catch(function(err) {
        fail(res, 500, err);
    });
});

app.get("/api/v3/math/pcaPlaybackByLastVoteTimestamp",
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var lastVoteTimestamp = req.p.lastVoteTimestamp;

    getPcaPlaybackByLastVoteTimestamp(zid, lastVoteTimestamp).then(function(data) {
        res.status(200).json(data);
    }).catch(function(err) {
        fail(res, 500, err);
    });
});

function getBidToPidMapping(zid, lastVoteTimestamp) {
    lastVoteTimestamp = lastVoteTimestamp || -1;
    return new MPromise("getBidToPidMapping", function(resolve, reject) {
        collectionOfBidToPidResults.find({zid: zid}, function(err, cursor) {
            if (err) { reject("polis_err_get_pca_results_find"); return; }
            cursor.toArray( function(err, docs) {
                if (err) { reject(new Error("polis_err_get_pca_results_find_toarray")); return; }
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

// TODO doesn't scale, stop sending entire mapping.
app.get("/api/v3/bidToPid",
    authOptional(assignToP),
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, 0),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;
    var lastVoteTimestamp = req.p.lastVoteTimestamp;

    getBidToPidMapping(zid, lastVoteTimestamp).then(function(doc) {
        var b2p = doc.bidToPid;

        res.json({
            bidToPid: b2p
        });

    },function(err) {
        res.status(304).end();
    });
});

function getXids(zid) {
    return new MPromise("getXids", function(resolve, reject) {

        pgQuery_readOnly("select pid, xid from xids inner join "+
            "(select * from participants where zid = ($1)) as p on xids.uid = p.uid "+
            " where owner in (select owner from conversations where zid = ($1));", [zid], function(err, result) {
            if (err) {
                reject("polis_err_fetching_xids");
                return;
            }
            resolve(result.rows);
        });
    });
}


app.get("/api/v3/xids",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;

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
});


function getBidsForPids(zid, lastVoteTimestamp, pids) {
    var dataPromise = getBidToPidMapping(zid, lastVoteTimestamp);
    var mathResultsPromise = getPca(zid, lastVoteTimestamp);

    return Promise.all([dataPromise, mathResultsPromise]).then(function(items) {
        var b2p = items[0].bidToPid || [];  // not sure yet if "|| []" is right here.
        var mathResults = items[1].asPOJO;


        function findBidForPid(pid) {
            var yourBidi = -1;
            // if (!b2p) {
            //     return yourBidi;
            // }
            for (var bidi = 0; bidi < b2p.length; bidi++) {
                var pids = b2p[bidi];
                if (pids.indexOf(pid) !== -1) {
                    yourBidi = bidi;
                    break;
                }
            }

            var yourBid = indexToBid[yourBidi];

            if (yourBidi >= 0 && _.isUndefined(yourBid)) {
                console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
                yell("polis_err_math_index_mapping_mismatch");
                yourBid = -1;
            }
            return yourBid;
        }

        var indexToBid = mathResults["base-clusters"].id;
        var bids = pids.map(findBidForPid);
        var pidToBid = _.object(pids, bids);
        return pidToBid;
    });
}

function getClusters(zid, lastVoteTimestamp) {
    return getPca(zid, lastVoteTimestamp).then(function(pcaData) {
        return pcaData.asPOJO["group-clusters"];
    });
}

// TODO cache
app.get("/api/v3/bid",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, 0),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;
    var lastVoteTimestamp = req.p.lastVoteTimestamp;

    var dataPromise = getBidToPidMapping(zid, lastVoteTimestamp);
    var pidPromise = getPidPromise(zid, uid);
    var mathResultsPromise = getPca(zid, lastVoteTimestamp);

    Promise.all([dataPromise, pidPromise, mathResultsPromise]).then(function(items) {
        var b2p = items[0].bidToPid || []; // not sure yet if "|| []" is right here.
        var pid = items[1];
        var mathResults = items[2].asPOJO;


        if (pid < 0) {
            // NOTE: this API should not be called in /demo mode
            fail(res, 500, "polis_err_get_bid_bad_pid");
            return;
        }

        var indexToBid = mathResults["base-clusters"].id;

        var yourBidi = -1;
        for (var bidi = 0; bidi < b2p.length; bidi++) {
            var pids = b2p[bidi];
            if (pids.indexOf(pid) !== -1) {
                yourBidi = bidi;
                break;
            }
        }

        var yourBid = indexToBid[yourBidi];

        if (yourBidi >= 0 && _.isUndefined(yourBid)) {
            console.error("polis_err_math_index_mapping_mismatch", "pid was", pid, "bidToPid was", JSON.stringify(b2p));
            yell("polis_err_math_index_mapping_mismatch");
            yourBid = -1;
        }

        res.json({
            bid: yourBid // The user's current bid
        });

    }, function(err) {
        res.status(304).end();
    }).catch(function(err) {
        fail(res, 500, "polis_err_get_bid_misc", err);
    });
});


app.post("/api/v3/auth/password",
    need('pwresettoken', getOptionalStringLimitLength(1000), assignToP),
    need('newPassword', getPasswordWithCreatePasswordRules, assignToP),
function(req, res) {
    var pwresettoken = req.p.pwresettoken;
    var newPassword = req.p.newPassword;

    getUidForPwResetToken(pwresettoken, function(err, userParams) {
        if (err) { console.error(err); fail(res, 500, "Password Reset failed. Couldn't find matching pwresettoken.", err); return; }
        var uid = Number(userParams.uid);
        generateHashedPassword(newPassword, function(err, hashedPassword) {
            pgQuery("UPDATE jianiuevyew SET pwhash = ($1) where uid=($2);", [hashedPassword, uid], function(err, results) {
                if (err) { console.error(err); fail(res, 500, "Couldn't reset password.", err); return; }
                res.status(200).json("Password reset successful.");
                clearPwResetToken(pwresettoken, function(err) {
                    if (err) { yell(err); console.error("polis_err_auth_pwresettoken_clear_fail"); }
                });
            });
        });
    });
});


function getServerNameWithProtocol(req) {
    var server = "https://pol.is";
    if (devMode) {
      // usually localhost:5000
      server = "http://" + req.headers.host;
    }

    if (req.headers.host.indexOf("preprod.pol.is") >= 0) {
        server = "https://preprod.pol.is";
    }
    if (req.headers.host.indexOf("embed.pol.is") >= 0) {
        server = "https://embed.pol.is";
    }
    if (req.headers.host.indexOf("survey.pol.is") >= 0) {
        server = "https://survey.pol.is";
    }
    return server;
}


app.post("/api/v3/auth/pwresettoken",
    need('email', getEmail, assignToP),
function(req, res) {
    var email = req.p.email;

    var server = getServerNameWithProtocol(req);

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
});

function sendPasswordResetEmailFailure(email, server) {
    var body = "" +
    "We were unable to find a pol.is account registered with the email address: " + email + "\n" +
    "\n" +
    "You may have used another email address to create your account.\n" +
    "\n" +
    "If you need to create a new account, you can do that here " + server + "/user/create\n" +
    "\n" +
    "Feel free to reply to this email if you need help.";

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
    var origin = req.headers.origin || "";
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        res.clearCookie(cookieName, {path: "/"});
    } else {
        res.clearCookie(cookieName, {path: "/", domain: ".polis.io"});
        res.clearCookie(cookieName, {path: "/", domain: "www.polis.io"});
        res.clearCookie(cookieName, {path: "/", domain: ".pol.is"});
        //         res.clearCookie(cookieName, {path: "/", domain: "www.pol.is"});
    }
}

function clearCookies(req, res) {
    var origin = req.headers.origin || "";
    var cookieName;
    if (domainOverride || origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
        for (cookieName in req.cookies) {
            if (COOKIES_TO_CLEAR[cookieName]) {
                res.clearCookie(cookieName, {path: "/"});
            }
        }
    } else {

        for (cookieName in req.cookies) {
            if (COOKIES_TO_CLEAR[cookieName]) {
                res.clearCookie(cookieName, {path: "/", domain: ".polis.io"});
            }
        }
        for (cookieName in req.cookies) {
            if (COOKIES_TO_CLEAR[cookieName]) {
                res.clearCookie(cookieName, {path: "/", domain: "www.polis.io"});
            }
        }
        for (cookieName in req.cookies) {
            if (COOKIES_TO_CLEAR[cookieName]) {
                res.clearCookie(cookieName, {path: "/", domain: ".pol.is"});
            }
        }
        // for (cookieName in req.cookies) {
        //     if (COOKIES_TO_CLEAR[cookieName]) {
        //         res.clearCookie(cookieName, {path: "/", domain: "www.pol.is"});
        //     }
        // }
    }
    winston.log("info","after clear res set-cookie: " + JSON.stringify(res._headers["set-cookie"]));
}


function doCookieAuth(assigner, isOptional, req, res, next) {

    var token = req.cookies[COOKIES.TOKEN];

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
        if ( req.body.uid && req.body.uid !== uid) {
            res.status(401);
            next("polis_err_auth_mismatch_uid");
            return;
        }
        assigner(req, "uid", Number(uid));
        next();
    });
}

app.post("/api/v3/auth/deregister",
    want("showPage", getStringLimitLength(1, 99), assignToP),
function(req, res) {
    req.p = req.p || {};
    var token = req.cookies[COOKIES.TOKEN];

    // clear cookies regardless of auth status
    clearCookies(req, res);

    function finish() {
        if (!req.p.showPage) {
            res.status(200).end();
        } else if (req.p.showPage === "canvas_assignment_deregister") {
            res.set({
                'Content-Type': 'text/html',
            });
            var html = "" +
            "<!DOCTYPE html><html lang='en'>"+
            "<body>"+
                "<h1>You are now signed out of pol.is</h1>" +
                "<p>Please return to the 'setup pol.is' assignment to sign in as another user.</p>" +
            "</body></html>";
            res.status(200).send(html);
        }
    }
    if (!token) {
        // nothing to do
        return finish();
    }
    endSession(token, function(err, data) {
        if (err) { fail(res, 500, "couldn't end session", err); return; }
        finish();
    });
});

// app.post("/api/v3/metrics",
//     authOptional(assignToP),
//     need('types', getArrayOfInt, assignToP),
//     need('times', getArrayOfInt, assignToP),
//     need('durs', getArrayOfInt, assignToP),
//     need('clientTimestamp', getInt, assignToP),
// function(req, res) {
//     var uid = req.p.uid || null;
//     var durs = req.p.durs.map(function(dur) {
//         if (dur === -1) {
//             dur = null;
//         }
//         return dur;
//     });
//     var clientTimestamp = req.p.clientTimestamp;
//     var ages = req.p.times.map(function(t) {
//         return clientTimestamp - t;
//     });
//     var now = Date.now();
//     var timesInTermsOfServerTime = ages.map(function(a) {
//         return now - a;
//     });
//     var len = timesInTermsOfServerTime.length;
//     var entries = [];
//     for (var i = 0; i < len; i++) {
//         entries.push([uid, types[i], durs[i], timesInTermsOfServerTime[i]].join(','));
//     }
//     pgQueryP("insert into metrics (uid, type, dur, created) values ("+ entries +");", []).then(function(result) {
//         res.json({});
//     }).catch(function(err) {
//         fail(res, 500, "polis_err_metrics_post", err);
//     });
// });


app.get("/api/v3/zinvites/:zid",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    // if uid is not conversation owner, fail
    pgQuery_readOnly('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) {
            fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner", err);
            return;
        }
        if (!results || !results.rows) {
            res.writeHead(404);
            res.json({status: 404});
            return;
        }
        pgQuery_readOnly('SELECT * FROM zinvites WHERE zid = ($1);', [req.p.zid], function(err, results) {
            if (err) {
                fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something", err);
                return;
            }
            if (!results || !results.rows) {
                res.writeHead(404);
                res.json({status: 404});
                return;
            }
            res.status(200).json({
                codes: results.rows, // _.pluck(results.rows[0],"code");
            });
        });
    });
});

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
            winston.log("info",longStringOfTokens);
            var otzinviteArray = longStringOfTokens.match(/.{1,31}/g);
            otzinviteArray = otzinviteArray.slice(0, numTokens); // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
            otzinviteArray = otzinviteArray.map(function(suzinvite) {
                return generateConversationURLPrefix() + suzinvite;
            });
            winston.log("info",otzinviteArray);
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
    var gen;
    if (pseudoRandomOk) {
        gen = crypto.pseudoRandomBytes;
    } else {
        gen = crypto.randomBytes;
    }
    gen(len, function(err, buf) {
        if (err) {
            return callback(err);
        }

        var prettyToken = buf.toString('base64')
            .replace(/\//g,'A').replace(/\+/g,'B') // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)
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
        prettyToken = _.random(2,9) + prettyToken.slice(1);
        prettyToken = prettyToken.toLowerCase();
        prettyToken = prettyToken.slice(0, len); // in case it's too long

        callback(0, prettyToken);
    });
}

function generateApiKeyForUser(uid, optionalPrefix) {
    var prefix = _.isUndefined(optionalPrefix) ? "" : optionalPrefix;
    var parts = ["pkey"];
    var len = 32;
    if (!_.isUndefined(optionalPrefix)) {
        parts.push(optionalPrefix);
    }
    len -= parts[0].length;
    len -= (parts.length - 1); // the underscores
    parts.forEach(function(part) {
        len -= part.length;
    });
    return generateTokenP(len, false).then(function(token) {
        parts.push(token);
        var apikey = parts.join("_");
        return apikey;

    });
}

function addApiKeyForUser(uid, optionalPrefix) {
    return generateApiKeyForUser(uid, optionalPrefix).then(function(apikey) {
        return pgQueryP("insert into apikeysndvweifu (uid, apikey)  VALUES ($1, $2);", [uid, apikey]);
    });
}


function getApiKeysTruncated(uid) {
    return pgQueryP_readOnly("select * from apikeysndvweifu WHERE uid = ($1);", [uid]).then(function(rows) {
        if (!rows || !rows.length) {
            return [];
        }
        return rows.map(function(row) {
            return {
                apikeyTruncated: row.apikey.slice(0,10) + "...",
                created: row.created,
            };
        });
    });
}

function createApiKey(uid) {
    return generateTokenP(17, false).then(function(token) {
        var apikey = "pkey_" + token;
        return pgQueryP("insert into apikeysndvweifu (uid, apikey) values ($1, $2) returning *;", [uid, apikey]).then(function(row) {
            return {
                apikey: apikey,
                created: row.created,
            };
        });
    });
}

function deleteApiKey(uid, apikeyTruncated) {

    // strip trailing "..."
    apikeyTruncated = apikeyTruncated.slice(0, apikeyTruncated.indexOf("."));

    // basic sanitizing - replace unexpected characters with x's.
    apikeyTruncated = apikeyTruncated.replace(/[^a-zA-Z0-9_]/g,'x');

    return pgQueryP("delete from apikeysndvweifu where uid = ($1) and apikey ~ '^"+ apikeyTruncated+"';", [uid]);
}



// function addApiKeyForUsersBulk(uids, optionalPrefix) {
//     var promises = uids.map(function(uid) {
//         return generateApiKeyForUser(uid, optionalPrefix);
//     });
//     return Promise.all(promises).then(function(apikeys) {
//         var query = "insert into apikeysndvweifu (uid, apikey)  VALUES ";
//         var pairs = [];
//         for (var i = 0; i < uids.length; i++) {
//             var uid = uids[i];
//             var apikey = apikeys[i];
//             pairs.push("(" + uid + ', \'' + apikey + '\')');
//         }
//         query += pairs.join(',');
//         query += 'returning uid;';
//         return pgQueryP(query, []);
//     });
// }

// var uidsX = [];
// for (var i = 200200; i < 300000; i++) {
//     uidsX.push(i);
// }
// addApiKeyForUsersBulk(uidsX, "test23").then(function(uids) {
//     console.log("hihihihi", uids.length);
//     setTimeout(function() { process.exit();}, 3000);
// });

// // var time1 = Date.now();
// createDummyUsersBatch(3 * 1000).then(function(uids) {
//         // var time2 = Date.now();
//         // var dt = time2 - time1;
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
    var len = 10;
    if (generateShort) {
        len = 6;
    }
    return generateTokenP(len, false).then(function(zinvite) {
        return pgQueryP('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite]).then(function(rows) {
            return zinvite;
        });
    });
}


app.post("/api/v3/zinvites/:zid",
    moveToBody,
    auth(assignToP),
    want('short_url', getBool, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var generateShortUrl = req.p.short_url;

    pgQuery('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) { fail(res, 500, "polis_err_creating_zinvite_invalid_conversation_or_owner", err); return; }

        generateAndRegisterZinvite(req.p.zid, generateShortUrl).then(function(zinvite) {
            res.status(200).json({
                zinvite: zinvite,
            });
        }).catch(function(err) {
            fail(res, 500, "polis_err_creating_zinvite", err);
        });
    });
});

function getUserProperty(uid, propertyName) {
    return new MPromise("getUserProperty", function(resolve, reject) {
        pgQuery_readOnly("SELECT * FROM users WHERE uid = ($1);", [uid], function(err, results) {
            if (err) {
                reject(err);
            } else if (!results || !results.rows || !results.rows.length) {
                reject();
            } else {
                resolve(results.rows[0][propertyName]);
            }
        });
    });
}

function getConversationProperty(zid, propertyName, callback) {
    pgQuery_readOnly('SELECT * FROM conversations WHERE zid = ($1);', [zid], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
            return;
        }
        callback(null, results.rows[0][propertyName]);
    });
}

function checkZinviteCodeValidity(zid, zinvite, callback) {
    pgQuery_readOnly('SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);', [zid, zinvite], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
        } else {
            callback(null);// ok
        }
    });
}

var zidToConversationIdCache = new LruCache({
    max: 1000,
});

function getZinvite(zid, dontUseCache) {
    var cachedConversationId = zidToConversationIdCache.get(zid);
    if (!dontUseCache && cachedConversationId) {
        return Promise.resolve(cachedConversationId);
    }
    return pgQueryP_metered("getZinvite", "select * from zinvites where zid = ($1);", [zid]).then(function(rows) {
        var conversation_id = rows && rows[0] && rows[0].zinvite || void 0;
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

    var uncachedZids = zids.filter(function(zid) {
        return !zidToConversationIdCache.get(zid);
    });
    var zidsWithCachedConversationIds = zids.filter(function(zid) {
        return !!zidToConversationIdCache.get(zid);
    }).map(function(zid) {
        return {
            zid: zid,
            zinvite: zidToConversationIdCache.get(zid),
        };
    });

    function makeZidToConversationIdMap(arrays) {
        var zid2conversation_id = {};
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
        pgQuery_readOnly("select * from zinvites where zid in ("+uncachedZids.join(",")+");", [], function(err, result) {
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
    var zids = [];
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
        var statusCode = altStatusCode || 200;
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
            for  (var i = 0; i < items.length; i++) {
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
            callback(null);// ok
        }
    });
}

function getOwner(zid) {
    return new MPromise("getOwner", function(resolve, reject) {
        pgQuery_readOnly("SELECT owner FROM conversations where zid = ($1);", [zid], function(err, results) {
            if (err || !results || !results.rows || !results.rows.length) {
                reject(new Error("polis_err_no_conversation_for_zid"));
                return;
            }
            resolve(results.rows[0].owner);
        });
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
    return pgQueryP(
        "select * from xids where xid = ($1) and owner = ($2) and uid = ($3);",
        [xid, owner, uid]).then(function(rows) {
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

    var q = "select * from participant_metadata_answers where zid = ($1) and pmaid in ("+
        answers.join(",") +
        ");";

    pgQuery(q, [zid], function(err, qa_results) {
        if (err) { winston.log("info","adsfasdfasd"); return callback(err);}

        qa_results = qa_results.rows;
        qa_results = _.indexBy(qa_results, "pmaid");
        // construct an array of params arrays
        answers = answers.map(function(pmaid) {
            var pmqid = qa_results[pmaid].pmqid;
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
                        if (err) { winston.log("info","sdkfuhsdu"); return cb(err);}
                        cb(0);
                    }
                );
            },
            function(err) {
                if (err) { winston.log("info","ifudshf78ds"); return callback(err);}
                // finished with all the inserts
                callback(0);
            }
        );
    });
}

function createParticpantLocationRecord(
        zid, uid, pid, lat, lng, source) {
    return pgQueryP("insert into participant_locations (zid, uid, pid, lat, lng, source) values ($1,$2,$3,$4,$5,$6);", [
        zid, uid, pid, lat, lng, source
    ]);
}

var LOCATION_SOURCES = {
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
        var fb = o[0] && o[0][0];
        var tw = o[1] && o[1][0];
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
    var params = _.extend({}, data, {
        zid: zid,
        uid: uid,
    });
    var q = sql_participants_extended.insert(params);
    return pgQueryP(q.toString(), [])
        .catch(function() {
            var params2 = _.extend({
                created: 9876543212345, // hacky string, will be replaced with the word "default".
            }, params);
            // TODO replace all this with an upsert once heroku upgrades postgres
            var qUpdate = sql_participants_extended.update(params2)
                .where(sql_participants_extended.zid.equals(zid))
                .and(sql_participants_extended.uid.equals(uid));
            var qString = qUpdate.toString();
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
        var pid = rows && rows[0] && rows[0].pid;
        var ptpt = rows[0];

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
        var promise = tryJoin()
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
        var pid;
        if (!docs || !docs.rows || docs.rows.length === 0) {
            err = err || 1;
        }
        callback(err);
    });
}

function isOwner(zid, uid) {
    return getConversationInfo(zid).then(function(info) {
        winston.log("info",39847534987 + " isOwner " + uid);
        winston.log("info",info);
        winston.log("info",info.owner === uid);
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
            if (err) {return reject(err);}
            if (!results || !results.rows) {
                return reject(new Error("polis_err_getParticipant_failed"));
            }
            resolve(results.rows[0]);
        });
    });
}

// returns null if it's missing
function getParticipantsByZidPids(zid, pids) {
    return new MPromise("getParticipantByZidPid", function(resolve, reject) {
        pids.forEach(function(pid) {
            if (!_.isNumber(pid)) {
                throw "polis_err_1_invalid_pid";
            }
        });
        if (!pids.length) {
            return Promise.resolve([]);
        }
        var pidString = pids.join(",");
        pgQuery_readOnly("SELECT * FROM participants WHERE zid = ($1) AND pid in ("+ pidString +");", [zid], function(err, results) {
            if (err) {return reject(err);}
            if (!results || !results.rows) {
                return reject(new Error("polis_err_getParticipantByZidPid_failed"));
            }
            resolve(results.rows[0]);
        });
    });
}

function getAnswersForConversation(zid, callback) {
    pgQuery_readOnly("SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;", [zid], function(err, x) {
        if (err) { callback(err); return;}
        callback(0, x.rows);
    });
}
function getChoicesForConversation(zid) {
    return new Promise(function(resolve, reject) {
        pgQuery_readOnly("select * from participant_metadata_choices where zid = ($1) and alive = TRUE;", [zid], function(err, x) {
            if (err) { reject(err); return; }
            if (!x || !x.rows) { resolve([]); return; }
            resolve(x.rows);
        });
    });
}


function getUserInfoForUid(uid, callback) {
    pgQuery_readOnly("SELECT email, hname from users where uid = $1", [uid], function(err, results) {
        if (err) { return callback(err); }
        if (!results.rows || !results.rows.length) {
            return callback(null);
        }
        callback(null, results.rows[0]);
    });
}
function getUserInfoForUid2(uid) {
    return new MPromise("getUserInfoForUid2", function(resolve, reject) {
        pgQuery_readOnly("SELECT * from users where uid = $1", [uid], function(err, results) {
            if (err) { return reject(err); }
            if (!results.rows || !results.rows.length) {
                return reject(null);
            }
            var o = results.rows[0];
            resolve(o);
        });
    });
}



function emailFeatureRequest(message) {
    var body = "" +
        "Somebody clicked a dummy button!\n" +
        message;

    return sendMultipleTextEmails(
        POLIS_FROM_ADDRESS,
        ["mike@pol.is", "colin@pol.is", "chris@pol.is"],
        "Dummy button clicked!!!",
        body).catch(function(err) {
            yell("polis_err_failed_to_email_for_dummy_button");
            yell(message);
        });
}

function emailBadProblemTime(message) {
    var body = "" +
        "Yo, there was a serious problem. Here's the message:\n" +
        message;

    return sendMultipleTextEmails(
        POLIS_FROM_ADDRESS,
        ["mike@pol.is", "colin@pol.is", "chris@pol.is"],
        "Polis Bad Problems!!!",
        body).catch(function(err) {
            yell("polis_err_failed_to_email_bad_problem_time");
            yell(message);
        });
}


function sendPasswordResetEmail(uid, pwresettoken, serverName, callback) {
    getUserInfoForUid(uid, function(err, userInfo) {
        if (err) {
            return callback(err);
        }
        if (!userInfo) {
            return callback('missing user info');
        }
        var body = "" +
            "Hi " + userInfo.hname + ",\n" +
            "\n" +
            "We have just received a password reset request for " + userInfo.email + "\n" +
            "\n" +
            "To reset your password, visit this url:\n" +
            serverName + "/pwreset/" + pwresettoken + "\n" +
            "\n" +
            "Thank you for using Polis\n";

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
    winston.log("info","sending email with mailgun: " + [sender, recipient, subject, text].join(" "));
    var servername = "";
    var options = {};
    return new Promise(function(resolve, reject) {
        mailgun.sendText(sender, [recipient], subject, text, servername, options, function(err) {
            if (err) {
                console.error("Unable to send email via mailgun to " + recipient + " " + err);
                yell("polis_err_mailgun_email_send_failed");
                reject(err);
            } else {
                winston.log("info","sent email with mailgun to " + recipient);
                resolve();
            }
        });
    });
}

function sendTextEmailWithPostmark(sender, recipient, subject, text) {
    winston.log("info","sending email with postmark: " + [sender, recipient, subject, text].join(" "));
    return new Promise(function(resolve, reject) {
        postmark.send({
            "From": sender,
            "To": recipient,
            "Subject": subject,
            "TextBody": text,
        }, function(error, success) {
            if(error) {
                console.error("Unable to send email via postmark to " + recipient + " " + error.message);
                yell("polis_err_postmark_email_send_failed");
                reject(error);
            } else {
                winston.log("info","sent email with postmark to " + recipient);
                resolve();
            }
        });
    });
}

function sendTextEmail(sender, recipient, subject, text) {
    var promise = sendTextEmailWithPostmark(sender, recipient, subject, text).catch(function(err) {
        yell("polis_err_primary_email_sender_failed");
        return sendTextEmailWithMailgun(sender, recipient, subject, text);
    });
    promise.catch(function(err) {
        yell("polis_err_backup_email_sender_failed");
    });
    return promise;
}

function sendMultipleTextEmails(sender, recipientArray, subject, text) {
    recipientArray = recipientArray || [];
    return Promise.all(recipientArray.map(function(email) {
        var promise = sendTextEmail(
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
    var d = new Date();
    if (d.getDay() === 1) {
        // send the monday backup email system test
        // If the sending fails, we should get an error ping.
        sendTextEmailWithMailgun(POLIS_FROM_ADDRESS, "mike@pol.is", "monday backup email system test (mailgun)", "seems to be working");
    }
}
setInterval(trySendingBackupEmailTest, 1000*60*60*23); // try every 23 hours (so it should only try roughly once a day)
trySendingBackupEmailTest();


function sendEinviteEmail(req, email, einvite) {
    var serverName = getServerNameWithProtocol(req);
    var body = "" +
        "Welcome to pol.is!\n" +
        "\n" +
        "Click this link to open your account:\n" +
        "\n" +
        serverName + "/welcome/" + einvite + "\n" +
        "\n" +
        "Thank you for using Polis\n";

    return sendTextEmail(
        POLIS_FROM_ADDRESS,
        email,
        "Get Started with Polis",
        body);
}



function paramsToStringSortedByName(params) {
    var pairs = _.pairs(params).sort(function(a, b) { return a[0] > b[0]; });
    pairs = pairs.map(function(pair) { return pair.join("=");});
    return pairs.join("&");
}

// // units are seconds
// var expirationPolicies = {
//     pwreset_created : 60 * 60 * 2,
// };

var HMAC_SIGNATURE_PARAM_NAME = "signature";

function createHmacForQueryParams(path, params) {
    path = path.replace(/\/$/,""); // trim trailing "/"
    var s = path +"?"+paramsToStringSortedByName(params);
    var hmac = crypto.createHmac("sha1", "G7f387ylIll8yuskuf2373rNBmcxqWYFfHhdsd78f3uekfs77EOLR8wofw");
    hmac.setEncoding('hex');
    hmac.write(s);
    hmac.end();
    var hash = hmac.read();
    return hash;
}

function verifyHmacForQueryParams(path, params) {
    return new Promise(function(resolve, reject) {
        params = _.clone(params);
        var hash = params[HMAC_SIGNATURE_PARAM_NAME];
        delete params[HMAC_SIGNATURE_PARAM_NAME];
        var correctHash = createHmacForQueryParams(path, params);
        // To thwart timing attacks, add some randomness to the response time with setTimeout.
        setTimeout(function() {
            winston.log("info","comparing", correctHash, hash);
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
            userInfo.hname ? (userInfo.hname + "<" + userInfo.email + ">") : userInfo.email,
            subject,
            body);
    });
}


// // tags: ANON_RELATED
app.get("/api/v3/participants",
    moveToBody,
    auth(assignToP),
    // want('pid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    // resolve_pidThing('pid', assignToP),
function(req, res) {
    // var pid = req.p.pid;
    var uid = req.p.uid;
    var zid = req.p.zid;

    pgQueryP_readOnly("select * from participants where uid = ($1) and zid = ($2)", [uid, zid]).then(function(rows) {
      var ptpt = rows && rows.length && rows[0] || null;
      res.status(200).json(ptpt);
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_participant", err);
    });

    // function fetchOne() {
    //     pgQuery("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
    //         if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
    //         var ptpt = result.rows[0];
    //         var data = {};
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
});

app.get("/api/v3/dummyButton",
    moveToBody,
    need("button", getStringLimitLength(1,999), assignToP),
    authOptional(assignToP),
function(req, res) {
    var message = req.p.button + " " + req.p.uid;
    emailFeatureRequest(message);
    res.status(200).end();
});

function userHasAnsweredZeQuestions(zid, answers) {
    return new MPromise("userHasAnsweredZeQuestions", function(resolve, reject) {
        getAnswersForConversation(zid, function(err, available_answers) {
            if (err) { reject(err); return;}

            var q2a = _.indexBy(available_answers, 'pmqid');
            var a2q = _.indexBy(available_answers, 'pmaid');
            for (var i = 0; i < answers.length; i++) {
                var pmqid = a2q[answers[i]].pmqid;
                delete q2a[pmqid];
            }
            var remainingKeys = _.keys(q2a);
            var missing = remainingKeys && remainingKeys.length > 0;
            if (missing) {
                return reject(new Error('polis_err_metadata_not_chosen_pmqid_' + remainingKeys[0]));
            } else {
                return resolve();
            }
        });
    });
}

app.post("/api/v3/participants",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('answers', getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
    want('parent_url', getStringLimitLength(9999), assignToP),
    want('referrer', getStringLimitLength(9999), assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var answers = req.p.answers;
    var info = {};

    var parent_url = req.cookies[COOKIES.PARENT_URL] || req.p.parent_url;
    var referrer = req.cookies[COOKIES.PARENT_REFERRER] || req.p.referrer;

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
});

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
        var hashedPassword  = rows[0].pwhash;
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
    var type = 1; // 1 for email
    winston.log("info","subscribeToNotifications", zid, uid);
    return pgQueryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
        return type;
    });
}

function unsubscribeFromNotifications(zid, uid) {
    var type = 0; // 1 for nothing
    return pgQueryP("update participants set subscribed = ($3) where zid = ($1) and uid = ($2);", [zid, uid, type]).then(function(rows) {
        return type;
    });
}

function getParticipantsThatNeedNotifications() {

    // TODO: currently this will currently err on the side of notifying people for comments that are pending moderator approval.

    // check it out! http://sqlformat.org/
    // var q = "SELECT * ";
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



    // var q = "WITH needed_totals AS  ";
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



var q = "WITH needed_totals AS  ";
q += "  (SELECT zid,  ";
q += "          COALESCE(COUNT(*), 0) AS total ";
q += "   FROM comments  ";
q += "   WHERE MOD >= 0 ";
q += "   GROUP BY zid),  ";
q += "  participant_vote_counts AS (SELECT voted.zid,  ";
q += "          voted.pid,  ";
q += "          COUNT(*) AS valid_votes ";
q += "   FROM  ";
q += "     (SELECT comments.zid,  ";
q += "             comments.tid ";
q += "      FROM comments  ";
q += "      WHERE MOD >= 0) AS needed ";
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
q += "  AND (last_interaction + 30*60*1000) <= now_as_millis() "; // wait 30 minutes after their last interaction
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
    return pgQueryP_readOnly(q,[]);
}


function sendNotificationEmail(uid, url, conversation_id, email, remaining) {
    var subject = "New comments to vote on";
    var body = "There are new comments available for you to vote on here:\n";
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
        winston.log("info","getParticipantsThatNeedNotifications", rows.length);
        winston.log("info",rows);
        rows.forEach(function(row) {
            var url = row.parent_url;
            if (!url) {
                url = "https://pol.is/" + row.zinvite;
            }
            // NOTE: setting the DB status first to prevent a race condition where there can be multiple emails sent (one from each server)
            pgQueryP("update participants set last_notified = now_as_millis() where uid = ($1) and zid = ($2);",[row.uid, row.zid]).then(function() {
                return sendNotificationEmail(row.uid, url, row.zinvite, row.email, row.remaining);
            }).catch(function(err) {
                yell("polis_err_notifying_participants_misc");
                console.error(err);
            });
        });
        winston.log("info","end getParticipantsThatNeedNotifications");
    }).catch(function(err) {
        winston.log("info","error getParticipantsThatNeedNotifications");
        console.error(err);
        // yell("polis_err_notifying_participants");
    });

}

if (!devMode) {
  notifyParticipantsOfNewComments();
  setInterval(function() {
      notifyParticipantsOfNewComments();
  }, 10*60*1000);
}

function updateEmail(uid, email) {
    return pgQueryP("update users set email = ($2) where uid = ($1);", [uid, email]);
}


function createNotificationsUnsubscribeUrl(conversation_id, email) {
    var params = {
        conversation_id: conversation_id,
        email: email
    };
    var path = "api/v3/notifications/unsubscribe";
    params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

    var server = "http://localhost:5000";
    if (!devMode) {
        server = "https://" + process.env.PRIMARY_POLIS_URL;
    }
    return server + "/"+path+"?" + paramsToStringSortedByName(params);
}

function createNotificationsSubscribeUrl(conversation_id, email) {
    var params = {
        conversation_id: conversation_id,
        email: email
    };
    var path = "api/v3/notifications/subscribe";
    params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);

    var server = "http://localhost:5000";
    if (!devMode) {
        server = "https://" + process.env.PRIMARY_POLIS_URL;
    }
    return server + "/"+path+"?" + paramsToStringSortedByName(params);
}



app.get("/api/v3/notifications/subscribe",
    moveToBody,
    need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    need('email', getEmail, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var email = req.p.email;
    var params = {
        conversation_id: req.p.conversation_id,
        email: req.p.email,
    };
    params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
    verifyHmacForQueryParams("api/v3/notifications/subscribe", params).then(function() {
        return pgQueryP("update participants set subscribed = 1 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
            res.set('Content-Type', 'text/html');
            res.send(
                "<h1>Subscribed!</h1>" +
                "<p>" +
                "<a href=\"" + createNotificationsUnsubscribeUrl(req.p.conversation_id, req.p.email) + "\">oops, unsubscribe me.</a>" +
                "</p>"
            );
        });
    }, function() {
        fail(res, 403, "polis_err_subscribe_signature_mismatch");
    }).catch(function(err) {
        fail(res, 500, "polis_err_subscribe_misc", err);
    });
});

app.get("/api/v3/notifications/unsubscribe",
    moveToBody,
    need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    need('email', getEmail, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var email = req.p.email;
    var params = {
        conversation_id: req.p.conversation_id,
        email: req.p.email,
    };
    params[HMAC_SIGNATURE_PARAM_NAME] = req.p[HMAC_SIGNATURE_PARAM_NAME];
    verifyHmacForQueryParams("api/v3/notifications/unsubscribe", params).then(function() {
        return pgQueryP("update participants set subscribed = 0 where uid = (select uid from users where email = ($2)) and zid = ($1);", [zid, email]).then(function() {
            res.set('Content-Type', 'text/html');
            res.send(
                "<h1>Unsubscribed.</h1>" +
                "<p>" +
                "<a href=\"" + createNotificationsSubscribeUrl(req.p.conversation_id, req.p.email) + "\">oops, subscribe me again.</a>" +
                "</p>"
            );
        });
    }, function() {
        fail(res, 403, "polis_err_unsubscribe_signature_mismatch");
    }).catch(function(err) {
        fail(res, 500, "polis_err_unsubscribe_misc", err);
    });
});

app.post("/api/v3/convSubscriptions",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need("type", getInt, assignToP),
    want('email', getEmail, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var type = req.p.type;

    var email = req.p.email;
    function finish(type) {
        res.status(200).json({
            subscribed: type,
        });
    }
    var emailSetPromise = email ? updateEmail(uid, email) : Promise.resolve();
    emailSetPromise.then(function() {
        if (type === 1) {
            subscribeToNotifications(zid, uid).then(finish).catch(function(err) {
                fail(res, 500, "polis_err_sub_conv "+zid+" "+uid, err);
            });
        } else if (type === 0) {
            unsubscribeFromNotifications(zid, uid).then(finish).catch(function(err) {
                fail(res, 500, "polis_err_unsub_conv "+zid+" "+uid, err);
            });
        } else {
            fail(res, 400, "polis_err_bad_subscription_type", new Error("polis_err_bad_subscription_type"));
        }
    }, function(err) {
        fail(res, 500, "polis_err_subscribing_with_email", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_subscribing_misc", err);
    });
});


app.post("/api/v3/auth/login",
    need('password', getPassword, assignToP),
    want('email', getEmail, assignToP),
    want('lti_user_id', getStringLimitLength(1, 9999), assignToP),
    want('lti_user_image', getStringLimitLength(1, 9999), assignToP),
    want('lti_context_id', getStringLimitLength(1, 9999), assignToP),
    want('tool_consumer_instance_guid', getStringLimitLength(1, 9999), assignToP),
    want('afterJoinRedirectUrl', getStringLimitLength(1, 9999), assignToP),
function(req, res) {
    var password = req.p.password;
    var email = req.p.email || "";
    var lti_user_id = req.p.lti_user_id;
    var lti_user_image = req.p.lti_user_image;
    var lti_context_id = req.p.lti_context_id;
    var tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    var afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    email = email.toLowerCase();
    if (!_.isString(password) || !password.length) { fail(res, 403, "polis_err_login_need_password"); return; }
    pgQuery("SELECT * FROM users WHERE LOWER(email) = ($1);", [email], function(err, docs) {
        docs = docs.rows;
        if (err) { fail(res, 403, "polis_err_login_unknown_user_or_password", err); console.error("polis_err_login_unknown_user_or_password_err"); return; }
        if (!docs || docs.length === 0) { fail(res, 403, "polis_err_login_unknown_user_or_password_noresults"); console.error("polis_err_login_unknown_user_or_password_noresults"); return; }

        var uid = docs[0].uid;

        pgQuery("select pwhash from jianiuevyew where uid = ($1);", [uid], function(err, results) {
            results = results.rows;
            if (err) { fail(res, 403, "polis_err_login_unknown_user_or_password", err); console.error("polis_err_login_unknown_user_or_password_err"); return; }
            if (!results || results.length === 0) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_noresults"); return; }

            var hashedPassword  = results[0].pwhash;

            bcrypt.compare(password, hashedPassword, function(errCompare, result) {
                winston.log("info","errCompare, result", errCompare, result);
                if (errCompare || !result) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_badpassword"); return; }

                startSession(uid, function(errSess, token) {
                    var response_data = {
                        uid: uid,
                        email: email,
                        token: token
                    };
                    addCookies(req, res, token, uid).then(function() {
                        winston.log("info","uid", uid);
                        winston.log("info","lti_user_id", lti_user_id);
                        winston.log("info","lti_context_id", lti_context_id);
                        var ltiUserPromise = lti_user_id ?
                            addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) :
                            Promise.resolve();
                        var ltiContextMembershipPromise = lti_context_id ?
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
}); // /api/v3/auth/login




function createLtiUser(email) {
    return pgQueryP("INSERT INTO users (email) VALUES ($1) RETURNING uid;",[email]).then(function(rows) {
        if (!rows || !rows.length) {
            throw new Error("polis_err_create_lti_user");
        }
        return rows[0].uid;
    });
}

app.post("/api/v3/joinWithInvite",
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    wantCookie(COOKIES.PERMANENT_COOKIE, getOptionalStringLimitLength(32), assignToPCustom('permanentCookieToken')),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('answers', getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
    want('referrer', getStringLimitLength(9999), assignToP),
    want('parent_url', getStringLimitLength(9999), assignToP),
function(req, res) {

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
        var uid = o.uid;
        winston.log("info","startSessionAndAddCookies " + uid + " existing " + o.existingAuth);
        // TODO check for possible security implications
        if (!o.existingAuth) {
            return startSessionAndAddCookies(req, res, uid).then(function() {
                return o;
            });
        }
        return Promise.resolve(o);
    })
    .then(function(o) {
        winston.log("info","permanentCookieToken", o.permanentCookieToken);
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
        var pid = o.pid;
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
});


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
              return _.extend(o, suzinviteInfo);
            });
        } else if (o.zid) {
            return o;
        } else {
            throw new Error("polis_err_missing_invite");
        }
    })
    .then(function(o) {
        winston.log("info","joinWithZidOrSuzinvite convinfo begin");
        return getConversationInfo(o.zid).then(function(conv) {
            winston.log("info","joinWithZidOrSuzinvite convinfo done");
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
        winston.log("info","joinWithZidOrSuzinvite userinfo begin");
        if (!o.uid) {
            winston.log("info","joinWithZidOrSuzinvite userinfo nope");
            return o;
        }
        return getUserInfoForUid2(o.uid).then(function(user) {
            winston.log("info","joinWithZidOrSuzinvite userinfo done");
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
          return _.extend(o, {uid: uid});
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
      var info = {};
      if (o.referrer) {
        info.referrer = o.referrer;
      }
      if (o.parent_url) {
        info.parent_url = o.parent_url;
      }
      // TODO_REFERRER add info as third arg
      return joinConversation(o.zid, o.uid, info, o.answers).then(function(ptpt) {
        return _.extend(o, ptpt);
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
        startSession(uid, function(err,token) {
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
    var html = "" +
    "<!DOCTYPE html><html lang='en'>"+
    '<head>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
    '</head>' +
    "<body style='max-width:320px'>"+
            "<p>You are signed in as polis user " + o.email + "</p>" +
            // "<p><a href='https://pol.is/user/logout'>Change pol.is users</a></p>" +
            // "<p><a href='https://preprod.pol.is/inbox/context="+ o.context_id +"'>inbox</a></p>" +
            // "<p><a href='https://preprod.pol.is/2demo' target='_blank'>2demo</a></p>" +
            // "<p><a href='https://preprod.pol.is/conversation/create/context="+ o.context_id +"'>create</a></p>" +

            // form for sign out
            '<p><form role="form" class="FormVertical" action="'+getServerNameWithProtocol(req)+'/api/v3/auth/deregister" method="POST">' +
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

function getUserByEmail(email) {
    return pgQueryP_readOnly("select * from users where email = ($1);", [email]).then(function(rows) {
        if (rows && rows.length) {
            return rows[0];
        } else {
            return null;
        }
    });
}

function deleteFacebookUserRecord(o) {
    if (!isPolisDev(o.uid)) {
        // limit to test accounts for now
        return Promise.reject("polis_err_not_implemented");
    }
    return pgQueryP("delete from facebook_users where uid = ($1);", [o.uid]);
}

function createFacebookUserRecord(o) {
    winston.log("info","createFacebookUserRecord");
    winston.log("info","createFacebookUserRecord", JSON.stringify(o));
    winston.log("info",o);
    winston.log("info","end createFacebookUserRecord");
    var profileInfo = JSON.parse(o.fb_public_profile);
    winston.log("info","createFacebookUserRecord profileInfo");
    winston.log("info",profileInfo);
    winston.log("info","end createFacebookUserRecord profileInfo");
    // Create facebook user record
    return pgQueryP("insert into facebook_users (uid, fb_user_id, fb_name, fb_link, fb_public_profile, fb_login_status, fb_access_token, fb_granted_scopes, fb_location_id, location, fb_friends_response, response) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);", [
        o.uid,
        o.fb_user_id,
        profileInfo.name,
        profileInfo.link,
        o.fb_public_profile,
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
    var profileInfo = JSON.parse(o.fb_public_profile);
    // Create facebook user record
    return pgQueryP("update facebook_users set fb_user_id=($2), fb_name=($3), fb_link=($4), fb_public_profile=($5), fb_login_status=($6), fb_access_token=($7), fb_granted_scopes=($8), fb_location_id=($9), location=($10), fb_friends_response=($11), response=($12) where uid = ($1);", [
        o.uid,
        o.fb_user_id,
        profileInfo.name,
        profileInfo.link,
        o.fb_public_profile,
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
    var fbFriendIds = fb_friends_response.map(function(friend) {
        return friend.id + '';
    }).filter(function(id) {
        // NOTE: would just store facebook IDs as numbers, but they're too big for JS numbers.
        var hasNonNumericalCharacters = /[^0-9]/.test(id);
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
        return pgQueryP("insert into facebook_friends (uid, friend) select ($1), uid from facebook_users where fb_user_id in ("+ fbFriendIds.join(",")+");", [
            uid,
        ]);
    }
}



app.get("/perfStats_9182738127",
    moveToBody,
function(req, res) {
    res.json(METRICS_IN_RAM);
});

function getFirstForPid(votes) {
    var seen = {};
    var len = votes.length;
    var firstVotes = [];
    for (var i = 0; i < len; i++) {
        var vote = votes[i];
        if (!seen[vote.pid]) {
            firstVotes.push(vote);
            seen[vote.pid] = true;
        }
    }
    return firstVotes;
}

app.get("/api/v3/conversationStats",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    isModerator(zid, uid).then(function(is_mod) {
        if (!is_mod) {
            fail(res, 403, "polis_err_conversationStats_need_moderation_permission");
            return;
        }
        return Promise.all([
            pgQueryP_readOnly("select created, pid, mod from comments where zid = ($1) order by created;", [zid]),
            pgQueryP_readOnly("select created, pid from votes where zid = ($1) order by created;", [zid]),
            // pgQueryP_readOnly("select created from participants where zid = ($1) order by created;", [zid]),
            pgQueryP_readOnly("with pidvotes as (select pid, count(*) as countForPid from votes where zid = ($1)"+
                " group by pid order by countForPid desc) select countForPid as n_votes, count(*) as n_ptpts "+
                "from pidvotes group by countForPid order by n_ptpts asc;", [zid]),
            // pgQueryP_readOnly("with all_social as (select uid from facebook_users union select uid from twitter_users), "+
            //     "ptpts as (select created, uid from participants where zid = ($1)) "+
            //     "select ptpts.created from ptpts inner join all_social on ptpts.uid = all_social.uid;", [zid]),
        ]).then(function(a) {
            function castTimestamp(o) {
                o.created = Number(o.created);
                return o;
            }
            var comments = _.map(a[0], castTimestamp);
            var votes = _.map(a[1], castTimestamp);
            // var uniqueHits = _.map(a[2], castTimestamp); // participants table
            var votesHistogram = a[2];
            // var socialUsers = _.map(a[4], castTimestamp);

            var actualParticipants = getFirstForPid(votes);  // since an agree vote is submitted for each comment's author, this includes people who only wrote a comment, but didn't explicitly vote.
            actualParticipants = _.pluck(actualParticipants, "created");
            var commenters = getFirstForPid(comments);
            commenters = _.pluck(commenters, "created");


            var totalComments = _.pluck(comments, "created");
            var totalVotes = _.pluck(votes, "created");
            // var viewTimes = _.pluck(uniqueHits, "created");
            // var totalSocialUsers = _.pluck(socialUsers, "created");

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
                // socialUsers: totalSocialUsers,
            });
        });

    }).catch(function(err) {
        fail(res, 500, "polis_err_conversationStats_misc", err);
    });
});


app.get("/snapshot",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;

    if (isPolisDev(uid)) {
        // is polis developer
    } else {
        fail(res, 403, "polis_err_permissions");
    }

    pgQuery(
        "insert into conversations (topic, description, link_url, owner, modified, created, participant_count) "+
        "(select '(SNAPSHOT) ' || topic, description, link_url, $2, now_as_millis(), created, participant_count from conversations where zid = $1) returning *;", [
        zid,
        uid,
    ], function(err, result) {
        if (err) {
            fail(res, 500, "polis_err_cloning_conversation", err);
        }
        // winston.log("info",rows);
        var conv = result.rows[0];

        // var conv = rows[0];
        var newZid = conv.zid;
        return pgQueryP(
            "insert into participants (pid, zid, uid, created) "+
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
                    "insert into votes (pid, tid, zid, vote, created) "+
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
});

// this endpoint isn't really ready for general use
app.get("/api/v3/facebook/delete",
    moveToBody,
    auth(assignToP),
function(req, res) {
    deleteFacebookUserRecord(req.p).then(function() {
        res.json({});
    }).catch(function(err) {
        fail(res, 500, err);
    });
});

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

function(req, res) {

    // If a pol.is user record exists, and someone logs in with a facebook account that has the same email address, we should bind that facebook account to the pol.is account, and let the user sign in.
    var TRUST_FB_TO_VALIDATE_EMAIL = false;

    var response = JSON.parse(req.p.response);
    var fb_public_profile = req.p.fb_public_profile;
    var fb_user_id = response.authResponse.userID;
    var fb_login_status = response.status;
    // var fb_auth_response = response.authResponse.
    var fb_access_token = response.authResponse.accessToken;
    var fb_email = req.p.fb_email;
    var provided_email = req.p.provided_email;
    var email = fb_email || provided_email;
    var existingUid = req.p.existingUid;
    var hname = req.p.hname;
    var referrer = req.cookies[COOKIES.REFERRER];
    var password = req.p.password;
    var uid = req.p.uid;

    var fb_friends_response = req.p.fb_friends_response ? JSON.parse(req.p.fb_friends_response) : null;

    var shouldAddToIntercom = true;
    if (req.p.conversation_id) {
        shouldAddToIntercom = false;
    }

    var fbUserRecord = {
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

    // if signed in:
    //  why are we showing them the button then? we should probably just start a new session.

    pgQueryP("select users.*, facebook_users.fb_user_id from users left join facebook_users on users.uid = facebook_users.uid where users.email = ($1);", [email]).then(function(rows) {
        var user = rows && rows.length && rows[0] || null;
        if (user) {
            if (user.fb_user_id) {
                // user has FB account linked
                if (user.fb_user_id === fb_user_id) {

                    updateFacebookUserRecord(_.extend({}, {
                        uid: user.uid
                    }, fbUserRecord)).then(function() {
                        var friendsAddedPromise = fb_friends_response ? addFacebookFriends(user.uid, fb_friends_response) : Promise.resolve();
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
                    // ruh roh..  probably rare
                    fail(res, 500, "polis_err_reg_fb_user_exists_with_different_account");
                    emailBadProblemTime("facebook auth where user exists with different facebook account " + user.uid);
                }
            } else {
                // user for this email exists, but does not have FB account linked.
                    // user will be prompted for their password, and client will repeat the call with password
                        // fail(res, 409, "polis_err_reg_user_exits_with_email_but_has_no_facebook_linked")
                if (!TRUST_FB_TO_VALIDATE_EMAIL && !password) {
                    fail(res, 403, "polis_err_user_with_this_email_exists " + email);
                } else {
                    var pwPromise = TRUST_FB_TO_VALIDATE_EMAIL ? Promise.resolve(true) : checkPassword(user.uid, password||"");
                    pwPromise.then(function(ok) {
                        if (ok) {
                            createFacebookUserRecord(_.extend({}, {
                                uid: user.uid
                            }, fbUserRecord)).then(function() {
                                var friendsAddedPromise = fb_friends_response ? addFacebookFriends(user.uid, fb_friends_response) : Promise.resolve();
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
                                        // token: token
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
            }
        } else {
            // no polis user with that email exists yet.
            // ok, so create a user with all the info we have and link to the fb info table


            var promise;
            if (uid) {

                winston.log("info","fb1 5a...");

                // user record already exists, so populate that in case it has missing info
                promise = Promise.all([
                    pgQueryP("select * from users where uid = ($1);", [uid]),
                    pgQueryP("update users set hname = ($2) where uid = ($1) and hname is NULL;",[uid, hname]),
                    pgQueryP("update users set email = ($2) where uid = ($1) and email is NULL;",[uid, email]),
                ]).then(function(o) {
                    var user = o[0][0];
                    winston.log("info","fb1 5a");
                    winston.log("info",user);
                    winston.log("info","end fb1 5a");
                    return user;
                });
                winston.log("info","fb1 5a....");
            } else {

                winston.log("info","fb1 5b...");

                var query = "insert into users " +
                    "(email, hname) VALUES "+
                    "($1, $2) "+
                    "returning *;";
                promise = pgQueryP(query, [email, hname])
                .then(function(rows) {
                    var user = rows && rows.length && rows[0] || null;
                    winston.log("info","fb1 5b");
                    winston.log("info",user);
                    winston.log("info","end fb1 5b");
                    return user;
                });
            }
            // Create user record
            promise
            .then(function(user) {

                winston.log("info","fb1 4");
                winston.log("info",user);
                winston.log("info","end fb1 4");
                return createFacebookUserRecord(_.extend({}, user, fbUserRecord)).then(function() {
                    return user;
                });
            })
            .then(function(user) {
                winston.log("info","fb1 3");
                winston.log("info",user);
                winston.log("info","end fb1 3");
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
                winston.log("info","fb1 2");
                winston.log("info",user);
                winston.log("info","end fb1 2");
                var uid = user.uid;
                return startSessionAndAddCookies(req, res, uid).then(function() {
                    return user;
                }, function(err) {
                    fail(res, 500, "polis_err_reg_fb_user_creating_record3", err);
                });
            }, function(err) {
                fail(res, 500, "polis_err_reg_fb_user_creating_record", err);
            })
            .then(function(user) {
                winston.log("info","fb1");
                winston.log("info",user);
                winston.log("info","end fb1");
                res.json({
                    uid: user.uid,
                    hname: user.hname,
                    email: user.email,
                    // token: token
                });
                if (shouldAddToIntercom) {
                    var params = {
                        "email" : user.email,
                        "name" : user.hname,
                        "user_id": user.uid,
                    };
                    var customData = {};
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
                            winston.log("info",err);
                            console.error("polis_err_intercom_create_user_fb_fail");
                            winston.log("info",params);
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
        }
    }, function(err) {
        fail(res, 500, "polis_err_reg_fb_user_looking_up_email", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_reg_fb_user_misc", err);
    });

/*

    THOUGHTS: will FB auth work everywhere we need it to? within iframes (seems so)..  in webviews? not sure.


*/

});

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
function(req, res) {
    var hname = req.p.hname;
    var password = req.p.password;
    var password2 = req.p.password2; // for verification
    var email = req.p.email;
    var oinvite = req.p.oinvite;
    var zinvite = req.p.zinvite;
    var referrer = req.cookies[COOKIES.REFERRER];
    var organization = req.p.organization;
    var gatekeeperTosPrivacy = req.p.gatekeeperTosPrivacy;
    var lti_user_id = req.p.lti_user_id;
    var lti_user_image = req.p.lti_user_image;
    var lti_context_id = req.p.lti_context_id;
    var tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    var afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    var site_id = void 0;
    if (req.p.encodedParams) {
        var decodedParams = decodeParams(req.p.encodedParams);
        if (decodedParams.site_id) {
            // NOTE: we could have just allowed site_id to be passed as a normal param, but then we'd need to think about securing that with some other token sooner.
            // I think we can get by with this obscure scheme for a bit.
            // TODO_SECURITY add the extra token associated with the site_id owner.
            site_id = decodedParams.site_id;
        }
    }

    var shouldAddToIntercom = true;
    if (req.p.lti_user_id) {
        shouldAddToIntercom = false;
    }

    if (password2 && (password !== password2)) { fail(res, 400, "Passwords do not match."); return; }
    if (!gatekeeperTosPrivacy) { fail(res, 400, "polis_err_reg_need_tos"); return; }
    if (!email) { fail(res, 400, "polis_err_reg_need_email"); return; }
    if (!hname) { fail(res, 400, "polis_err_reg_need_name"); return; }
    if (!password) { fail(res, 400, "polis_err_reg_password"); return; }
    if (password.length < 6) { fail(res, 400, "polis_err_reg_password_too_short"); return; }
    if (!_.contains(email, "@") || email.length < 3) { fail(res, 400, "polis_err_reg_bad_email"); return; }

    pgQueryP("SELECT * FROM users WHERE email = ($1)", [email]).then(function(rows) {

            if (rows.length > 0) {
                fail(res, 403, "polis_err_reg_user_with_that_email_exists");
                return;
            }

            generateHashedPassword(password, function(err, hashedPassword) {
                if (err) { fail(res, 500, "polis_err_generating_hash", err); return; }
                    var query = "insert into users " +
                        "(email, hname, zinvite, oinvite, is_owner" + (site_id? ", site_id":"")+") VALUES "+ // TODO use sql query builder
                        "($1, $2, $3, $4, $5"+ (site_id?", $6":"")+") "+ // TODO use sql query builder
                        "returning uid;";
                    var vals =
                        [email, hname, zinvite||null, oinvite||null, true];
                    if (site_id) {
                        vals.push(site_id); // TODO use sql query builder
                    }

                    pgQuery(query, vals, function(err, result) {
                        if (err) { winston.log("info",err); fail(res, 500, "polis_err_reg_failed_to_add_user_record", err); return; }
                        var uid = result && result.rows && result.rows[0] && result.rows[0].uid;

                        pgQuery("insert into jianiuevyew (uid, pwhash) values ($1, $2);", [uid, hashedPassword], function(err, results) {
                            if (err) { winston.log("info",err); fail(res, 500, "polis_err_reg_failed_to_add_user_record", err); return; }


                            startSession(uid, function(err,token) {
                              if (err) { fail(res, 500, "polis_err_reg_failed_to_start_session", err); return; }
                              addCookies(req, res, token, uid).then(function() {

                                var ltiUserPromise = lti_user_id ?
                                  addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) :
                                  Promise.resolve();
                                var ltiContextMembershipPromise = lti_context_id ?
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
                                    var params = {
                                        "email" : email,
                                        "name" : hname,
                                        "user_id": uid,
                                    };
                                    var customData = {};
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
                                            winston.log("info",err);
                                            console.error("polis_err_intercom_create_user_fail");
                                            winston.log("info",params);
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
}); // end /api/v3/auth/new

app.post("/api/v3/tutorial",
    auth(assignToP),
    need("step", getInt, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var step = req.p.step;
    pgQueryP("update users set tut = ($1) where uid = ($2);", [step, uid]).then(function() {
        res.status(200).json({});
    }).catch(function(err) {
        fail(res, 500, "polis_err_saving_tutorial_state", err);
    });
});



app.get("/api/v3/users",
    moveToBody,
    want("errIfNoAuth", getBool, assignToP),
    authOptional(assignToP),
function(req, res) {
    var uid = req.p.uid;

    if (req.p.errIfNoAuth && !uid) {
        fail(res, 401, "polis_error_auth_needed", err);
        return;
    }

    getUser(uid).then(function(user) {
        res.status(200).json(user);
    }, function(err) {
        fail(res, 500, "polis_err_getting_user_info2", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_getting_user_info", err);
    });
});

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
        var info = o[0];
        var fbInfo = o[1];
        var twInfo = o[2];

        var hasFacebook = fbInfo && fbInfo.length && fbInfo[0];
        var hasTwitter = twInfo && twInfo.length && twInfo[0];
        if (hasFacebook) {
            var width = 40;
            var height = 40;
            fbInfo.fb_picture = "https://graph.facebook.com/v2.2/"+ fbInfo.fb_user_id +"/picture?width="+width+"&height=" + height;
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
            plan: planCodeToPlanName[info.plan],
            planCode: info.plan,
        };
    });
}

// These map from non-ui string codes to number codes used in the DB
// The string representation ("sites", etc) is also used in intercom.
var planCodes = {
    mike: 9999,
    trial: 0,
    individuals: 1,
    students: 2,
    pp: 3,
    sites: 100,
    organizations: 1000,
};

// These are for customer to see in UI
var planCodeToPlanName = {
    9999: "MikePlan",
    0: "Trial",
    1: "Individual",
    2: "Student",
    3: "Participants Pay",
    100: "Site",
    1000: "Organization",
};


function changePlan(uid, planCode) {
    return new Promise(function(resolve, reject) {
        pgQuery("update users set plan = ($1) where uid = ($2);", [planCode, uid], function(err, results) {
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
            "custom_data" : {
                "plan_code" : planCode,
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
          plan: planId
        },  function(err, subscription) {
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

        return createStripeSubscription(customer.id, plan).then(function(subscription) {
            // done with stripe part
        });
    });
}

// use this to generate coupons for free upgrades
app.get("/api/v3/createPlanChangeCoupon_aiudhfaiodufy78sadtfiasdf",
    moveToBody,
    need('uid', getInt, assignToP),
    need('planCode', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var uid = req.p.uid;
    var planCode = req.p.planCode;
    generateTokenP(30, false).then(function(code) {
        return pgQueryP("insert into coupons_for_free_upgrades (uid, code, plan) values ($1, $2, $3) returning *;",[uid, code, planCode]).then(function(rows) {
            var row = rows[0];
            row.url = "https://pol.is/api/v3/changePlanWithCoupon?code=" + row.code;
            res.status(200).json(row);
        }).catch(function(err) {
            fail(res, 500, "polis_err_creating_coupon", err);
        });
    }).catch(function(err) {
        fail(res, 500, "polis_err_creating_coupon_code", err);
    });
});

app.get("/api/v3/changePlanWithCoupon",
    moveToBody,
    authOptional(assignToP),
    need('code', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
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
        updatePlan(req, res, info.uid, info.plan, isCurrentUser);
    }).catch(function(err) {
        emailBadProblemTime("changePlanWithCoupon failed");
        fail(res, 500, "polis_err_changing_plan_with_coupon", err);
    });
});

function getCouponInfo(couponCode) {
    return pgQueryP("select * from coupons_for_free_upgrades where code = ($1);", [couponCode]);
}


function updatePlan(req, res, uid, planCode, isCurrentUser) {
    winston.log("info",'updatePlan', uid, planCode);
    setUsersPlanInIntercom(uid, planCode).catch(function(err) {
        emailBadProblemTime("User " + uid + " changed their plan, but we failed to update Intercom");
    });

    // update DB and finish
    changePlan(uid, planCode).then(function() {
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
            if (planCode === 1000) {
                path = "/settings/enterprise";
            }
            res.writeHead(302, {
                Location: protocol + "://" + req.headers.host + path
            });
            return res.end();
        } else {
            res.status(200).json({status: "upgraded!"});
        }
    }).catch(function(err) {
        emailBadProblemTime("User changed their plan, but we failed to update the DB.");
        fail(res, 500, "polis_err_changing_plan", err);
    });
}


// Just for testing that the new custom stripe form is submitting properly
app.post("/api/v3/post_payment_form",
function(req, res) {
  winston.log("info","XXX - Got the params!");
  winston.log("info","XXX - Got the params!" + res);
});


app.post("/api/v3/charge",
    auth(assignToP),
    want('stripeToken', getOptionalStringLimitLength(999), assignToP),
    want('stripeEmail', getOptionalStringLimitLength(999), assignToP),
    need('plan', getOptionalStringLimitLength(999), assignToP),
function(req, res) {

    var stripeToken = req.p.stripeToken;
    var stripeEmail = req.p.stripeEmail;
    var uid = req.p.uid;
    var plan = req.p.plan;
    var planCode = planCodes[plan];

    var prices = {
        mike: 50,
        individuals: 100 * 100,
        sites: 1000 * 100,
        organizations: 300 * 100, // TODO parameterize
        students: 3 * 100,
        // pp: 0, // not sent to stripe
    };

    if (plan !== "pp") {
        if(!stripeToken) {
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
        updatePlan(req, res, uid, planCode, true);
    }).catch(function(err) {
        if (err) {
            if (err.type === 'StripeCardError') {
                return fail(res, 500, "polis_err_stripe_card_declined", err);
            } else {
                return fail(res, 500, "polis_err_stripe", err);
            }
        }
    });
});

function _getCommentsForModerationList(o) {
    var modClause = _.isUndefined(o.mod) ? "" : " and comments.mod = ($2)";
    return pgQueryP_metered_readOnly("_getCommentsForModerationList", "select * from (select tid, count(*) from votes where zid = ($1) group by tid) as foo full outer join comments on foo.tid = comments.tid where comments.zid = ($1)" + modClause, [o.zid, o.mod]);
}

function _getCommentsList(o) {
    return new MPromise("_getCommentsList", function(resolve, reject) {
      getConversationInfo(o.zid).then(function(conv) {

        var q = sql_comments.select(sql_comments.star())
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
    var commentListPromise = o.moderation ? _getCommentsForModerationList(o) : _getCommentsList(o);

    return commentListPromise.then(function(rows) {
        var cols = [
            "txt",
            "tid",
            "created",
            "uid",
            "tweet_id",
            "quote_src_url",
            "anon",
        ];
        if (o.moderation) {
            cols.push("velocity");
            cols.push("zid");
            cols.push("mod");
            cols.push("active");
            cols.push("count"); //  in  moderation queries, we join in the vote count
        }
        rows = rows.map(function(row) {
            var x = _.pick(row, cols);
            if (!_.isUndefined(x.count)) {
                x.count = Number(x.count);
            }
            return x;
        });
        return rows;
    }).then(function(comments) {
        if (o.include_social) {
            var nonAnonComments = comments.filter(function(c) {
                return !c.anon;
            });
            var uids = _.pluck(nonAnonComments, "uid");
            return getSocialInforForUsers(uids).then(function(socialInfos) {
                var uidToSocialInfo = {};
                socialInfos.forEach(function(info) {
                    // whitelist properties to send
                    var infoToReturn = _.pick(info, [
                        // fb
                        "fb_name",
                        "fb_link",
                        "fb_user_id",
                        // twitter
                        "name",
                        "screen_name",
                        "twitter_user_id",
                        "profile_image_url_https",
                    ]);
                    infoToReturn.tw_verified = !!info.verified;
                    if (!_.isUndefined(infoToReturn.fb_user_id)) {
                        var width = 40;
                        var height = 40;
                        infoToReturn.fb_picture = "https://graph.facebook.com/v2.2/"+ infoToReturn.fb_user_id +"/picture?width="+width+"&height=" + height;
                    }

                    uidToSocialInfo[info.uid] = infoToReturn;
                });
                return comments.map(function(c) {
                    var s = uidToSocialInfo[c.uid];
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


app.get("/api/v3/participation",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('strict', getBool, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var strict = req.p.strict;
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
            var voteCountRows = o[0];
            var commentCountRows = o[1];
            var pidXidRows = o[2];
            var i, r;

            if (strict && !pidXidRows.length) {
                fail(res, 409, "polis_err_get_participation_missing_xids This conversation has no xids for its participants.");
                return;
            }

            // Build a map like this {xid -> {votes: 10, comments: 2}}
            var result = new DD(function() {
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

            // Convert from {pid -> foo} to {xid -> foo}
            var pidToXid = {};
            for (i = 0; i < pidXidRows.length; i++) {
                pidToXid[pidXidRows[i].pid] = pidXidRows[i].xid;
            }
            var xidBasedResult = {};
            var size = 0;
            _.each(result, function(val, key) {
                xidBasedResult[pidToXid[key]] = val;
                size += 1;
            });

            if (strict && (commentCountRows.length || voteCountRows.length) && size > 0) {
                fail(res, 409, "polis_err_get_participation_missing_xids This conversation is missing xids for some of its participants.");
                return;
            }
            res.status(200).json(xidBasedResult);
        });
    }).catch(function(err) {
        fail(res, 500, "polis_err_get_participation_misc", err);
    });
});



app.get("/api/v3/comments",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('tids', getArrayOfInt, assignToP),
    want('moderation', getBool, assignToP),
    want('mod', getInt, assignToP),
    want('include_social', getBool, assignToP),
//    need('lastServerToken', _.identity, assignToP),
    resolve_pidThing('not_voted_by_pid', assignToP, "get:comments:not_voted_by_pid"),
    resolve_pidThing('pid', assignToP, "get:comments:pid"),
function(req, res) {
    var zid = req.p.zid;
    var tids = req.p.tids;
    var pid = req.p.pid;
    var not_voted_by_pid = req.p.not_voted_by_pid;
    var mod = req.p.mod;

    var rid = req.headers["x-request-id"] + " " + req.headers['user-agent'];
    winston.log("info","getComments " + rid + " begin");

    getComments(req.p).then(function(comments) {

        comments = comments.map(function(c) {
            var hasTwitter = c.social && c.social.twitter_user_id;
            if (hasTwitter) {
               c.social.twitter_profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + c.social.twitter_user_id;
            }
            var hasFacebook = c.social && c.social.fb_user_id;
            if (hasFacebook) {
                var width = 40;
                var height = 40;
                c.social.fb_picture = "https://graph.facebook.com/v2.2/"+ c.social.fb_user_id +"/picture?width="+width+"&height=" + height;
            }
            return c;
        });

        finishArray(res, comments);
    }).catch(function(err) {
        winston.log("info","getComments " + rid + " failed");
        fail(res, 500, "polis_err_get_comments", err);
    });
}); // end GET /api/v3/comments


function isDuplicateKey(err) {
    var isdup = err.code === 23505 ||
        err.code === '23505' ||
        err.sqlState === 23505 ||
        err.sqlState === '23505' ||
        (err.messagePrimary && err.messagePrimary.indexOf("duplicate key value") >= 0)
    ;
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
                var count = result && result.rows && result.rows[0] && result.rows[0].count;
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
    var body = unmoderatedCommentCount;
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
        return sendEmailByUid(uid, "Waiting for review (conversation " + zinvite + ")", body);
    }).catch(function(err) {
        console.error(err);
    });
}

function createProdModerationUrl(zinvite) {
    return "https://pol.is/m/" + zinvite;
}

function createModerationUrl(req, zinvite) {
    var server = devMode ? "http://localhost:5000" : "https://pol.is";

    if (req.headers.host.indexOf("preprod.pol.is") >= 0) {
        server = "https://preprod.pol.is";
    }
    var url = server + "/m/"+zinvite;
    return url;
}

// function createMuteUrl(zid, tid) {
//     var server = devMode ? "http://localhost:5000" : "https://pol.is";
//     var params = {
//         zid: zid,
//         tid: tid
//     };
//     var path = "v3/mute";
//     params[HMAC_SIGNATURE_PARAM_NAME] = createHmacForQueryParams(path, params);
//     return server + "/"+path+"?" + paramsToStringSortedByName(params);
// }

// function createUnmuteUrl(zid, tid) {
//     var server = devMode ? "http://localhost:5000" : "https://pol.is";
//     var params = {
//         zid: zid,
//         tid: tid
//     };
//     var path = "v3/unmute";
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
//     var mod = polisTypes.mod.ban;
//     return moderateComment(zid, tid, false, mod);
// }
// function unmuteComment(zid, tid) {
//     var mod = polisTypes.mod.ok;
//     return moderateComment(zid, tid, true, mod);
// }

function getComment(zid, tid) {
    return new MPromise("getComment", function(resolve, reject) {
        pgQuery("select * from comments where zid = ($1) and tid = ($2);", [zid, tid], function(err, results) {
            if (err) {
                reject(err);
            } else if (!results || !results.rows || !results.rows.length) {
                reject("polis_err_missing_comment");
            } else {
                resolve(results.rows[0]);
            }
        });
    });
}


// // NOTE: using GET so it can be hit from an email URL.
// app.get("/api/v3/mute",
//     moveToBody,
//     // NOTE: no auth. We're relying on the signature. These URLs will be sent to conversation moderators.
//     need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
//     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
//     need('tid', getInt, assignToP),
// function(req, res) {
//     var tid = req.p.tid;
//     var zid = req.p.zid;
//     var params = {
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
// });

// // NOTE: using GET so it can be hit from an email URL.
// app.get("/api/v3/unmute",
//     moveToBody,
//     // NOTE: no auth. We're relying on the signature. These URLs will be sent to conversation moderators.
//     need(HMAC_SIGNATURE_PARAM_NAME, getStringLimitLength(10, 999), assignToP),
//     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
//     need('tid', getInt, assignToP),
// function(req, res) {
//     var tid = req.p.tid;
//     var zid = req.p.zid;
//     var params = {
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
// });


function hasBadWords(txt) {
    txt = txt.toLowerCase();
    var tokens = txt.split(" ");
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



// TODO probably need to add a retry mechanism like on joinConversation to handle possibility of duplicate tid race-condition exception
app.post("/api/v3/comments",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('txt', getOptionalStringLimitLength(997), assignToP),
    want('vote', getIntInRange(-1, 1), assignToP, -1), // default to agree
    want('prepop', getBool, assignToP),
    want("twitter_tweet_id", getStringLimitLength(999), assignToP),
    want("quote_twitter_screen_name", getStringLimitLength(999), assignToP),
    want("quote_txt", getStringLimitLength(999), assignToP),
    want("quote_src_url", getStringLimitLength(999), assignToP), // TODO_SECURITY make sure this is a normal URL with no weird javascript injection or anything in it.
    want("anon", getBool, assignToP),
    resolve_pidThing('pid', assignToP, "post:comments"),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var txt = req.p.txt;
    var pid = req.p.pid; // PID_FLOW may be undefined
    var currentPid = pid;
    var vote = req.p.vote;
    var prepopulating = req.p.prepop;
    var twitter_tweet_id = req.p.twitter_tweet_id;
    var quote_twitter_screen_name = req.p.quote_twitter_screen_name;
    var quote_txt = req.p.quote_txt;
    var quote_src_url = req.p.quote_src_url;
    var anon = req.p.anon;
    var mustBeModerator = !!quote_txt || !!twitter_tweet_id || anon;


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
            return addParticipant(req.p.zid, req.p.uid).then(function(rows) {
                var ptpt = rows[0];
                pid = ptpt.pid;
                currentPid = pid;
                return pid;
            });
        }
        return Promise.resolve(pid);
    }


    var twitterPrepPromise = Promise.resolve();
    if (twitter_tweet_id) {
        twitterPrepPromise = prepForTwitterComment(twitter_tweet_id, zid);
    } else if (quote_twitter_screen_name) {
        twitterPrepPromise = prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid);
    }

    twitterPrepPromise.then(function(info) {

      var ptpt = info && info.ptpt;
      var twitterUser = info && info.twitterUser;
      var tweet = info && info.tweet;

      if (tweet) {
        txt = tweet.text;
      } else if (quote_txt) {
        txt = quote_txt;
      }

      var ip =
        req.headers['x-forwarded-for'] ||  // TODO This header may contain multiple IP addresses. Which should we report?
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;

      var isSpamPromise = isSpam({
        comment_content: txt,
        comment_author: uid,
        permalink: 'https://pol.is/' + zid,
        user_ip: ip,
        user_agent: req.headers['user-agent'],
        referrer: req.headers.referer,
      });
      isSpamPromise.catch(function(err) {
        console.error("isSpam failed");
        winston.log("info",err);
      });
      // var isSpamPromise = Promise.resolve(false);
      var isModeratorPromise = isModerator(zid, uid);

      var conversationInfoPromise = getConversationInfo(zid);

      var pidPromise;
      if (ptpt) {
        pidPromise = Promise.resolve(ptpt.pid);
      } else {
        pidPromise = doGetPid();
      }
      var commentExistsPromise = commentExists(zid, txt);

      Promise.all([pidPromise, conversationInfoPromise, isModeratorPromise, commentExistsPromise]).then(function(results) {
        var pid = results[0];
        var conv = results[1];
        var is_moderator = results[2];
        var commentExists = results[3];

        if (!is_moderator && mustBeModerator) {
            fail(res, 403, "polis_err_post_comment_auth", err);
            return;
        }

        if (pid < 0) {
            // NOTE: this API should not be called in /demo mode
            fail(res, 500, "polis_err_post_comment_bad_pid");
            return;
        }

        if (commentExists) {
            fail(res, 409, "polis_err_post_comment_duplicate", err);
            return;
        }

        if (!conv.is_active) {
            fail(res, 403, "polis_err_conversation_is_closed", err);
            return;
        }

        var bad = hasBadWords(txt);
        isSpamPromise.then(function(spammy) {
            winston.log("info","spam test says: " + txt + " " + (spammy?"spammy":"not_spammy"));
            return spammy;
        }, function(err) {
            console.error("spam check failed");
            winston.log("info",err);
            return false; // spam check failed, continue assuming "not spammy".
        }).then(function(spammy) {
            var velocity = 1;
            var active = true;
            var classifications = [];
            if (bad && conv.profanity_filter) {
                active = false;
                classifications.push("bad");
            }
            if (spammy && conv.spam_filter) {
                active = false;
                classifications.push("spammy");
            }
            if (conv.strict_moderation) {
                active = false;
            }

            var mod = 0; // hasn't yet been moderated.

            // moderators' comments are automatically in (when prepopulating).
            if (is_moderator && prepopulating) {
                mod = polisTypes.mod.ok;
                active = true;
            }
            var authorUid = ptpt ? ptpt.uid : uid;

            pgQuery(
                "INSERT INTO COMMENTS "+
                  "(pid, zid, txt, velocity, active, mod, uid, tweet_id, quote_src_url, anon, created, tid) VALUES "+
                  "($1,   $2,  $3,       $4,     $5,  $6, $7,  $8,       $9,            $10,  default, null) RETURNING tid, created;",
                   [pid, zid, txt, velocity, active, mod, authorUid, twitter_tweet_id||null, quote_src_url||null, anon||false],

                function(err, docs) {
                    if (err) {
                        winston.log("info",err);
                        if (err.code === '23505' || err.code === 23505) {
                            // duplicate comment
                            fail(res, 409, "polis_err_post_comment_duplicate", err);
                        } else {
                            fail(res, 500, "polis_err_post_comment", err);
                        }
                        return;
                    }
                    docs = docs.rows;
                    var tid = docs && docs[0] && docs[0].tid;
                    var createdTime = docs && docs[0] && docs[0].created;

                    if (bad || spammy || conv.strict_moderation) {
                        getNumberOfCommentsWithModerationStatus(zid, polisTypes.mod.unmoderated).catch(function(err) {
                            yell("polis_err_getting_modstatus_comment_count");
                            return void 0;
                        }).then(function(n) {

                            pgQueryP_readOnly("select * from users where site_id = (select site_id from page_ids where zid = ($1)) UNION select * from users where uid = ($2);", [zid, conv.owner]).then(function(users) {
                                var uids = _.pluck(users, "uid");
                                // also notify polis team for moderation
                                uids = _.union(uids, [
                                    125, // mike
                                    186, // colin
                                    36140, // chris
                                ]);
                                uids.forEach(function(uid) {
                                    sendCommentModerationEmail(req, uid, zid, n);
                                });
                            });
                        });
                    } else {
                        sendCommentModerationEmail(req, 125, zid, "?"); // email mike for all comments, since some people may not have turned on strict moderation, and we may want to babysit evaluation conversations of important customers.
                    }

                    votesPost(pid, zid, tid, vote).then(function() {

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
        if (errors[0]) { fail(res, 500, "polis_err_getting_pid", errors[0]); return; }
        if (errors[1]) { fail(res, 500, "polis_err_getting_conv_info", errors[1]); return; }
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
                        ////votesPost(pid, zid, tid, [autoPull]);
                      //}); // COMMIT
                    //}); // INSERT
                //}); // SET CONSTRAINTS
              ////}); // nextTick
        //}); // BEGIN
}); // end POST /api/v3/comments

app.get("/api/v3/votes/me",
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
        if (err || pid < 0) { fail(res, 500, "polis_err_getting_pid", err); return; }
        pgQuery_readOnly("SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);", [req.p.zid, req.p.pid], function(err, docs) {
            if (err) { fail(res, 500, "polis_err_get_votes_by_me", err); return; }
            finishArray(res, docs.rows);
        });
    });
});


function getVotesForZidPids(zid, pids, callback) {

    var query = sql_votes.select(sql_votes.star())
        .where(
            sql_votes.zid.equals(zid)
        ).and(
            sql_votes.vote.notEquals(0) // ignore passes
        );
    // allow empty queries to return all votes.... (TODO think about scale!)
    if (pids && pids.length) {
        query = query.and(
            sql_votes.pid.in(pids)
        );
    }

    pgQuery_readOnly(query.toString(), function(err, results) {
        if (err) { return callback(err); }
        callback(null, results.rows);
    });
}


function getCommentIdCounts(voteRecords) {
    var votes = voteRecords;
    var commentIdCountMap = {};
    // TODO account for duplicate votes (where the current value is
    for (var i = 0; i < votes.length; i++) {
        var vote = votes[i];
        var count = commentIdCountMap[vote.tid];
        if (vote.vote === polisTypes.reactions.pull) {
            commentIdCountMap[vote.tid] = count + 1 || 1;
        } else if (vote.vote === polisTypes.reactions.push) {
            // push
            commentIdCountMap[vote.tid] = count - 1 || -1;
        } else {
            console.error("expected just push and pull in query");
        }
    }
    // create array of pairs [[commentId, count],...]
    var commentIdCounts = _.pairs(commentIdCountMap);
    // remove net negative items
    commentIdCounts = commentIdCounts.filter(function(c) { return Number(c[1]) > 0; });
    // remove net negative items ????
    commentIdCounts.forEach(function(c) { c[0].txt += c[1]; });
    commentIdCounts.sort(function(a,b) {
        return b[1] - a[1]; // descending by freq
    });
    return commentIdCounts;
}

// // TODO Since we know what is selected, we also know what is not selected. So server can compute the ratio of support for a comment inside and outside the selection, and if the ratio is higher inside, rank those higher.
// app.get("/api/v3/selection",
//     moveToBody,
//     want('users', getArrayOfInt, assignToP),
//     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
// function(req, res) {
//         var zid = req.p.zid;
//         var users = req.p.users || [];

//         getVotesForZidPids(zid, users, function(err, voteRecords) {
//             if (err) { fail(res, 500, "polis_err_get_selection", err); return; }
//             if (!voteRecords.length) { fail(res, 500, "polis_err_get_selection_no_votes"); return; }

//             var commentIdCounts = getCommentIdCounts(voteRecords);
//             commentIdCounts = commentIdCounts.slice(0, 10);
//             var commentIdsOrdering = commentIdCounts.map(function(x) { return {tid: x[0]};});
//             var commentIds = commentIdCounts.map(function(x) { return x[0];});

//             var queryForSelectedComments = sql_comments.select(sql_comments.star())
//                 .where(sql_comments.zid.equals(zid))
//                 .and(sql_comments.tid.in(commentIds));
//             pgQuery(queryForSelectedComments.toString(), function(err, results) {
//                 if (err) { fail(res, 500, "polis_err_get_selection_comments", err); return; }
//                 var comments = results.rows;
//                 // map the results onto the commentIds list, which has the right ordering
//                 comments = orderLike(comments, commentIdsOrdering, "tid"); // TODO fix and test the extra declaration of comments
//                 for (var i = 0; i < comments.length; i++) {
//                     comments[i].freq = i;
//                 }

//                 comments.sort(function(a, b) {
//                     // desc sort primarily on frequency(ascending), then on recency
//                     if (b.freq > a.freq) {
//                         return -1;
//                     } else if (b.freq < a.freq) {
//                         return 1;
//                     } else {
//                         return b.created > a.created;
//                     }
//                 });
//                 finishArray(res, comments);
//             }); // end comments query
//         }); // end votes query
//     }); // end GET selection


app.get("/api/v3/votes",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('tid', getInt, assignToP),
    resolve_pidThing('pid', assignToP, "get:votes"),
function(req, res) {
    getVotesForSingleParticipant(req.p).then(function(votes) {
        finishArray(res, votes);
    }, function(err) {
        fail(res, 500, "polis_err_votes_get", err);
    });
});

function getNextCommentRandomly(zid, pid, withoutTids, include_social) {
    var params = {
        zid: zid,
        not_voted_by_pid: pid,
        limit: 2, // 2 since one may be the one that is just being voted on
        random: true,
        include_social: include_social,
    };
    if (!_.isUndefined(withoutTids) && withoutTids.length) {
        params.withoutTids = withoutTids;
    }
    return getComments(params).then(function(comments) {
        if (!comments || !comments.length) {
            return [];
        } else {
            return comments;
        }
    });
}


function getNextCommentPrioritizingNonPassedComments(zid, pid, withoutTids) {
/*
WITH conv AS
  (SELECT *,
    CASE WHEN strict_moderation=TRUE then 1 ELSE 0 END as minModVal from conversations where zid = 12480),
      pv AS
  (SELECT tid,
          TRUE AS voted
   FROM votes
   WHERE zid = 12480
     AND pid = 157
   GROUP BY tid),
     x AS
  (SELECT *
   FROM votes_lastest_unique(12480)
   ORDER BY tid),
     a AS
  (SELECT zid,
          tid,
          count(*)
   FROM x
   WHERE vote < 0
   GROUP BY zid,
            tid),
     d AS
  (SELECT tid,
          count(*)
   FROM x
   WHERE vote > 0
   GROUP BY tid),
     t AS
  (SELECT tid,
          count(*)
   FROM x
   GROUP BY tid),
     c AS
  (SELECT *
   FROM comments
   WHERE zid = 12480)
SELECT 12480 AS zid,
       c.tid,
       (COALESCE(a.count,0.0)+COALESCE(d.count,0.0)) / coalesce(t.count, 1.0) AS nonpass_score,
       COALESCE(pv.voted, FALSE) AS voted,
       c.*
FROM c
LEFT JOIN d ON c.tid = d.tid
LEFT JOIN t ON c.tid = t.tid
LEFT JOIN a ON a.zid = c.zid
AND a.tid = c.tid
LEFT JOIN pv ON c.tid = pv.tid
LEFT JOIN conv ON c.zid = conv.zid
WHERE voted IS NULL
  AND (pv.voted = FALSE OR pv.voted IS NULL)
  AND c.active = TRUE
  AND c.mod >= conv.minModVal
  AND c.velocity > 0
ORDER BY nonpass_score DESC;
*/

/*

            q = q.and(sql_comments.active.equals(true));
            if (conv.strict_moderation) {
                q = q.and(sql_comments.mod.equals(polisTypes.mod.ok));
            } else {
                q = q.and(sql_comments.mod.notEquals(polisTypes.mod.ban));
            }
        }

        q = q.and(sql_comments.velocity.gt(0)); // filter muted comments

*/

if (!withoutTids || !withoutTids.length) {
    withoutTids = [-999999]; // ensure there's a value in there so the sql parses as a list
}

var q = "WITH ";
q += "  star_counts AS ";
q += "  (SELECT tid, count(*) as starcount from stars where zid = $1 group by tid), ";
q += "  conv AS  ";
q += "  (SELECT *,";
q += "    CASE WHEN strict_moderation=TRUE then 1 ELSE 0 END as minModVal from conversations where zid = $1),";
q += "  pv AS  ";
q += "  (SELECT tid,  ";
q += "          TRUE AS voted ";
q += "   FROM votes  ";
q += "   WHERE zid = $1 ";
q += "     AND pid = $2 ";
q += "   GROUP BY tid),  ";
q += "     x AS  ";
q += "  (SELECT * ";
q += "   FROM votes_lastest_unique($1) ";
q += "   ORDER BY tid),  ";
q += "     a AS  ";
q += "  (SELECT zid,  ";
q += "          tid,  ";
q += "          count(*) ";
q += "   FROM x  ";
q += "   WHERE vote < 0 ";
q += "   GROUP BY zid,  ";
q += "            tid),  ";
q += "     d AS  ";
q += "  (SELECT tid,  ";
q += "          count(*) ";
q += "   FROM x  ";
q += "   WHERE vote > 0 ";
q += "   GROUP BY tid),  ";
q += "     t AS  ";
q += "  (SELECT tid,  ";
q += "          count(*) ";
q += "   FROM x ";
q += "   GROUP BY tid),  ";
q += "     c AS  ";
q += "  (SELECT * ";
q += "   FROM comments  ";
q += "   WHERE zid = $1) ";
q += "SELECT $1 AS zid,  ";
q += "       c.tid,  ";
q += "       (COALESCE(a.count,0.0)+COALESCE(d.count,0.0)) / coalesce(t.count, 1.0) AS nonpass_score,  ";
q += "       pv.voted AS voted,  ";
q += "       c.* ";
q += "FROM c ";
q += "LEFT JOIN d ON c.tid = d.tid ";
q += "LEFT JOIN t ON c.tid = t.tid ";
q += "LEFT JOIN a ON a.zid = c.zid ";
q += "  AND a.tid = c.tid ";
q += "LEFT JOIN pv ON c.tid = pv.tid  ";
q += "LEFT JOIN conv ON c.zid = conv.zid  ";
q += "LEFT JOIN star_counts ON c.tid = star_counts.tid ";
q += "WHERE voted IS NULL ";
q += "  AND c.tid NOT IN ("+ withoutTids.join(",") +") ";
q += "  AND (pv.voted = FALSE OR pv.voted IS NULL)";
q += "  AND c.active = true";
q += "  AND c.mod >= conv.minModVal";
q += "  AND c.velocity > 0";
q += " ORDER BY starcount DESC NULLS LAST, nonpass_score DESC ";
q += " LIMIT 2;"; // 2 since one may be the one that is just being voted on


    return pgQueryP_readOnly(q, [zid, pid]).then(function(comments) {
        if (!comments || !comments.length) {
            return [];
        } else {
            return comments;
        }
    });
}

function getNextComment(zid, pid, withoutTids, include_social) {
    return getNextCommentRandomly(zid, pid, withoutTids, include_social);
    // return getNextCommentPrioritizingNonPassedComments(zid, pid, withoutTids, !!!!!!!!!!!!!!!!TODO IMPL!!!!!!!!!!!include_social);
}

// NOTE: only call this in response to a vote. Don't call this from a poll, like /api/v3/nextComment
function addNoMoreCommentsRecord(zid, pid) {
    return pgQueryP("insert into event_ptpt_no_more_comments (zid, pid, votes_placed) values ($1, $2, "+
        "(select count(*) from votes where zid = ($1) and pid = ($2)))", [zid, pid]);
}


app.get("/api/v3/nextComment",
    timeout(15000),
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    resolve_pidThing('not_voted_by_pid', assignToP, "get:nextComment"), // TODO_SECURITY should ensure this pid is self
    want('without', getArrayOfInt, assignToP),
    want('include_social', getBool, assignToP),
    haltOnTimeout,
function(req, res) {
    if (req.timedout) { return; }
    // NOTE: I tried to speed up this query by adding db indexes, and by removing queries like getConversationInfo and finishOne.
    //          They didn't help much, at least under current load, which is negligible. pg:diagnose isn't complaining about indexes.
    //      I think the direction to go as far as optimizing this is to asyncronously build up a synced in-ram list of next comments
    //        for each participant, for currently active conversations. (this would probably be a math-poller-esque process on another
    //         hostclass)
    //         Along with this would be to cache in ram info about moderation status of each comment so we can filter before returning a comment.

    getNextComment(req.p.zid, req.p.not_voted_by_pid, req.p.without, req.p.include_social).then(function(c) {
        if (req.timedout) { return; }
        if (c) {
            if (!_.isUndefined(req.p.not_voted_by_pid)) {
                c.currentPid = req.p.not_voted_by_pid;
            }
            finishOne(res, c);
        } else {
            var o = {};
            if (!_.isUndefined(req.p.not_voted_by_pid)) {
                o.currentPid = req.p.not_voted_by_pid;
            }
            res.status(200).json(o);
        }
    }, function(err) {
        if (req.timedout) { return; }
        fail(res, 500, "polis_err_get_next_comment2", err);
    }).catch(function(err) {
        if (req.timedout) { return; }
        fail(res, 500, "polis_err_get_next_comment", err);
    });
});

app.get("/api/v3/participationInit",
  moveToBody,
  authOptional(assignToP),
  want('ptptoiLimit', getInt, assignToP),
  want('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
  want('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
  resolve_pidThing('pid', assignToP, "get:votes"), // must be after zid getter
function(req, res) {

  var qs = {
    conversation_id: req.p.conversation_id,
  };

  var nextCommentQs = _.extend({}, qs, {
    not_voted_by_pid: "mypid",
    limit: 1,
    include_social: true,
  });

  // var votesByMeQs = _.extend({}, req.p, {
  //   pid: "mypid",
  // });

  // var famousQs = req.p.ptptoiLimit ? _.extend({}, qs, {
  //   ptptoiLimit: req.p.ptptoiLimit,
  // }) : qs;

  function getIfConv() {
    if (qs.conversation_id) {
      return request.get.apply(request, arguments);
    } else {
      return Promise.resolve("null");
    }
  }
  function getIfConvAndAuth() {
    if (req.p.uid) {
      return getIfConv.apply(0, arguments);
    } else {
      return Promise.resolve("null");
    }
  }

  function getWith304AsSuccess() {
    return getIfConv.apply(0, arguments).catch(function(foo) {
      if (foo.statusCode === 304) {
        return "null";
      } else {
        throw foo;
      }
    });
  }

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
    var o = {
      user: arr[0],
      ptpt: arr[1],
      nextComment: arr[2].length ? arr[2][0] : null, //  since nextComment will be an array, choose the first item if possible
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
  }).catch(function(err) {
    console.error(err);
    fail(res, 500, "polis_err_get_participationInit", err);
  });
});



function updateConversationModifiedTime(zid, t) {
    var modified = _.isUndefined(t) ? Date.now() : Number(t);
    return pgQueryP("update conversations set modified = ($2) where zid = ($1) and modified < ($2);", [zid, modified]);
}

app.post("/api/v3/votes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('vote', getIntInRange(-1, 1), assignToP),
    want('starred', getBool, assignToP),
    resolve_pidThing('pid', assignToP, "post:votes"),
function(req, res) {
    var uid = req.p.uid; // PID_FLOW uid may be undefined here.
    var zid = req.p.zid;
    var pid = req.p.pid; // PID_FLOW pid may be undefined here.

    // We allow viewing (and possibly writing) without cookies enabled, but voting requires cookies (except the auto-vote on your own comment, which seems ok)
    var token = req.cookies[COOKIES.TOKEN];
    var apiToken = req.headers.authorization;
    var xPolisHeaderToken = req.headers['x-polis'];
    if (!uid && !token && !apiToken && !xPolisHeaderToken) {
        fail(res, 403, "polis_err_vote_noauth");
        return;
    }

    // PID_FLOW WIP for now assume we have a uid, but need a participant record.
    var pidReadyPromise = _.isUndefined(req.p.pid) ? addParticipant(req.p.zid, req.p.uid).then(function(rows) {
        var ptpt = rows[0];
        pid = ptpt.pid;
    }) : Promise.resolve();

    // Fire off fetch for next comment. It will return two in case it returns the same comment the user just voted on, we can choose the other.
    var nextCommentPromise = getNextComment(req.p.zid, pid, [], true);

    var votePromise = pidReadyPromise.then(function() {
        return votesPost(pid, req.p.zid, req.p.tid, req.p.vote);
    }).then(function(createdTime) {
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
    });

    Promise.all([
        nextCommentPromise,
        votePromise,
    ]).then(function(arr) {
        var nextComments = arr[0];

        var result = {};
        if (nextComments.length) {
            if (nextComments.length >= 2) {
                if (nextComments[0].pid === pid) {
                    // same as comment the user just voted on, so send them the other one.
                    result.nextComment = nextComments[1];
                } else {
                    result.nextComment = nextComments[0];
                }
            } else {
                result.nextComment = nextComments[0];
            }
        } else {
            // no need to wait for this to finish
            addNoMoreCommentsRecord(req.p.zid, pid);
        }
        // PID_FLOW This may be the first time the client gets the pid.
        result.currentPid = req.p.pid;
        finishOne(res, result);

    }).catch(function(err) {
        if (err === "polis_err_vote_duplicate") {
            fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
        } else if (err === "polis_err_conversation_is_closed") {
            fail(res, 403, "polis_err_conversation_is_closed", err);
        } else {
            fail(res, 500, "polis_err_vote", err);
        }
    });
});




app.post("/api/v3/upvotes",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;

    pgQueryP("select * from upvotes where uid = ($1) and zid = ($2);", [uid, zid]).then(function(rows) {
        if (rows && rows.length) {
            fail(res, 403, "polis_err_upvote_already_upvoted", err);
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
});


function addStar(zid, tid, pid, starred, created) {
    starred = starred ? 1 : 0;
    var query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
    var params = [pid, zid, tid, starred];
    if (!_.isUndefined(created)) {
        query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, $5) RETURNING created;";
        params.push(created);
    }
    return pgQueryP(query, params);
}

app.post("/api/v3/stars",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('starred', getIntInRange(0,1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.starred];
    addStar(req.p.zid, req.p.tid, req.p.pid, req.p.starred).then(function(result) {
        var createdTime = result.rows[0].created;
        setTimeout(function() {
            updateConversationModifiedTime(req.p.zid, createdTime);
        }, 100);
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    }).catch(function(err) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
            } else {
                fail(res, 500, "polis_err_vote", err);
            }
        }
    });
});

app.post("/api/v3/trashes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('trashed', getIntInRange(0,1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
    var query = "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
    pgQuery(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
            } else {
                fail(res, 500, "polis_err_vote", err);
            }
            return;
        }

        var createdTime = result.rows[0].created;
        setTimeout(function() {
            updateConversationModifiedTime(req.p.zid, createdTime);
        }, 100);

        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
});


function verifyMetadataAnswersExistForEachQuestion(zid) {
  var errorcode = "polis_err_missing_metadata_answers";
  return new Promise(function(resolve, reject) {
    pgQuery_readOnly("select pmqid from participant_metadata_questions where zid = ($1);", [zid], function(err, results) {
        if (err) {reject(err); return; }
        if (!results.rows || !results.rows.length) {
            resolve();
            return;
        }
        var pmqids = results.rows.map(function(row) { return Number(row.pmqid); });
        pgQuery_readOnly(
            "select pmaid, pmqid from participant_metadata_answers where pmqid in ("+pmqids.join(",")+") and alive = TRUE and zid = ($1);",
            [zid],
            function(err, results) {
                if (err) { reject(err); return; }
                if (!results.rows || !results.rows.length) {
                    reject(new Error(errorcode));
                    return;
                }
                var questions = _.reduce(pmqids, function(o, pmqid) { o[pmqid] = 1; return o; }, {});
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

app.put('/api/v3/comments',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('tid', getInt, assignToP),
    need('active', getBool, assignToP),
    need('mod', getInt, assignToP),
    need('velocity', getNumberInRange(0,1), assignToP),
function(req, res){
    var uid = req.p.uid;
    var zid = req.p.zid;
    var tid = req.p.tid;
    var active = req.p.active;
    var mod = req.p.mod;

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
});


// kind of crappy that we're replacing the zinvite.
// This is needed because we initially create a conversation with the POST, then actually set the properties with the subsequent PUT.
// if we stop doing that, we can remove this function.
function generateAndReplaceZinvite(zid, generateShortZinvite) {
    var len = 12;
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

    var replaceResultRequestBody = '' +
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
                    '<textString>'+ params.gradeFromZeroToOne+'</textString>' +
                '</resultScore>' +
                '</result>' +
                '</resultRecord>' +
            '</replaceResultRequest>' +
        '</imsx_POXBody>' +
    '</imsx_POXEnvelopeRequest>';

    var oauth = new OAuth.OAuth(
        null,//'https://api.twitter.com/oauth/request_token',
        null,//'https://api.twitter.com/oauth/access_token',
        oauth_consumer_key,//'your application consumer key',
        oauth_consumer_secret,//'your application secret',
        '1.0',//'1.0A',
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
            function (e, data, res){
                if (e) {
                    winston.log("info","grades foo failed");
                    console.error(e);
                    reject(e);
                } else {
                    winston.log("info",'grades foo ok!');
                    resolve(params, data);
                }
                // winston.log("info",require('util').inspect(data));
            }
        );
    });
}

function sendCanvasGradesIfNeeded(zid, ownerUid) {
    // get the lti_user_ids for participants who voted or commented
    var goodLtiUserIdsPromise = pgQueryP(
        "select lti_user_id from "+
        "(select distinct uid from "+
            "(select distinct pid from votes where zid = ($1) UNION "+
             "select distinct pid from comments where zid = ($1)) as x "+
        "inner join participants p on x.pid = p.pid where p.zid = ($1)) as good_uids "+
      "inner join lti_users on good_uids.uid = lti_users.uid;", [zid]);

    var callbackInfoPromise = pgQueryP(
        "select * from canvas_assignment_conversation_info ai " +
        "inner join canvas_assignment_callback_info ci " +
        "on ai.custom_canvas_assignment_id = ci.custom_canvas_assignment_id " +
        "where ai.zid = ($1);", [zid]);

    var ownerLtiCredsPromise = pgQueryP(
        "select * from lti_oauthv1_credentials where uid = ($1);", [ownerUid]);

    return Promise.all([
        goodLtiUserIdsPromise,
        callbackInfoPromise,
        ownerLtiCredsPromise,
    ]).then(function(results) {
        var isFullPointsEarningLtiUserId = _.indexBy(results[0], "lti_user_id");
        var callbackInfos = results[1];
        if (!callbackInfos || !callbackInfos.length) {
            // TODO may be able to check for scenarios like missing callback infos, where votes and comments and canvas_assignment_conversation_info exist, and then throw an error
            return;
        }
        var ownerLtiCreds = results[2];
        if (!ownerLtiCreds || !ownerLtiCreds.length) {
            throw new Error("polis_err_lti_oauth_credentials_are_missing " + ownerUid);
        }
        ownerLtiCreds = ownerLtiCreds[0];
        if (!ownerLtiCreds.oauth_shared_secret || !ownerLtiCreds.oauth_consumer_key) {
            throw new Error("polis_err_lti_oauth_credentials_are_bad " + ownerUid);
        }

        var promises = callbackInfos.map(function(assignmentCallbackInfo) {
            var gradeFromZeroToOne = isFullPointsEarningLtiUserId[assignmentCallbackInfo.lti_user_id] ? 1.0 : 0.0;
            assignmentCallbackInfo.gradeFromZeroToOne = gradeFromZeroToOne;
            winston.log("info","grades assigned" + gradeFromZeroToOne + " lti_user_id " + assignmentCallbackInfo.lti_user_id);
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
        winston.log("info","grading set to " + gradingContext.gradeFromZeroToOne);
        return pgQueryP("update canvas_assignment_callback_info set grade_assigned = ($1) where tool_consumer_instance_guid = ($2) and lti_context_id = ($3) and lti_user_id = ($4) and custom_canvas_assignment_id = ($5);", [
            gradingContext.gradeFromZeroToOne,
            gradingContext.tool_consumer_instance_guid,
            gradingContext.lti_context_id,
            gradingContext.lti_user_id,
            gradingContext.custom_canvas_assignment_id,
        ]);
    }));
}

// use this to generate them
app.get('/api/v3/lti_oauthv1_credentials',
    moveToBody,
    want('uid', getInt, assignToP),
function(req, res) {
    var uid = "FOO";
    if (req.p && req.p.uid) {
        uid = req.p.uid;
    }
    Promise.all([
        generateTokenP(40, false),
        generateTokenP(40, false),
    ]).then(function(results) {
        var key = "polis_oauth_consumer_key_" + results[0];
        var secret =  "polis_oauth_shared_secret_" + results[1];
        var x = [uid, "'"+key+"'", "'"+secret+"'"].join(",");
        // return the query, they we can manually run this in the pg shell, and email? the keys to the instructor
        res.status(200).json("INSERT INTO lti_oauthv1_credentials (uid, oauth_consumer_key, oauth_shared_secret) values ("+x+") returning oauth_consumer_key, oauth_shared_secret;");
    });
});



app.post('/api/v3/conversation/close',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {

    pgQueryP("select * from conversations where zid = ($1) and owner = ($2);", [req.p.zid, req.p.uid]).then(function(rows) {
        if (!rows || !rows.length) {
            fail(res, 500, "polis_err_closing_conversation_no_such_conversation", err);
            return;
        }
        var conv = rows[0];
        // if (conv.is_active) {
            // regardless of old state, go ahead and close it, and update grades. will make testing easier.
            pgQueryP("update conversations set is_active = false where zid = ($1);", [conv.zid]).then(function() {
                // might need to send some grades
                var ownerUid = req.p.uid;
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
});

app.post('/api/v3/conversation/reopen',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {

    pgQueryP("select * from conversations where zid = ($1) and owner = ($2);", [req.p.zid, req.p.uid]).then(function(rows) {
        if (!rows || !rows.length) {
            fail(res, 500, "polis_err_closing_conversation_no_such_conversation", err);
            return;
        }
        var conv = rows[0];
        pgQueryP("update conversations set is_active = true where zid = ($1);", [conv.zid]).then(function() {
            res.status(200).json({});
        }).catch(function(err) {
            fail(res, 500, "polis_err_reopening_conversation2", err);
        });
    }).catch(function(err) {
        fail(res, 500, "polis_err_reopening_conversation", err);
    });
});

app.put('/api/v3/conversations',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    want('is_active', getBool, assignToP),
    want('is_anon', getBool, assignToP),
    want('is_draft', getBool, assignToP, false),
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
function(req, res){
  var generateShortUrl = req.p.short_url;
  isModerator(req.p.zid, req.p.uid).then(function(ok) {
    if (!ok) {
        fail(res, 403, "polis_err_update_conversation_permission");
        return;
    }

    var verifyMetaPromise;
    if (req.p.verifyMeta) {
        verifyMetaPromise = verifyMetadataAnswersExistForEachQuestion(req.p.zid);
    } else {
        verifyMetaPromise = Promise.resolve();
    }

    var fields = {};
    if (!_.isUndefined(req.p.is_active)) {
        fields.is_active = req.p.is_active;
    }
    if (!_.isUndefined(req.p.is_anon)) {
        fields.is_anon = req.p.is_anon;
    }
    if (!_.isUndefined(req.p.is_draft)) {
        fields.is_draft = req.p.is_draft;
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


    var q = sql_conversations.update(
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
            function(err, result){
                if (err) {
                    fail(res, 500, "polis_err_update_conversation", err);
                    return;
                }
                var conv = result && result.rows && result.rows[0];

                var promise = generateShortUrl ?
                    generateAndReplaceZinvite(req.p.zid, generateShortUrl) :
                    Promise.resolve();
                var successCode = generateShortUrl ? 201 : 200;

                promise.then(function() {

                     // send notification email
                    if (req.p.send_created_email) {
                        Promise.all([getUserInfoForUid2(req.p.uid), getConversationUrl(req, req.p.zid, true)]).then(function(results) {
                            var hname = results[0].hname;
                            var url = results[1];
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
                            winston.log("info",err);
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
                        var linkText = "pol.is conversation";
                        if (req.p.topic) {
                            linkText += " (" + req.p.topic + ")";
                        }
                        var linkTitle = "";
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



                    //     // LTI redirect to create e
                    //     // var url = getServerNameWithProtocol(req) + "/" + req.p.conversation_id;
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
});

app.delete('/api/v3/metadata/questions/:pmqid',
    moveToBody,
    auth(assignToP),
    need('pmqid', getInt, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var pmqid = req.p.pmqid;

    getZidForQuestion(pmqid, function(err, zid) {
        if (err) { fail(res, 500, "polis_err_delete_participant_metadata_questions_zid", err); return; }
        isConversationOwner(zid, uid, function(err) {
            if (err) { fail(res, 403, "polis_err_delete_participant_metadata_questions_auth", err); return; }

            deleteMetadataQuestionAndAnswers(pmqid, function(err) {
                if (err) { fail(res, 500, "polis_err_delete_participant_metadata_question", new Error(err)); return; }
                res.send(200);
            });
        });
    });
});

app.delete('/api/v3/metadata/answers/:pmaid',
    moveToBody,
    auth(assignToP),
    need('pmaid', getInt, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var pmaid = req.p.pmaid;

    getZidForAnswer(pmaid, function(err, zid) {
        if (err) { fail(res, 500, "polis_err_delete_participant_metadata_answers_zid", err); return; }
        isConversationOwner(zid, uid, function(err) {
            if (err) { fail(res, 403, "polis_err_delete_participant_metadata_answers_auth", err); return; }

            deleteMetadataAnswer(pmaid, function(err) {
                if (err) { fail(res, 500, "polis_err_delete_participant_metadata_answers", err); return; }
                res.send(200);
            });
        });
    });
});

function getZidForAnswer(pmaid, callback) {
    pgQuery("SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);", [pmaid], function(err, result) {
        if (err) { callback(err); return;}
        if (!result.rows || !result.rows.length) {
            callback("polis_err_zid_missing_for_answer");
            return;
        }
        callback(null, result.rows[0].zid);
    });
}

function getZidForQuestion(pmqid, callback) {
    pgQuery("SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);", [pmqid], function(err, result) {
        if (err) {winston.log("info",err);  callback(err); return;}
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
            if (err) {callback(err); return;}
            callback(null);
        });
     // });
}

function deleteMetadataQuestionAndAnswers(pmqid, callback) {
    // pgQuery("update participant_metadata_choices set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
    //     if (err) {callback(93847834); return;}
        pgQuery("update participant_metadata_answers set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
            if (err) {callback(err); return;}
            pgQuery("update participant_metadata_questions set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
                if (err) {callback(err); return;}
                callback(null);
            });
        });
     // });
}

app.get('/api/v3/metadata/questions',
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
    var suzinvite = req.p.suzinvite;

    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_get_participant_metadata_auth", err); return; }

        async.parallel([
            function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);", [zid], callback); },
            //function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_answers WHERE alive = true AND zid = ($1);", [zid], callback); },
            //function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_choices WHERE alive = true AND zid = ($1);", [zid], callback); },
        ], function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata_questions", err); return; }
            var rows = result[0] && result[0].rows;
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
});

app.post('/api/v3/metadata/questions',
    moveToBody,
    auth(assignToP),
    need('key', getOptionalStringLimitLength(999), assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var zid = req.p.zid;
    var key = req.p.key;
    var uid = req.p.uid;

    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_post_participant_metadata_auth", err); return; }
        pgQuery("INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;", [
            zid,
            key,
            ], function(err, results) {
            if (err || !results || !results.rows || !results.rows.length) { fail(res, 500, "polis_err_post_participant_metadata_key", err); return; }

            finishOne(res, results.rows[0]);
        });
    }

    isConversationOwner(zid, uid, doneChecking);
});

app.post('/api/v3/metadata/answers',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('pmqid', getInt, assignToP),
    need('value', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var pmqid = req.p.pmqid;
    var value = req.p.value;

    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_post_participant_metadata_auth", err); return; }
        pgQuery("INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;", [pmqid, zid, value, ], function(err, results) {
            if (err || !results || !results.rows || !results.rows.length) {
                pgQuery("UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;", [pmqid, zid, value], function(err, results) {
                    if (err) { fail(res, 500, "polis_err_post_participant_metadata_value", err); return; }
                    finishOne(res, results.rows[0]);
                });
            } else {
                finishOne(res, results.rows[0]);
            }
        });
    }

    isConversationOwner(zid, uid, doneChecking);
});

app.get('/api/v3/metadata/choices',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;

    getChoicesForConversation(zid).then(function(choices) {
        finishArray(res, choices);
    }, function(err) {
        fail(res, 500, "polis_err_get_participant_metadata_choices", err);
    });
});

app.get('/api/v3/metadata/answers',
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('pmqid', getInt, assignToP),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
    var suzinvite = req.p.suzinvite;
    var pmqid = req.p.pmqid;

    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_get_participant_metadata_auth", err); return; }
        var query = sql_participant_metadata_answers.select(sql_participant_metadata_answers.star())
            .where(
                sql_participant_metadata_answers.zid.equals(zid)
            ).and(
                sql_participant_metadata_answers.alive.equals(true)
            );

        if (pmqid) {
            query = query.where(sql_participant_metadata_answers.pmqid.equals(pmqid));
        }
        pgQuery_readOnly(query.toString(), function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata_answers", err); return; }
            var rows = result.rows.map(function(r) {
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
});

app.get('/api/v3/metadata',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    want('suzinvite', getOptionalStringLimitLength(32), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
    var suzinvite = req.p.suzinvite;

    function doneChecking(err) {
        if (err) { fail(res, 403, "polis_err_get_participant_metadata_auth", err); return; }
        async.parallel([
            function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_questions WHERE zid = ($1);", [zid], callback); },
            function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_answers WHERE zid = ($1);", [zid], callback); },
            function(callback) { pgQuery_readOnly("SELECT * FROM participant_metadata_choices WHERE zid = ($1);", [zid], callback); },
        ], function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata", err); return; }
            var keys = result[0] && result[0].rows;
            var vals = result[1] && result[1].rows;
            var choices = result[2] && result[2].rows;
            var o = {};
            var keyNames = {};
            var valueNames = {};
            var i;
            var k;
            var v;
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
});

app.post('/api/v3/metadata/new',
    moveToBody,
    auth(assignToP),
    want('oid', getInt, assignToP),
    need('metaname', getInt, assignToP),
    need('metavalue', getInt, assignToP),
function(req, res) {
});


function getConversationHasMetadata(zid) {
    return new Promise(function(resolve, reject) {
        pgQuery_readOnly('SELECT * from participant_metadata_questions where zid = ($1)', [zid], function(err, metadataResults) {
            if (err) {
                return reject("polis_err_get_conversation_metadata_by_zid");
            }
            var hasNoMetadata = !metadataResults || !metadataResults.rows || !metadataResults.rows.length;
            resolve(!hasNoMetadata);
        });
    });
}

// Returns a function that behaves like failNow, but waits for some duration.
// The idea is to prevent timing attacks on various failure modes.
function failNotWithin(minDelay) {
    var timerStart = Date.now();
    return function() {
        var args = arguments;
        var failMoment = Date.now();
        var elapsedBeforeFailureDetected = failMoment - timerStart;
        var remainingDelay = Math.max(0, minDelay - elapsedBeforeFailureDetected);
        setTimeout(function() {
            fail.apply({}, args);
        }, remainingDelay);
    };
}

function getOneConversation(zid, uid) {
    // var fail = failNotWithin(500);
    // no need for auth, since conversation_id was provided
    return Promise.all([
        pgQueryP_readOnly("select * from conversations left join  (select uid, site_id from users) as u on conversations.owner = u.uid where conversations.zid = ($1);", [zid]),
        getConversationHasMetadata(zid),
    ]).then(function(results) {
        var conv = results[0] && results[0][0];
        var convHasMetadata = results[1];
        return getUserInfoForUid2(conv.owner).then(function(userInfo) {
            var ownername = userInfo.hname;
            if (convHasMetadata) {
                conv.hasMetadata = true;
            }
            if (!_.isUndefined(ownername) && conv.context !== "hongkong2014") {
                conv.ownername = ownername;
            }
            conv.is_mod = conv.site_id === userInfo.site_id;
            conv.is_owner = conv.owner === uid;
            conv.pp = false; // participant pays (WIP)
            delete conv.uid; // conv.owner is what you want, uid shouldn't be returned.
            return conv;
        });
    });
}

function getConversations(req, res) {
  var uid = req.p.uid;
  var zid = req.p.zid;
  var xid = req.p.xid;
  var course_invite = req.p.course_invite;
  var include_all_conversations_i_am_in = req.p.include_all_conversations_i_am_in;
  var want_mod_url = req.p.want_mod_url;
  var want_upvoted = req.p.want_upvoted;
  var want_inbox_item_admin_url = req.p.want_inbox_item_admin_url;
  var want_inbox_item_participant_url = req.p.want_inbox_item_participant_url;
  var want_inbox_item_admin_html = req.p.want_inbox_item_admin_html;
  var want_inbox_item_participant_html = req.p.want_inbox_item_participant_html;
  var context = req.p.context;
  var limit = req.p.limit;
  winston.log("info","thecontext", context);


  // this statement is currently a subset of the next one
  // var zidListQuery = "select zid from page_ids where site_id = (select site_id from users where uid = ($1))";

  // include conversations started by people with the same site_id as me
  // 1's indicate that the conversations are there for that reason
  var zidListQuery = "select zid, 1 as type from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($1)))";
  if (include_all_conversations_i_am_in) {
    zidListQuery += " UNION ALL select zid, 2 as type from participants where uid = ($1)"; // using UNION ALL instead of UNION to ensure we get all the 1's and 2's (I'm not sure if we can guarantee the 2's won't clobber some 1's if we use UNION)
  }
  zidListQuery += ";";


  pgQuery_readOnly(zidListQuery, [uid], function(err, results) {
    if (err) { fail(res, 500, "polis_err_get_conversations_participated_in", err); return; }

    var participantInOrSiteAdminOf = results && results.rows && _.pluck(results.rows, "zid") || null;
    var siteAdminOf = _.filter(results.rows, function(row) { return row.type === 1;});
    var isSiteAdmin = _.indexBy(siteAdminOf, "zid");

    var query = sql_conversations.select(sql_conversations.star());

    var isRootsQuery = false;
    var orClauses;
    if (!_.isUndefined(req.p.context)) {
        if (req.p.context === "/") {
            winston.log("info","asdf" + req.p.context + "asdf");
            // root of roots returns all public conversations
            // TODO lots of work to decide what's relevant
            // There is a bit of mess here, because we're returning both public 'roots' conversations, and potentially private conversations that you are already in.
            orClauses = sql_conversations.is_public.equals(true);
            isRootsQuery = true; // more conditions follow in the ANDs below
        } else {
            // knowing a context grants access to those conversations (for now at least)
            winston.log("info","CONTEXT", context);
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
        query = query.and(sql_conversations.zid.equals(req.p.zid));
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
        if (err) { fail(res, 500, "polis_err_get_conversations", err); return; }
        var data = result.rows || [];


        addConversationIds(data).then(function(data) {
            var suurlsPromise;
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
            var upvotesPromise = (uid && want_upvoted) ? pgQueryP_readOnly("select zid from upvotes where uid = ($1);", [uid]) : Promise.resolve();

            return Promise.all([
                suurlsPromise,
                upvotesPromise,
            ]).then(function(x) {
                var suurlData = x[0];
                var upvotes = x[1];
                if (suurlData) {
                    suurlData = _.indexBy(suurlData, "zid");
                }
                if (upvotes) {
                    upvotes = _.indexBy(upvotes, "zid");
                }
                data.forEach(function(conv) {
                    conv.is_owner = conv.owner === uid;
                    var root = getServerNameWithProtocol(req);

                    if (want_mod_url) {
                        // TODO make this into a moderation invite URL so others can join Issue #618
                        conv.mod_url = createModerationUrl(req, conv.conversation_id);
                    }
                    if (want_inbox_item_admin_url) {
                        conv.inbox_item_admin_url = root +"/iim/"+ conv.conversation_id;
                    }
                    if (want_inbox_item_participant_url) {
                        conv.inbox_item_participant_url = root +"/iip/"+ conv.conversation_id;
                    }
                    if (want_inbox_item_admin_html) {
                        conv.inbox_item_admin_html =
                            "<a href='" +root +"/" +conv.conversation_id + "'>"+(conv.topic||conv.created)+"</a>"+
                            " <a href='" +root +"/m/"+ conv.conversation_id + "'>moderate</a>";

                        conv.inbox_item_admin_html_escaped = conv.inbox_item_admin_html.replace(/'/g, "\\'");
                    }
                    if (want_inbox_item_participant_html) {
                        conv.inbox_item_participant_html = "<a href='" +root +"/"+ conv.conversation_id + "'>"+(conv.topic||conv.created)+"</a>";
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
    var stringifiedJson = hexToStr(encodedStringifiedJson);
    var o = JSON.parse(stringifiedJson);
    return o;
}

function encodeParams(o) {
    var stringifiedJson = JSON.stringify(o);
    var encoded = "ep1_" + strToHex(stringifiedJson);
    return encoded;
}
// TODO_SECURITY needs to require auth of the site_id owner
app.get('/api/v3/encoded_site_id_create_user_url',
    moveToBody,
    need('site_id', getStringLimitLength(1, 100), assignToP),
function(req, res) {
    res.send("https://pol.is/user/create/" + encodeParams({
        site_id: req.p.site_id,
    }));
});

app.get('/api/v3/enterprise_deal_url',
    moveToBody,
    // want('upfront', getBool, assignToP),
    need('monthly', getInt, assignToP),
    want('maxUsers', getInt, assignToP),
function(req, res) {
    var o = {
        monthly: req.p.monthly
    };
    if (req.p.maxUsers) {
        o.maxUsers = req.p.maxUsers;
    }
    res.send("https://pol.is/settings/enterprise/" + encodeParams(o));
});


app.get('/api/v3/stripe_account_connect',
function(req, res) {
    var stripe_client_id = process.env.STRIPE_CLIENT_ID;

    var stripeUrl = "https://connect.stripe.com/oauth/authorize?response_type=code&client_id="+stripe_client_id+"&scope=read_write";
    res.set({
        'Content-Type': 'text/html',
    }).send("<html><body>" +
        "<a href ='" + stripeUrl + "'>Connect Pol.is to Stripe</a>" +
    "</body></html>");
});


app.get('/api/v3/stripe_account_connected_oauth_callback',
    moveToBody,
    want("code", getStringLimitLength(9999), assignToP),
    want("access_token", getStringLimitLength(9999), assignToP),
    want("error", getStringLimitLength(9999), assignToP),
    want("error_description", getStringLimitLength(9999), assignToP),
function(req, res) {

  var code = req.p.code;
  var access_token = req.p.access_token;
  var error = req.p.error;
  var error_description = req.p.error_description;
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
      client_secret: process.env.STRIPE_SECRET_KEY
    }
  }, function(err, r, body) {
    if (err) {
        fail(res, 500, "polis_err_stripe_oauth", err);
        return;
    }
    body = JSON.parse(body);
    pgQueryP("INSERT INTO stripe_accounts ("+
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
});


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
function(req, res) {
  var courseIdPromise = Promise.resolve();
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
});

app.get('/api/v3/contexts',
    moveToBody,
    authOptional(assignToP),
function(req, res) {
    pgQueryP_readOnly("select name from contexts where is_public = TRUE order by name;", []).then(function(contexts) {
        res.status(200).json(contexts);
    }, function(err) {
      fail(res, 500, "polis_err_get_contexts_query", err);
    }).catch(function(err) {
      fail(res, 500, "polis_err_get_contexts_misc", err);
    });
});

app.post('/api/v3/contexts',
    auth(assignToP),
    need('name', getStringLimitLength(1, 300), assignToP),
function(req, res) {
    var uid = req.p.uid;
    var name = req.p.name;
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
        var exists = rows && rows.length;
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
});


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
function(req, res) {

    winston.log("info","context", req.p.context);
    var generateShortUrl = req.p.short_url;

  isUserAllowedToCreateConversations(req.p.uid, function(err, isAllowed) {
    if (err) { fail(res, 403, "polis_err_add_conversation_failed_user_check", err); return; }
    if (!isAllowed) { fail(res, 403, "polis_err_add_conversation_not_enabled", new Error("polis_err_add_conversation_not_enabled")); return; }


    var q = sql_conversations.insert({
        owner: req.p.uid,
        topic: req.p.topic,
        description: req.p.description,
        is_active: req.p.is_active,
        is_draft: req.p.is_draft,
        is_public: true, // req.p.short_url,
        is_anon: req.p.is_anon,
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

        var zid = result && result.rows && result.rows[0] && result.rows[0].zid;

        generateAndRegisterZinvite(zid, generateShortUrl).then(function(zinvite) {
            // NOTE: OK to return conversation_id, because this conversation was just created by this user.
            finishOne(res, {
                url: buildConversationUrl(req, zinvite),
                zid: zid
            });
        }).catch(function(err) {
            fail(res, 500, "polis_err_zinvite_create", err);
        });
    }); // end insert
  }); // end isUserAllowedToCreateConversations
}); // end post conversations

/*
app.get('/api/v3/users',
function(req, res) {
    // creating a user may fail, since we randomly generate the uid, and there may be collisions.
    var query = pgQuery('SELECT * FROM users');
    var responseText = "";
    query.on('row', function(row, result) {
        responseText += row.user_id + "\n";
    });
    query.on('end', function(row, result) {
        res.status(200).end(responseText);
    });
});
*/




app.post('/api/v3/query_participants_by_metadata',
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('pmaids', getArrayOfInt, assignToP, []),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;
    var pmaids = req.p.pmaids;

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
                    "(select pmaid from participant_metadata_answers where alive = TRUE and zid = ($2) and pmaid not in ("+ pmaids.join(",") +"))" +
                ")" +
            ";",
            [ zid, zid ], function( err, results) {
                if (err) { fail(res, 500, "polis_err_metadata_query", err); return; }
                res.status(200).json(_.pluck(results.rows, "pid"));
            });
    }

    isOwnerOrParticipant(zid, uid, doneChecking);
});

app.post('/api/v3/sendCreatedLinkToEmail',
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res){
    winston.log("info",req.p);
    pgQuery_readOnly("SELECT * FROM users WHERE uid = $1", [req.p.uid], function(err, results){
        if (err) { fail(res, 500, "polis_err_get_email_db", err); return; }
        var email = results.rows[0].email;
        var fullname = results.rows[0].hname;
        pgQuery_readOnly("select * from zinvites where zid = $1", [req.p.zid], function(err, results){
            var zinvite = results.rows[0].zinvite;
            var server = getServerNameWithProtocol(req);
            var createdLink = server + "/#"+ req.p.zid +"/"+ zinvite;
            var body = "" +
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
});


function getTwitterRequestToken(returnUrl) {
    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
        '1.0A',
        null,
        'HMAC-SHA1'
    );
    var body = {
        oauth_callback: returnUrl,
    };
    return new Promise(function(resolve, reject) {
        oauth.post(
            'https://api.twitter.com/oauth/request_token',
            void 0, //'your user token for this app', //test user token
            void 0, //'your user secret for this app', //test user secret
            body,
            "multipart/form-data",
            function (e, data, res){
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

app.get("/api/v3/twitterBtn",
    moveToBody,
    authOptional(assignToP),
    want("dest", getStringLimitLength(9999), assignToP),
function(req, res) {
    var uid = req.p.uid;

    var dest = req.p.dest || "/inbox";
    dest = encodeURIComponent(getServerNameWithProtocol(req) + dest);
    var returnUrl = getServerNameWithProtocol(req) + "/api/v3/twitter_oauth_callback?dest=" + dest;

    getTwitterRequestToken(returnUrl).then(function(data) {
        winston.log("info",data);
        data += "&callback_url=" + dest;
        // data += "&callback_url=" + encodeURIComponent(getServerNameWithProtocol(req) + "/foo");
        res.redirect("https://api.twitter.com/oauth/authenticate?" + data);
    }).catch(function(err) {
        fail(res, 500, "polis_err_twitter_auth_01", err);
    });
});


function getTwitterAccessToken(body) {
    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
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
            function (e, data, res){
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
var twitterUserInfoCache = new LruCache({
    max: 1000,
});


function getTwitterUserInfo(o, useCache) {
    var twitter_user_id = o.twitter_user_id;
    var twitter_screen_name = o.twitter_screen_name;
    var params = {
        // oauth_verifier: req.p.oauth_verifier,
        // oauth_token: req.p.oauth_token, // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the header, but this will have been added by the signing process."
    };
    var identifier; // this is way sloppy, but should be ok for caching and logging
    if (twitter_user_id) {
        params.user_id = twitter_user_id;
        identifier = twitter_user_id;
    } else if (twitter_screen_name) {
        params.screen_name = twitter_screen_name;
        identifier = twitter_screen_name;
    }

    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
        '1.0A',
        null,
        'HMAC-SHA1'
    );
    return new MPromise("getTwitterUserInfo", function(resolve, reject) {
        var cachedCopy = twitterUserInfoCache.get(identifier);
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
            function (e, data, res){
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
    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
        '1.0A',
        null,
        'HMAC-SHA1'
    );
    return new MPromise("getTwitterTweet", function(resolve, reject) {
        oauth.get(
            'https://api.twitter.com/1.1/statuses/show.json?id=' + twitter_tweet_id,
            void 0, //'your user token for this app', //test user token
            void 0, //'your user secret for this app', //test user secret
            function (e, data, res){
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
function getTwitterUserTimeline(screen_name) {
    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
        '1.0A',
        null,
        'HMAC-SHA1'
    );
    return new MPromise("getTwitterTweet", function(resolve, reject) {
        oauth.get(
            'https://api.twitter.com/1.1/statuses/user_timeline.json?screen_name=' + screen_name,
            void 0, //'your user token for this app', //test user token
            void 0, //'your user secret for this app', //test user secret
            function (e, data, res){
                if (e) {
                    console.error(" - - - - get twitter tweet failed - - - -");
                    console.error(e);
                    reject(e);
                } else {
                    var foo = JSON.parse(data);
                    foo = _.pluck(foo, "text");
                    console.dir(foo);
                    resolve(data);
                }
                // winston.log("info",require('util').inspect(data));
            }
        );
    });
}






// Certain twitter ids may be suspended.
// Twitter will error if we request info on them.
//  so keep a list of these for as long as the server is running,
//  so we don't repeat requests for them.
// This is probably not optimal, but is pretty easy.
var suspendedOrPotentiallyProblematicTwitterIds = [];


function getTwitterUserInfoBulk(list_of_twitter_user_id) {
    list_of_twitter_user_id = list_of_twitter_user_id || [];
    var oauth = new OAuth.OAuth(
        'https://api.twitter.com/oauth/request_token', // null
        'https://api.twitter.com/oauth/access_token', // null
        process.env.TWITTER_CONSUMER_KEY,//'your application consumer key',
        process.env.TWITTER_CONSUMER_SECRET,//'your application secret',
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
            function (e, data, res){
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
        winston.log("info","retryFunctionWithPromise", numTries);
        f().then(function(x) {
            winston.log("info","retryFunctionWithPromise", "RESOLVED");
            resolve(x);
        }, function(err) {
            numTries -= 1;
            if (numTries <= 0) {
                winston.log("info","retryFunctionWithPromise", "REJECTED");
                reject(err);
            } else {
                retryFunctionWithPromise(f, numTries).then(resolve, reject);
            }
        });
    });
}


function updateSomeTwitterUsers() {
    return pgQueryP_readOnly("select uid, twitter_user_id from twitter_users where modified < (now_as_millis() - 30*60*1000) order by modified desc limit 100;").then(function(results) {
        var twitter_user_ids = _.pluck(results, "twitter_user_id");
        if (results.length === 0) {
            return [];
        }
        twitter_user_ids = _.difference(twitter_user_ids, suspendedOrPotentiallyProblematicTwitterIds);
        if (twitter_user_ids.length === 0) {
            return [];
        }

        getTwitterUserInfoBulk(twitter_user_ids).then(function(info) {
            console.dir(info);

            var updateQueries = info.map(function(u) {
                var q = "update twitter_users set "+
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

      var u = result.twitterUser;
      var twitterUserDbRecord = result.twitterUserDbRecord;

      return pgQueryP("update users set hname = ($2) where uid = ($1) and hname is NULL;", [uid, u.name]).then(function() {
        return twitterUserDbRecord;
      });
    });
  });
}


function prepForQuoteWithTwitterUser(quote_twitter_screen_name, zid) {
    var query = pgQueryP("select * from twitter_users where screen_name = ($1);", [quote_twitter_screen_name]);
    return addParticipantByTwitterUserId(query, {twitter_screen_name: quote_twitter_screen_name}, zid, null);
}

function prepForTwitterComment(twitter_tweet_id, zid) {
    return getTwitterTweetById(twitter_tweet_id).then(function(tweet) {
        var user = tweet.user;
        var twitter_user_id = user.id_str;
        var query = pgQueryP("select * from twitter_users where twitter_user_id = ($1);", [twitter_user_id]);
        return addParticipantByTwitterUserId(query, {twitter_user_id: twitter_user_id}, zid, tweet);
    });
}


function addParticipantByTwitterUserId(query, o, zid, tweet) {
    function addParticipantAndFinish(uid, twitterUser, tweet) {
      return addParticipant(zid, uid).then(function(rows) {
        var ptpt = rows[0];
        return {
          ptpt: ptpt,
          twitterUser: twitterUser,
          tweet: tweet,
        };
      });
    }
    return query.then(function(rows) {
        if (rows && rows.length) {
            var twitterUser = rows[0];
            var uid = twitterUser.uid;
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
              var uid = twitterUser.uid;
              return addParticipant(zid, uid).then(function(rows) {
                  var ptpt = rows[0];
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
    winston.log("info","TWITTER USER INFO");
    winston.log("info",u);
    winston.log("info","/TWITTER USER INFO");
    return pgQueryP("insert into twitter_users ("+
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
      var record = rows && rows.length && rows[0] || null;

      // return the twitter user record
      return {
        twitterUser: u,
        twitterUserDbRecord: record,
      };
    });
  });
}


app.get("/api/v3/twitter_oauth_callback",
    moveToBody,
    enableAgid,
    auth(assignToP),
    need("dest", getStringLimitLength(9999), assignToP),
    need("oauth_token", getStringLimitLength(9999), assignToP), // TODO verify
    need("oauth_verifier", getStringLimitLength(9999), assignToP), // TODO verify

function(req, res) {
    var uid = req.p.uid;

    // TODO "Upon a successful authentication, your callback_url would receive a request containing the oauth_token and oauth_verifier parameters. Your application should verify that the token matches the request token received in step 1."

    var dest = req.p.dest;
    winston.log("info","twitter_oauth_callback uid", uid);
    winston.log("info","twitter_oauth_callback params");
    winston.log("info",req.p);
    winston.log("info","twitter_oauth_callback params end");
    // this api sometimes succeeds, and sometimes fails, not sure why
    function tryGettingTwitterAccessToken() {
        return getTwitterAccessToken({
            oauth_verifier: req.p.oauth_verifier,
            oauth_token: req.p.oauth_token, // confused. needed, but docs say this: "The request token is also passed in the oauth_token portion of the header, but this will have been added by the signing process."
        });
    }
    retryFunctionWithPromise(tryGettingTwitterAccessToken, 20).then(function(o) {
        winston.log("info","TWITTER ACCESS TOKEN");
        var pairs = o.split("&");
        var kv = {};
        pairs.forEach(function(pair) {
            var pairSplit = pair.split("=");
            var k = pairSplit[0];
            var v = pairSplit[1];
            if (k === "user_id") {
                v = parseInt(v);
            }
            kv[k] = v;
        });
        winston.log("info",kv);
        winston.log("info","/TWITTER ACCESS TOKEN");

        // TODO - if no auth, generate a new user.

        getTwitterUserInfo({twitter_user_id: kv.user_id}, false).then(function(u) {
            u = JSON.parse(u)[0];
            winston.log("info","TWITTER USER INFO");
            winston.log("info",u);
            winston.log("info","/TWITTER USER INFO");
            return pgQueryP("insert into twitter_users ("+
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
                ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);",[
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
                    res.redirect(dest);
                }, function(err) {
                    fail(res, 500, "polis_err_twitter_auth_update", err);
                }).catch(function(err) {
                    fail(res, 500, "polis_err_twitter_auth_update_misc", err);
                });
            }, function(err) {
                if (isDuplicateKey(err)) {
                    // we know the uid OR twitter_user_id is filled
                    // check if the uid is there with the same twitter_user_id - if so, redirect and good!
                    // determine which kind of duplicate
                    Promise.all([
                        pgQueryP("select * from twitter_users where uid = ($1);", [uid]),
                        pgQueryP("select * from twitter_users where twitter_user_id = ($1);", [u.id]),
                    ]).then(function(foo) {
                        var recordForUid = foo[0][0];
                        var recordForTwitterId = foo[1][0];
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
        }, function(err) {
            fail(res, 500, "polis_err_twitter_auth_041", err);
        }).catch(function(err) {
            fail(res, 500, "polis_err_twitter_auth_04", err);
        });
    }, function(err) {
        fail(res, 500, "polis_err_twitter_auth_gettoken", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_twitter_auth_misc", err);
    });
});

function getTwitterInfo(uids) {
    return pgQueryP_readOnly("select * from twitter_users where uid in ($1);", uids);
}

function getFacebookInfo(uids) {
    return pgQueryP_readOnly("select * from facebook_users where uid in ($1);", uids);
}

function getSocialParticipantsForMod(zid, limit, mod) {
    var q = "with " +
    "p as (select uid, pid, mod from participants where zid = ($1) and mod = ($3)), " + // and vote_count >= 1

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
        "final_set.pid " +
     "from final_set " +
        "left join twitter_users on final_set.uid = twitter_users.uid " +
        "left join facebook_users on final_set.uid = facebook_users.uid " +
    ") " +
    "select * from all_rows where (tw__twitter_user_id is not null) or (fb__fb_user_id is not null) " +
    // "select * from all_rows " +
    ";";
    return pgQueryP(q, [zid, limit, mod]);
}

var socialParticipantsCache = new LruCache({
    maxAge: 1000 * 30, // 30 seconds
    max: 999,
});

function getSocialParticipants(zid, uid, limit, mod, lastVoteTimestamp, authorUids) {
    // NOTE ignoring authorUids as part of cacheKey for now, just because.
    var cacheKey = [zid, limit, mod, lastVoteTimestamp].join("_");
    if (socialParticipantsCache.get(cacheKey)) {
        return socialParticipantsCache.get(cacheKey);
    }

    var authorsQuery = authorUids.map(function(authorUid) {
      return "select " + Number(authorUid) + " as uid, 900 as priority";
    });
    authorsQuery = "(" + authorsQuery.join(" union ") + ")";
    if (authorUids.length === 0) {
      authorsQuery = null;
    }

    var q = "with " +
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
        "limit ($3) "+
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

function getFacebookFriendsInConversation(zid, uid) {
    if (!uid) {
        return Promise.resolve([]);
    }
    var p = pgQueryP_readOnly(
        "select * from "+
         "(select * from "+
            "(select * from " +
                "(select friend as uid from facebook_friends where uid = ($2) union select uid from facebook_friends where friend = ($2) union select uid from facebook_users where uid = ($2)) as friends) "+
                // ^ as friends
            "as fb natural left join facebook_users) as fb2 "+
              "inner join (select * from participants where zid = ($1) and (vote_count > 0 OR uid = ($2))) as p on fb2.uid = p.uid;",
              [zid, uid]);
        //"select * from (select * from (select friend as uid from facebook_friends where uid = ($2) union select uid from facebook_friends where friend = ($2)) as friends where uid in (select uid from participants where zid = ($1))) as fb natural left join facebook_users;", [zid, uid]);
    return p;
}

function getFacebookUsersInConversation(zid) {
    var p = pgQueryP_readOnly("select * from facebook_users inner join (select * from participants where zid = ($1) and vote_count > 0) as p on facebook_users.uid = p.uid;", [zid]);
    return p;
}

function getSocialInforForUsers(uids) {
    uids.forEach(function(uid) {
        if (!_.isNumber(uid)) {
            throw "polis_err_123123_invalid_uid got:" + uid;
        }
    });
    if (!uids.length) {
        return Promise.resolve([]);
    }
    var uidString = uids.join(",");
    return pgQueryP_metered_readOnly("getSocialInforForUsers", "with fb as (select * from facebook_users where uid in (" + uidString + ")), tw as (select * from twitter_users where uid in (" + uidString + ")) select * from fb full outer join tw on tw.uid = fb.uid;", []);
}


function getTwitterUsersInConversation(zid, uid, limit) {
    limit = 2;
    var columns = ["pid",
    "participants.uid",
    "zid",
    "participants.created",
    "vote_count",
    "last_interaction",
    "subscribed",
    "last_notified",
    "mod",
    // "uid",
    "twitter_user_id",
    "screen_name",
    "followers_count",
    "friends_count",
    "verified",
    "profile_image_url_https",
    "modified",
    // "created",
    "location",
    // "response",
    "name"].join(",");

    // NOTE: this does not yet prioritize twitter users who you personally follow
    // the second query is for users that are pinned in the conversation. they're included regardless of the limit.
    return pgQueryP_readOnly(
              "select * from (select "+columns+" from participants inner join twitter_users on twitter_users.uid = participants.uid where participants.mod >= 0 and participants.zid = ($1) and (participants.vote_count > 0 OR participants.uid = ($2)) order by followers_count desc limit ($3)) as foo" +
        " UNION select "+columns+" from participants inner join twitter_users on twitter_users.uid = participants.uid where participants.mod >= 2 and participants.zid = ($1) and participants.vote_count > 0 " +
        ";", [zid, uid, limit]);

    // return pgQueryP("select * from participants inner join twitter_users on twitter_users.uid = participants.uid where participants.zid = ($1) and (participants.vote_count > 0 OR participants.uid = ($2));", [zid, uid]).then(function(twitterParticipants) {
    //     if (!twitterParticipants || !twitterParticipants.length) {
    //         return Promise.resolve([]);
    //     }
    //     var twitterIds = _.pluck(twitterParticipants, "twitter_user_id");
    //     return getTwitterUserInfoBulk(twitterIds).then(function(freshTwitterInfos) {
    //         winston.log("info","catsfood", freshTwitterInfos.length);
    //         var twitterIdToIndex = {};
    //         for (var i = 0; i < twitterIds.length; i++) {
    //             twitterIdToIndex[twitterIds[i]] = parseInt(i);
    //         }
    //         winston.log("info","catsfoods");
    //         winston.log("info",twitterIdToIndex);
    //         for (var t = 0; t < freshTwitterInfos.length; t++) {
    //             var info = freshTwitterInfos[t];
    //             var index = twitterIdToIndex[info.id_str];
    //             twitterParticipants[index] = _.extend(twitterParticipants[index], info);
    //         }
    //         return twitterParticipants;
    //     });
    // });
}

function getPolisSocialSettings(zid, uid) {
    return pgQueryP_readOnly("select * from participants inner join social_settings on social_settings.uid = participants.uid where participants.zid = ($1) and (participants.vote_count > 0 OR participants.uid = ($2));", [zid, uid]);
}

function updateVoteCount(zid, pid) {
    // return pgQueryP("update participants set vote_count = vote_count + 1 where zid = ($1) and pid = ($2);",[zid, pid]);
    return pgQueryP("update participants set vote_count = (select count(*) from votes where zid = ($1) and pid = ($2)) where zid = ($1) and pid = ($2)", [zid, pid]);
}


// function dbMigrationAddVoteCount() {
//     function process(x) {
//         winston.log("info","freefood" + x.zid, x.count, x.pid);
//         pgQueryP("update participants set vote_count = ($1) where zid = ($2) and pid = ($3);", [
//                 x.count,
//                 x.zid,
//                 x.pid,
//             ]);
//     }
//     pgQueryP("select zid, pid, count(*) from votes group by zid, pid order by zid, pid, count;",[]).then(function(counts) {
//         // var tasks = [];
//         // for (var i =0; i < counts.length; i++) {
//         //     var x = counts[i];
//         //     tas
//         // }
//         var asdf = setInterval(function() {
//             var x = counts.pop();
//             if (x) {
//                 process(x);
//             } else {
//                 clearInterval(asdf);
//             }
//         }, 20);
//     });
// }
// setTimeout(dbMigrationAddVoteCount, 9999);



// zid_pid => "lastVoteTimestamp:ppaddddaadadaduuuuuuuuuuuuuuuuu"; // not using objects to save some ram
// TODO consider "p2a24a2dadadu15" format
var votesForZidPidCache = new LruCache({
    max: 5000,
});

function getVotesForZidPidWithTimestampCheck(zid, pid, lastVoteTimestamp) {
    var key = zid + "_" + pid;
    var cachedVotes = votesForZidPidCache.get(key);
    if (cachedVotes) {
        var pair = cachedVotes.split(":");
        var cachedTime = Number(pair[0]);
        var votes = pair[1];
        if (cachedTime >= lastVoteTimestamp) {
            return votes;
        }
    }
    return null;
}
function cacheVotesForZidPidWithTimestamp(zid, pid, lastVoteTimestamp, votes) {
    var key = zid + "_" + pid;
    var val = lastVoteTimestamp + ":" + votes;
    votesForZidPidCache.set(key, val);
}


// returns {pid -> "adadddadpupuuuuuuuu"}
function getVotesForZidPidsWithTimestampCheck(zid, pids, lastVoteTimestamp) {
    var cachedVotes = pids.map(function(pid) {
        return {
            pid: pid,
            votes: getVotesForZidPidWithTimestampCheck(zid, pid, lastVoteTimestamp)
        };
    });
    var uncachedPids = cachedVotes.filter(function(o) {
        return !o.votes;
    }).map(function(o) {
        return o.pid;
    });
    cachedVotes = cachedVotes.filter(function(o) {
        return !!o.votes;
    });

    function toObj(items) {
        var o = {};
        for (var i = 0; i < items.length; i++) {
            o[items[i].pid] = items[i].votes;
        }
        return o;
    }

    if (uncachedPids.length === 0) {
        return Promise.resolve(toObj(cachedVotes));
    }
    return getVotesForPids(zid, uncachedPids).then(function(votesRows) {
        var newPidToVotes = aggregateVotesToPidVotesObj(votesRows);
        _.each(newPidToVotes, function(votes, pid) {
            cacheVotesForZidPidWithTimestamp(zid, pid, lastVoteTimestamp, votes);
        });
        var cachedPidToVotes = toObj(cachedVotes);
        return _.extend(newPidToVotes, cachedPidToVotes);
    });
}


function getVotesForPids(zid, pids) {
    if (pids.length === 0) {
        return Promise.resolve([]);
    }
    return pgQueryP_readOnly("select * from votes where zid = ($1) and pid in (" + pids.join(",") + ") order by pid, tid, created;", [zid]);
}



function createEmptyVoteVector(greatestTid) {
    var a = [];
    for (var i = 0; i <= greatestTid; i++) {
        a[i] = "u"; // (u)nseen
    }
    return a;
}
function aggregateVotesToPidVotesObj(votes) {
    var i = 0;
    var greatestTid = 0;
    for (i = 0; i < votes.length; i++) {
        if (votes[i].tid > greatestTid) {
            greatestTid = votes[i].tid;
        }
    }

    // use arrays or strings?
    var vectors = {}; // pid -> sparse array
    for (i = 0; i < votes.length; i++) {
        var v = votes[i];
        // set up a vector for the participant, if not there already

        vectors[v.pid] = vectors[v.pid] || createEmptyVoteVector(greatestTid);
        // assign a vote value at that location
        var vote = v.vote;
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
    var vectors2 = {};
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
        var clusters = o[0];
        var bidToPids = o[1].bidToPid;
        var cluster = clusters[gid];
        if (!cluster) {
            return [];
        }
        var members = cluster.members;
        var pids = [];
        for (var i = 0; i < members.length; i++) {
            var bid = members[i];
            var morePids = bidToPids[bid];
            Array.prototype.push.apply(pids, morePids);
        }
        pids = pids.map(function(x) {
            return parseInt(x);
        });
        pids.sort(function (a,b) {
            return a - b;
        });
        return pids;
    });
}



function geoCodeWithGoogleApi(locationString) {
    var googleApiKey = process.env.GOOGLE_API_KEY;
    var address = encodeURI(locationString);

    return new Promise(function(resolve, reject) {
        request.get("https://maps.googleapis.com/maps/api/geocode/json?address="+ address +"&key="+ googleApiKey).then(function(response) {
            response = JSON.parse(response);
            if (response.status !== "OK") {
                reject("polis_err_geocoding_failed");
                return;
            }
            var bestResult = response.results[0]; // NOTE: seems like there could be multiple responses - using first for now
            resolve(bestResult);
        }, reject).catch(reject);
    });
}

function geoCode(locationString) {
    return pgQueryP("select * from geolocation_cache where location = ($1);", [locationString]).then(function(rows) {
        if (!rows || !rows.length) {
            return geoCodeWithGoogleApi(locationString).then(function(result) {
                winston.log("info",result);
                var lat = result.geometry.location.lat;
                var lng = result.geometry.location.lng;
                // NOTE: not waiting for the response to this - it might fail in the case of a race-condition, since we don't have upsert
                pgQueryP("insert into geolocation_cache (location,lat,lng,response) values ($1,$2,$3,$4);",[
                    locationString,
                    lat,
                    lng,
                    JSON.stringify(result),
                ]);
                var o = {
                    lat: lat,
                    lng: lng,
                };
                return o;
            });
        } else {
            var o = {
                lat: rows[0].lat,
                lng: rows[0].lng,
            };
            return o;
        }
    });
}


var twitterShareCountCache = LruCache({
    maxAge: 1000 * 60 * 30, // 30 minutes
    max: 999,
});

function getTwitterShareCountForConversation(conversation_id) {
    var cached = twitterShareCountCache.get(conversation_id);
    if (cached) {
        return Promise.resolve(cached);
    }
    var httpUrl = "https://cdn.api.twitter.com/1/urls/count.json?url=http://pol.is/" + conversation_id;
    var httpsUrl = "https://cdn.api.twitter.com/1/urls/count.json?url=https://pol.is/" + conversation_id;
    return Promise.all([
        request.get(httpUrl),
        request.get(httpsUrl),
    ]).then(function(a) {
        var httpResult = a[0];
        var httpsResult = a[1];
        var httpCount = JSON.parse(httpResult).count;
        var httpsCount = JSON.parse(httpsResult).count;
        if (httpCount > 0 && httpsCount > 0 && httpCount === httpsCount) {
            console.warn("found matching http and https twitter share counts, if this is common, check twitter api to see if it has changed.");
        }
        var count = httpCount + httpsCount;
        twitterShareCountCache.set(conversation_id, count);
        return count;
    });
}

var fbShareCountCache = LruCache({
    maxAge: 1000 * 60 * 30, // 30 minutes
    max: 999,
});
function getFacebookShareCountForConversation(conversation_id) {
    var cached = fbShareCountCache.get(conversation_id);
    if (cached) {
        return Promise.resolve(cached);
    }
    var url = "http://graph.facebook.com/\?id\=https://pol.is/" + conversation_id;
    return request.get(url).then(function(result) {
        var shares = JSON.parse(result).shares;
        fbShareCountCache.set(conversation_id, shares);
        return shares;
    });
}




app.get("/api/v3/locations",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need("gid", getInt, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var gid = req.p.gid;

    Promise.all([
        getPidsForGid(zid, gid, -1),
        getLocationsForParticipants(zid),
    ]).then(function(o) {
        var pids = o[0];
        var locations = o[1];
        locations = locations.filter(function(locData) {
            var pidIsInGroup = _.indexOf(pids, locData.pid, true) >= 0; // uses binary search
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
});


function removeNullOrUndefinedProperties(o) {
    for (var k in o) {
        var v = o[k];
        if (v === null || v === undefined) {
            delete o[k];
        }
    }
    return o;
}

function pullFbTwIntoSubObjects(ptptoiRecord) {
    var p = ptptoiRecord;
    var x = {};
    _.each(p, function(val, key) {
        var fbMatch = /fb__(.*)/.exec(key);
        var twMatch = /tw__(.*)/.exec(key);
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
            var temp = JSON.parse(x.facebook.fb_public_profile);
            x.facebook.verified = temp.verified;
            // shouln't return this to client
            delete x.facebook.fb_public_profile;
        } catch (e) {
            console.error("error parsing JSON of fb_public_profile for uid: ", p.uid);
        }
    }
    return x;
}

app.put("/api/v3/ptptois",
    moveToBody,
    auth(assignToP),
    need("mod", getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    resolve_pidThing('pid', assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var pid = req.p.pid;
    var mod = req.p.mod;
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
});

app.get("/api/v3/ptptois",
    moveToBody,
    auth(assignToP),
    need('mod', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP),
function(req, res) {
    var zid = req.p.zid;
    var mod = req.p.mod;
    var limit = 999;
    // TODO_SECURITY add check for priviledges
    getSocialParticipantsForMod(zid, limit, mod).then(function(ptptois) {

        ptptois = ptptois.map(removeNullOrUndefinedProperties);
        ptptois = ptptois.map(pullFbTwIntoSubObjects);
        ptptois = ptptois.map(function(p) {
            p.conversation_id = req.p.conversation_id;
            return p;
        });
        res.status(200).json(ptptois);
    }).catch(function(err) {
        fail(res, 500, "polis_err_ptptoi_misc", err);
    });
});

app.get("/api/v3/votes/famous",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('lastVoteTimestamp', getInt, assignToP, -1),
    want('ptptoiLimit', getIntInRange(0,99), assignToP),
function(req, res) {
  var uid = req.p.uid;
  var zid = req.p.zid;
  var lastVoteTimestamp = req.p.lastVoteTimestamp;

  doFamousQuery(req.p, req).then(function(data) {
    res.status(200).json(data);
  }, function(err) {
    fail(res, 500, "polis_err_famous_proj_get2", err);
  }).catch(function(err) {
    fail(res, 500, "polis_err_famous_proj_get1", err);
  });
});



function doFamousQuery(o, req) {
  var uid = o.uid;
  var zid = o.zid;
  var lastVoteTimestamp = o.lastVoteTimestamp;

// NOTE: if this API is running slow, it's probably because fetching the PCA from mongo is slow, and PCA caching is disabled

  var twitterLimit = 999; // we can actually check a lot of these, since they might be among the fb users
  var softLimit = 26;
  var hardLimit = _.isUndefined(o.ptptoiLimit) ? 30 : o.ptptoiLimit;
  var ALLOW_NON_FRIENDS_WHEN_EMPTY_SOCIAL_RESULT = true;
  var mod = 0; // for now, assume all conversations will show unmoderated and approved participants.

  function getAuthorUidsOfFeaturedComments() {
    return getPca(zid, 0).then(function(pcaData) {
      if (!pcaData) {
        return [];
      }
      pcaData = pcaData.asPOJO;
      pcaData.consensus = pcaData.consensus || {};
      pcaData.consensus.agree = pcaData.consensus.agree || [];
      pcaData.consensus.disagree = pcaData.consensus.disagree || [];
      var consensusTids = _.union(
        _.pluck(pcaData.consensus.agree, "tid"),
        _.pluck(pcaData.consensus.disagree, "tid"));

      var groupTids = [];
      for (var gid in pcaData.repness) {
        var commentData = pcaData.repness[gid];
        groupTids = _.union(groupTids, _.pluck(commentData, "tid"));
      }
      var featuredTids = _.union(consensusTids, groupTids);
      featuredTids.sort();
      featuredTids = _.uniq(featuredTids);

      if (featuredTids.length === 0) {
        return [];
      }

      var q = "with "+
        "u as (select distinct(uid) from comments where zid = ($1) and tid in ("+featuredTids.join(",") + ") order by uid) " +
        "select u.uid from u inner join facebook_users on facebook_users.uid = u.uid " +
        "union " +
        "select u.uid from u inner join twitter_users on twitter_users.uid = u.uid " +
        "order by uid;";

      return pgQueryP_readOnly(q, [zid]).then(function(comments) {
        var uids = _.pluck(comments, "uid");
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
    //     var facebookFriends = stuff[0] || [];
    //     var twitterParticipants = stuff[1] || [];
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
        var participantsWithSocialInfo = stuff[0] || [];
        // var facebookFriends = stuff[0] || [];
        // var twitterParticipants = stuff[1] || [];
        // var polisSocialSettings = stuff[2] || [];
        // var myPid = stuff[3];
        // var pidToData = {};
        // var pids = [];
        // twitterParticipants.map(function(p) {
        //     return p.pid;
        // });

        // function shouldSkip(p) {
        //     var pidAlreadyAdded = !!pidToData[p.pid];
        //     var isSelf = p.pid === myPid;
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
            var x = pullFbTwIntoSubObjects(p);
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

        var pids = participantsWithSocialInfo.map(function(p) {
            return p.pid;
        });

        var pidToData = _.indexBy(participantsWithSocialInfo, "pid"); // TODO this is extra work, probably not needed after some rethinking

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

        pids.sort(function(a,b) {
            return a - b;
        });
        pids = _.uniq(pids, true);


        return getVotesForZidPidsWithTimestampCheck(zid, pids, lastVoteTimestamp).then(function(vectors) {

            // TODO parallelize with above query
            return getBidsForPids(zid, -1, pids).then(function(pidsToBids) {
                _.each(vectors, function(value, pid, list) {
                    pid = parseInt(pid);
                    var bid = pidsToBids[pid];
                    var notInBucket = _.isUndefined(bid);
                    var isSelf = pidToData[pid].isSelf;
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

app.get("/api/v3/twitter_users",
    moveToBody,
    authOptional(assignToP),
    want("twitter_user_id", getInt, assignToP), // if not provided, returns info for the signed-in user
function(req, res) {
    var uid = req.p.uid;
    var p;
    if (uid) {
        p = pgQueryP_readOnly("select * from twitter_users where uid = ($1);", [uid]);
    } else if (req.p.twitter_user_id) {
        p = pgQueryP_readOnly("select * from twitter_users where twitter_user_id = ($1);", [req.p.twitter_user_id]);
    } else {
        fail(res, 401, "polis_err_missing_uid_or_twitter_user_id", err);
        return;
    }
    p.then(function(data) {
        data = data[0];
        data.profile_image_url_https = getServerNameWithProtocol(req) + "/twitter_image?id=" + data.twitter_user_id;
        res.status(200).json(data);
    }).catch(function(err) {
        fail(res, 500, "polis_err_twitter_user_info_get", err);
    });
});

app.post("/api/v3/einvites",
    need('email', getEmail, assignToP),
function(req, res) {
    var email = req.p.email;
    generateTokenP(30, false).then(function(einvite) {
        return pgQueryP("insert into einvites (email, einvite) values ($1, $2);", [email, einvite]).then(function(rows) {
            return sendEinviteEmail(req, email, einvite).then(function() {
                res.status(200).json({});
            });
        });
    }).catch(function(err) {
        fail(res, 500, "polis_err_sending_einvite", err);
    });
});


app.get("/api/v3/cache/purge/f2938rh2389hr283hr9823rhg2gweiwriu78",
    // moveToBody,
function(req, res) {

    var hostname = "pol.is";
    // NOTE: can't purge preprod independently unless we set up a separate domain on cloudflare, AFAIK

    request.post("https://www.cloudflare.com/api_json.html").form({
        a: 'fpurge_ts',
        tkn: process.env.CLOUDFLARE_API_KEY,
        email: process.env.CLOUDFLARE_API_EMAIL,
        z: hostname,
        v: 1,
    })
    .pipe(res);

});


app.get("/api/v3/einvites",
    moveToBody,
    need("einvite", getStringLimitLength(1, 100), assignToP),
function(req, res) {
    var einvite = req.p.einvite;

    winston.log("info","select * from einvites where einvite = ($1);", [einvite]);
    pgQueryP("select * from einvites where einvite = ($1);", [einvite]).then(function(rows) {
        if (!rows.length) {
            throw new Error("polis_err_missing_einvite");
        }
        res.status(200).json(rows[0]);
    }).catch(function(err) {
        fail(res, 500, "polis_err_fetching_einvite", err);
    });
});


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
    return buildModerationUrl(req, zinvite) + "/seed";
}

function getConversationUrl(req, zid, dontUseCache) {
    return getZinvite(zid, dontUseCache).then(function(zinvite) {
        return buildConversationUrl(req, zinvite);
    });
}


function createOneSuzinvite(xid, zid, owner, generateSingleUseUrl) {
    return generateSUZinvites(1).then(function(suzinviteArray) {
        var suzinvite = suzinviteArray[0];
        return pgQueryP(
                "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES ($1, $2, $3, $4);",
                [suzinvite, xid, zid, owner])
            .then(function(result) {
                return getZinvite(zid);
            }).then(function(conversation_id) {
                return {
                    zid: zid,
                    conversation_id: conversation_id
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
    var context_id = req.p.context_id;
    var user_id = req.p.user_id;
    var user_image = req.p.user_image;
    var tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;

    var greeting = '';


    // TODO If we're doing this basic form, we can't just return json from the /login call

    var form1 = '' +
'<h2>create a new <img src="https://pol.is/polis-favicon_favicon.png" height="20px"> pol<span class="Logo--blue">.</span>is account</h2>' +
'<p><form role="form" class="FormVertical" action="'+getServerNameWithProtocol(req)+'/api/v3/auth/new" method="POST">' +
'<div class="FormVertical-group">' +
'<label class="FormLabel" for="gatekeeperLoginEmail">Email</label>' +
'<input type="text" id="email" name="email" id="gatekeeperLoginEmail" style="width: 100%;"  class="FormControl" value="'+ (req.p.lis_person_contact_email_primary||"") +'">' +
'</div>' +
'<label class="FormLabel" for="gatekeeperLoginName">Full Name</label>' +
'<input type="text" id="hname" name="hname" id="gatekeeperLoginName" style="width: 100%;"  class="FormControl" value="'+ (req.p.lis_person_name_full||"") +'">' +
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

    var form2 = '' +
'<p> - OR - </p>' +
'<h2>sign in with an existing pol.is account</h2>' +
'<p><form role="form" class="FormVertical" action="'+getServerNameWithProtocol(req)+'/api/v3/auth/login" method="POST">' +
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
        // var customPart = isInstructor ? "you are the instructor" : "you are a Student";

        var html = "" +
        "<!DOCTYPE html><html lang='en'>"+
        '<head>' +
            '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
        '</head>' +
        "<body style='max-width:320px; font-family: Futura, Helvetica, sans-serif;'>"+
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
function(req, res) {
    winston.log("info",req);
    var roles = req.p.roles;
    var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
    var user_id = req.p.user_id;
    var context_id = req.p.context_id;
    var user_image = req.p.user_image || "";
    if (!req.p.tool_consumer_instance_guid) {
        emailBadProblemTime("couldn't find tool_consumer_instance_guid, maybe this isn't Canvas?");
    }

    // TODO SECURITY we need to verify the signature
    var oauth_consumer_key = req.p.oauth_consumer_key;

    var dataSavedPromise = pgQueryP("insert into lti_single_assignment_callback_info (lti_user_id, lti_context_id, lis_outcome_service_url, stringified_json_of_post_content) values ($1, $2, $3, $4);", [
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
                var userForLtiUserId = null;
                (rows||[]).forEach(function(row) {
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
                    winston.log("info",'lti_linkage didnt exist');
                    // Have them sign in again, since they weren't linked.
                    // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
                    renderLtiLinkagePage(req, res);
                }
            }).catch(function(err) {
                fail(res, 500, "polis_err_launching_lti_finding_user", err);
            });
        } else { // no uid (no cookies)
            // Have them sign in to set up the linkage
            winston.log("info",'lti_linkage - no uid');
            renderLtiLinkagePage(req, res);
        }
    }).catch(function(err) {
        fail(res, 500, "polis_err_launching_lti_save", err);
    });
}); // end /api/v3/LTI/setup_assignment


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
// function(req, res) {
//     winston.log("info",req);
//     var roles = req.p.roles;
//     var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
//     var user_id = req.p.user_id;
//     var context_id = req.p.context_id;
//     var user_image = req.p.user_image || "";
//     // if (!req.p.tool_consumer_instance_guid) {
//     //     emailBadProblemTime("couldn't find tool_consumer_instance_guid, maybe this isn't Canvas?");
//     // }

//     winston.log("info",req.p);

//     // // TODO SECURITY we need to verify the signature
//     // var oauth_consumer_key = req.p.oauth_consumer_key;

//     // Check if linked to this uid.
//     pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {


//         var userForLtiUserId = null;
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


//                     var inboxLaunchParams = encodeParams({
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

// }); // end /api/v3/LTI/canvas_nav




function addCanvasAssignmentConversationInfoIfNeeded(zid, tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id) {
    return getCanvasAssignmentInfo(tool_consumer_instance_guid, lti_context_id, custom_canvas_assignment_id).then(function(rows) {
        var exists = rows && rows.length;
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
    winston.log("info",'grades select * from canvas_assignment_conversation_info where tool_consumer_instance_guid = '+tool_consumer_instance_guid+' and lti_context_id = '+lti_context_id+' and custom_canvas_assignment_id = '+custom_canvas_assignment_id+';');
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
function(req, res) {
    var roles = req.p.roles;
    var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
    var isLearner = /[lL]earner/.exec(roles);
    var user_id = req.p.user_id;
    var context_id = req.p.context_id;
    var user_image = req.p.user_image || "";

    winston.log("info","grades req.body " + JSON.stringify(req.body));
    winston.log("info","grades req.p " + JSON.stringify(req.p));

    // TODO SECURITY we need to verify the signature
    var oauth_consumer_key = req.p.oauth_consumer_key;

    function getPolisUserForLtiUser() {
        return pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {
            var userForLtiUserId = null;
            if (rows.length) {
                userForLtiUserId = rows[0];
                winston.log("info",'got user for lti_user_id:' + JSON.stringify(userForLtiUserId));
            }
            return userForLtiUserId;
        });
    }

    if (req.p.lis_result_sourcedid) {
        addCanvasAssignmentConversationCallbackParamsIfNeeded(req.p.user_id, req.p.context_id, req.p.custom_canvas_assignment_id, req.p.tool_consumer_instance_guid, req.p.lis_outcome_service_url, req.p.lis_result_sourcedid, JSON.stringify(req.body)).then(function() {
            winston.log("info","grading info added");
        }).catch(function(err) {
            winston.log("info","grading info error ");
            winston.log("info",err);
        });
    }


    function constructConversationUrl(zid) {
        // sweet! the instructor has created the conversation. send students here. (instructors too)
        return getZinvite(zid).then(function(zinvite) {
            return getServerNameWithProtocol(req) +"/" + zinvite + "/" + encodeParams({
                forceEmbedded: true,
                // this token is used to support cookie-less participation, mainly needed within Canvas's Android webview
                xPolisLti: createPolisLtiToken(req.p.tool_consumer_instance_guid, req.p.user_id),  // x-polis-lti header
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
        var infos = results[0];
        var exists = infos && infos.length;
        var info = infos[0];

        var user = results[1];

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
                    winston.log("info",'lti_linkage didnt exist');
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
                        xPolisLti: createPolisLtiToken(req.p.tool_consumer_instance_guid, req.p.user_id),  // x-polis-lti header
                        tool_consumer_instance_guid: req.p.tool_consumer_instance_guid,
                        context: context_id,
                        custom_canvas_assignment_id: req.p.custom_canvas_assignment_id
                    }));
                } else {
                    var url = getServerNameWithProtocol(req) + "/conversation/create/" +  encodeParams({
                        forceEmbedded: true,
                        tool_consumer_instance_guid: req.p.tool_consumer_instance_guid,
                        context: context_id,
                        custom_canvas_assignment_id: req.p.custom_canvas_assignment_id
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

});



/*
for easy copy and paste
https://preprod.pol.is/api/v3/LTI/setup_assignment.xml
*/
app.get("/api/v3/LTI/setup_assignment.xml",
function(req, res) {
var xml = '' +
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
});



// /*
// https://preprod.pol.is/api/v3/LTI/canvas_nav.xml
// */
// app.get("/api/v3/LTI/canvas_nav.xml",
// function(req, res) {
// var xml = '' +
// '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

// '<blti:title>Pol.is Nav</blti:title>' +
// '<blti:description>Pol.is Conversations</blti:description>' +
// '<blti:icon>' +
// 'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
// '</blti:icon>' +
// // '<blti:launch_url>https://preprod.pol.is/api/v3/LTI/canvas_nav</blti:launch_url>' +

// '<blti:custom>' +
// '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
// '</blti:custom>' +

// '<blti:extensions platform="canvas.instructure.com">' +

//     '<lticm:property name="tool_id">polis_lti</lticm:property>' +
//     '<lticm:property name="privacy_level">public</lticm:property>' +

//     // nav
//     '<lticm:options name="course_navigation">' +
//         '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/canvas_nav</lticm:property>' +
//         '<lticm:property name="text">pol.is</lticm:property>' +
//         '<lticm:property name="visibility">public</lticm:property>' +
//         '<lticm:property name="default">enabled</lticm:property>' +
//         '<lticm:property name="enabled">true</lticm:property>' +
//     '</lticm:options>' +



// '</blti:extensions>' +

// '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
// '<cartridge_icon identifierref="BLTI001_Icon"/>' +
// '</cartridge_basiclti_link>';

// res.set('Content-Type', 'text/xml');
// res.status(200).send(xml);
// });






// // team meetings - schedule with others, smart converence room
// // or redirect tool
// // students already pay an online fee
// //
// // ADA? 508 compliance
// // accessibility - Teach Act: those who don't have dexterity
// // colors
// // screen readers

// // TODO rename to LTI/launch
// // TODO save launch contexts in mongo. For now, to err on the side of collecting extra data, let them be duplicated. Attach a timestamp too.
// // TODO return HTML from the auth functions. the html should contain the token? so that ajax calls can be made.
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
// function(req, res) {
//     var roles = req.p.roles;
//     var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
//     var user_id = req.p.user_id;
//     var context_id = req.p.context_id;
//     var user_image = req.p.user_image || "";



//     // TODO SECURITY we need to verify the signature
//     var oauth_consumer_key = req.p.oauth_consumer_key;

//     var owner = 125;
//     // if (oauth_consumer_key === 'asdfasdf') {
//     //     uid = 125;
//     // }

//     // rich text editor tool embed
//     var ext_content_return_types = req.p.ext_content_return_types;
//     var launch_presentation_return_url = req.p.launch_presentation_return_url;

//     // TODO wait to redirect
//     //https://canvas.instructure.com/doc/api/file.editor_button_tools.html
//     if (/iframe/.exec(ext_content_return_types)) {
//         var path = encodeParams({
//             context: context_id,
//             launch_presentation_return_url_hex: strToHex(launch_presentation_return_url),
//         });
//         res.redirect(getServerNameWithProtocol(req) + "/conversation/create/" + path);
//         return;
//     } else if (ext_content_return_types) {
//         fail(res, 500, "polis_err_unexpected_lti_return_type_for_ext_content_return_types", err);
//     } else {
//         fail(res, 500, "polis_err_unexpected_launch_params", err);
//     }

// }); // end editor_tool


function redirectToLtiEditorDestinationWithDetailsAboutIframe(req, res, launch_presentation_return_url, url, width, height) {
    res.redirect(launch_presentation_return_url + "?" + [
        ["return_type", "iframe"].join("="),
        ["url", url].join("="),
        ["width", width].join("="),
        ["height", height].join("="),
        ].join("&"));
}

function redirectToLtiEditorDestinationWithDetailsAboutLtiLink(req, res, launch_presentation_return_url, url) {
    res.redirect(launch_presentation_return_url + "?" + [
        ["return_type", "lti_launch_url"].join("="),
        ["url", url].join("="),
        ["title", "external tool title 123"].join("="),
        ["text", "link text here"].join("="),
        ].join("&"));
}



// /*
// for easy copy and paste
// https://preprod.pol.is/api/v3/LTI/editor_tool.xml
// */
// app.get("/api/v3/LTI/editor_tool.xml",
// function(req, res) {
// var xml = '' +
// '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

// '<blti:title>Polis Editor Tool</blti:title>' +
// '<blti:description>based on Minecraft LMS integration</blti:description>' +
// '<blti:icon>' +
// 'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
// '</blti:icon>' +
// '<blti:launch_url>https://preprod.pol.is/api/v3/LTI/editor_tool</blti:launch_url>' +

// '<blti:custom>' +
// '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
// '</blti:custom>' +

// '<blti:extensions platform="canvas.instructure.com">' +

//     '<lticm:property name="tool_id">polis_lti</lticm:property>' +
//     '<lticm:property name="privacy_level">public</lticm:property>' +

//     // editor button
//     '<lticm:property name="domain">preprod.pol.is</lticm:property>' +
//     '<lticm:property name="text">Polis Foo Test</lticm:property>' +
//     '<lticm:options name="editor_button">' +
//         '<lticm:property name="enabled">true</lticm:property>' +
//         '<lticm:property name="icon_url">https://preprod.pol.is/polis-favicon_favicon.png</lticm:property>' +
//         '<lticm:property name="selection_width">500</lticm:property>' +
//         '<lticm:property name="selection_height">300</lticm:property>' +
//     '</lticm:options>' +


// '</blti:extensions>' +

// '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
// '<cartridge_icon identifierref="BLTI001_Icon"/>' +
// '</cartridge_basiclti_link>';

// res.set('Content-Type', 'text/xml');
// res.status(200).send(xml);
// });






// This approach does not work on the current canvas iOS app.
//
// // TODO rename to LTI/launch
// // TODO save launch contexts in mongo. For now, to err on the side of collecting extra data, let them be duplicated. Attach a timestamp too.
// // TODO return HTML from the auth functions. the html should contain the token? so that ajax calls can be made.
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
// function(req, res) {
//     var roles = req.p.roles;
//     var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
//     var user_id = req.p.user_id;
//     var context_id = req.p.context_id;
//     var user_image = req.p.user_image || "";
//     // TODO SECURITY we need to verify the signature
//     var oauth_consumer_key = req.p.oauth_consumer_key;
//     var owner = 125;
//     // if (oauth_consumer_key === 'asdfasdf') {
//     //     uid = 125;
//     // }
//     // rich text editor tool embed
//     var ext_content_return_types = req.p.ext_content_return_types;
//     var launch_presentation_return_url = req.p.launch_presentation_return_url;
//     // TODO wait to redirect
//     //https://canvas.instructure.com/doc/api/file.editor_button_tools.html
//     if (/iframe/.exec(ext_content_return_types)) {
//         var url = getServerNameWithProtocol(req) + "/api/v3/LTI/setup_assignment";
//         redirectToLtiEditorDestinationWithDetailsAboutLtiLink(req, res, launch_presentation_return_url, url);
//     } else if (ext_content_return_types) {
//         fail(res, 500, "polis_err_unexpected_lti_return_type_for_ext_content_return_types", err);
//     } else {
//         fail(res, 500, "polis_err_unexpected_launch_params", err);
//     }
// }); // end editor_tool_for_setup

// This approach does not work on the current canvas iOS app.
//
// app.get("/api/v3/LTI/editor_tool_for_setup.xml",
// function(req, res) {
// var xml = '' +
// '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +
// '<blti:title>Polis Editor Tool For Setup</blti:title>' +
// '<blti:description>based on Minecraft LMS integration</blti:description>' +
// '<blti:icon>' +
// 'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
// '</blti:icon>' +
// '<blti:launch_url>https://preprod.pol.is/api/v3/LTI/editor_tool_for_setup</blti:launch_url>' +
// '<blti:custom>' +
// '<lticm:property name="custom_canvas_xapi_url">$Canvas.xapi.url</lticm:property>' +
// '</blti:custom>' +
// '<blti:extensions platform="canvas.instructure.com">' +
//     '<lticm:property name="tool_id">polis_lti</lticm:property>' +
//     '<lticm:property name="privacy_level">public</lticm:property>' +
//     // editor button
//     '<lticm:property name="domain">preprod.pol.is</lticm:property>' +
//     '<lticm:property name="text">Polis SETUP EDITOR TOOL</lticm:property>' +
//     '<lticm:options name="editor_button">' +
//         '<lticm:property name="enabled">true</lticm:property>' +
//         '<lticm:property name="icon_url">https://preprod.pol.is/polis-favicon_favicon.png</lticm:property>' +
//         '<lticm:property name="selection_width">50</lticm:property>' +
//         '<lticm:property name="selection_height">50</lticm:property>' +
//     '</lticm:options>' +
// '</blti:extensions>' +
// '<cartridge_bundle identifierref="BLTI001_Bundle"/>' +
// '<cartridge_icon identifierref="BLTI001_Icon"/>' +
// '</cartridge_basiclti_link>';
// res.set('Content-Type', 'text/xml');
// res.status(200).send(xml);
// });



















/*
for easy copy and paste
https://pol.is/api/v3/LTI/conversation_assignment.xml
https://preprod.pol.is/api/v3/LTI/conversation_assignment.xml
*/
app.get("/api/v3/LTI/conversation_assignment.xml",
function(req, res) {
    var serverName = getServerNameWithProtocol(req);

var xml = '' +
'<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

'<blti:title>Polis Conversation Setup</blti:title>' +
'<blti:description>Polis conversation</blti:description>' +
// '<blti:icon>' +
// 'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
// '</blti:icon>' +
'<blti:launch_url>'+serverName+'/api/v3/LTI/conversation_assignment</blti:launch_url>' +

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
        '<lticm:property name="url">'+serverName+'/api/v3/LTI/conversation_assignment</lticm:property>' +  // ?
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
});


app.get("/canvas_app_instructions.png",
function(req, res) {
    var path = "/landerImages/";
    if (/Android/.exec(req.headers['user-agent'])) {
        path += "app_instructions_android.png";
    } else if (/iPhone.*like Mac OS X/.exec(req.headers['user-agent'])) {
        path += "app_instructions_ios.png";
    } else {
        path += "app_instructions_blank.png";
    }
    var doFetch = makeFileFetcher(hostname, portForParticipationFiles, path, {'Content-Type': "image/png"});
    doFetch(req, res);
});


// app.post("/api/v3/users/invite",
//     // authWithApiKey(assignToP),
//     auth(assignToP),
//     need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
//     need('single_use_tokens', getBool, assignToP),
//     need('xids', getArrayOfStringNonEmpty, assignToP),
// function(req, res) {
//     var owner = req.p.uid;
//     var xids = req.p.xids;
//     var zid = req.p.zid;


//     // generate some tokens
//     // add them to a table paired with user_ids
//     // return URLs with those.
//     generateSUZinvites(xids.length).then(function(suzinviteArray) {
//         var pairs = _.zip(xids, suzinviteArray);

//         var valuesStatements = pairs.map(function(pair) {
//             var xid = escapeLiteral(pair[0]);
//             var suzinvite = escapeLiteral(pair[1]);
//             var statement = "("+ suzinvite + ", " + xid + "," + zid+","+owner+")";
//             winston.log("info",statement);
//             return statement;
//         });
//         var query = "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " + valuesStatements.join(",") + ";";
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
// });

function sendSuzinviteEmail(req, email, conversation_id, suzinvite) {
    var serverName = getServerNameWithProtocol(req);
    var body = "" +
        "Welcome to pol.is!\n" +
        "\n" +
        "Click this link to open your account:\n" +
        "\n" +
        serverName + "/ot/"+ conversation_id +"/" + suzinvite + "\n" +
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

app.post("/api/v3/users/invite",
    // authWithApiKey(assignToP),
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    // need('single_use_tokens', getBool, assignToP),
    need('emails', getArrayOfStringNonEmpty, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var emails = req.p.emails;
    var zid = req.p.zid;
    var conversation_id = req.p.conversation_id;

    getConversationInfo(zid).then(function(conv) {

        var owner = conv.owner;

        // generate some tokens
        // add them to a table paired with user_ids
        // return URLs with those.
        generateSUZinvites(emails.length).then(function(suzinviteArray) {
            var pairs = _.zip(emails, suzinviteArray);

            var valuesStatements = pairs.map(function(pair) {
                var xid = escapeLiteral(pair[0]);
                var suzinvite = escapeLiteral(pair[1]);
                var statement = "("+ suzinvite + ", " + xid + "," + zid+","+owner+")";
                winston.log("info",statement);
                return statement;
            });
            var query = "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " + valuesStatements.join(",") + ";";
            winston.log("info",query);
            pgQuery(query, [], function(err, results) {
                if (err) { fail(res, 500, "polis_err_saving_invites", err); return; }

                Promise.all(pairs.map(function(pair) {
                    var email = pair[0];
                    var suzinvite = pair[1];
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
});



// // BEGIN GITHUB OAUTH2 ROUTES

// // Initial page redirecting to Github
// app.get('/auth', function (req, res) {
//     res.redirect(authorization_uri);
// });

// // Callback service parsing the authorization token and asking for the access token
// app.get('/oauth2/oauth2_github_callback', function (req, res) {

//   function saveToken(error, result) {
//     if (error) {
//         winston.log("info",'Access Token Error', error.message);
//         fail(res, 500, "polis_err_oauth_callback_github", error);
//     }
//     var token = oauth2.AccessToken.create(result);
//     winston.log("info","thetoken", token);
//     winston.log("info",token);
//     winston.log("info","thetoken", token);
//     // res.status(200).end();
//     res.redirect("/inboxApiTest"); // got the token, go somewhere when auth is done.
//   }

//   var code = req.query.code;
//   winston.log("info",'/oauth2/oauth2_github_callback');
//   oauth2.AuthCode.getToken({
//     code: code,
//     redirect_uri: 'https://preprod.pol.is/oauth2/oauth2_github_callback'
//   }, saveToken);


// });

// app.get('/oauthTest', function (req, res) {
//   res.send('Hello World');
// });

// // END GITHUB OAUTH2 ROUTES










function initializeImplicitConversation(site_id, page_id, o) {

    // find the user with that site_id.. wow, that will be a big index..
    // I suppose we could duplicate the site_ids that actually have conversations
    // into a separate table, and search that first, only searching users if nothing is there.
    return pgQueryP_readOnly("select uid from users where site_id = ($1) and site_owner = TRUE;",[site_id]).then(function(rows) {
        if (!rows || !rows.length) {
            throw new Error("polis_err_bad_site_id");
        }
        return new Promise(function(resolve, reject) {


        var uid = rows[0].uid;
//    create a conversation for the owner we got,
        var generateShortUrl = false;

        isUserAllowedToCreateConversations(uid, function(err, isAllowed) {
            if (err) { reject(err); return; }
            if (!isAllowed) { reject(err); return; }

            var params = _.extend(o, {
                owner: uid,
                // topic: req.p.topic,
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

            var q = sql_conversations.insert(params).returning('*').toString();

            pgQuery(q, [], function(err, result) {
                if (err) {
                    if (isDuplicateKey(err)) {
                        yell(err);
                        reject("polis_err_create_implicit_conv_duplicate_key");
                    } else {
                        reject("polis_err_create_implicit_conv_db");
                    }
                }

                var zid = result && result.rows && result.rows[0] && result.rows[0].zid;

                Promise.all([
                    registerPageId(site_id, page_id, zid),
                    generateAndRegisterZinvite(zid, generateShortUrl),
                ]).then(function(o) {
                    var notNeeded = o[0];
                    var zinvite = o[1];
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
    var body = "" +
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

        var emails = _.pluck(rows, "email");
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

// NOTE: this isn't optimal
// rather than code for a new URL scheme for implicit conversations,
// the idea is to redirect implicitly created conversations
// to their zinvite based URL after creating the conversation.
// To improve conversation load time, this should be changed so that it
// does not redirect, and instead serves up the index.
// The routers on client and server will need to be updated for that
// as will checks like isParticipationView on the client.
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
    want('ucv', getBool, assignToP), // not persisted
    want('ucw', getBool, assignToP), // not persisted
    want('ucst', getBool, assignToP), // not persisted
    want('ucsd', getBool, assignToP), // not persisted
    want('ucsv', getBool, assignToP), // not persisted
    want('ucsf', getBool, assignToP), // not persisted
function(req, res) {
    var site_id = /polis_site_id[^\/]*/.exec(req.path);
    var page_id = /\S\/([^\/]*)/.exec(req.path);
    if (!site_id.length || page_id.length < 2) {
        fail(res, 404, "polis_err_parsing_site_id_or_page_id");
    }
    site_id = site_id[0];
    page_id = page_id[1];

    var ucv = req.p.ucv;
    var ucw = req.p.ucw;
    var ucst = req.p.ucst;
    var ucsd = req.p.ucsd;
    var ucsv = req.p.ucsv;
    var ucsf = req.p.ucsf;
    var o = {};
    ifDefinedSet("parent_url", req.p, o);
    ifDefinedSet("auth_needed_to_vote", req.p, o);
    ifDefinedSet("auth_needed_to_write", req.p, o);
    ifDefinedSet("auth_opt_fb", req.p, o);
    ifDefinedSet("auth_opt_tw", req.p, o);
    ifDefinedSet("auth_opt_allow_3rdparty", req.p, o);
    if (!_.isUndefined(req.p.show_vis)) {
        o.vis_type = req.p.show_vis ? 1 : 0;
    }

    // Set stuff in cookies to be retrieved when POST participants is called.
    var setOnPolisDomain = !domainOverride;
    var origin = req.headers.origin || "";
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
                var url = buildConversationUrl(req, conv.zinvite);
                var modUrl = buildModerationUrl(req, conv.zinvite);
                var seedUrl = buildSeedUrl(req, conv.zinvite);
                sendImplicitConversationCreatedEmails(site_id, page_id, url, modUrl, seedUrl).then(function() {
                    winston.log("info",'email sent');
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
                var url = buildConversationUrl(req, conversation_id);
                url = appendParams(url);
                res.redirect(url);
            }).catch(function(err) {
                fail(res, 500, "polis_err_finding_conversation_id", err);
            });
        }
    }).catch(function(err) {
        fail(res, 500, "polis_err_redirecting_to_conv", err);
    });
});

//app.use(express.static(__dirname + '/src/desktop/index.html'));
//app.use('/static', express.static(__dirname + '/src'));

//app.get('/', staticFile);



// function staticFile(req, res) {
//     // try to serve a static file
//     var requestPath = req.url;
//     // var contentPath = './src';
//     // Don't use this approach without protecting against arbitrary file access
//     // if (/^\/[0-9]/.exec(requestPath) || requestPath === '/') {
//     //     contentPath += '/desktop/index.html';
//     // } else if (requestPath.indexOf('/static/') === 0) {
//     //     contentPath += requestPath.slice(7);
//     // }
//     getStaticFile(contentPath, res);
// }


// this cache currently never expires
// filename -> content
var staticFileCache = {};
function getStaticFile(contentPath, res) {
    var extname = path.extname(contentPath);
    var contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.woff':
            contentType = 'application/x-font-woff';
            break;
    }

    function onSuccess(content) {
        res.setHeader('Content-Type', contentType);
        res.status(200);
        res.send(content);
    }
    function onMissing() {
        res.setHeader(404);
        res.json({status: 404});
    }

    if (staticFileCache[contentPath]) {
        onSuccess(staticFileCache[contentPath]);
    } else {
        fs.exists(contentPath, function(exists) {
            if (!exists) { return onMissing(); }
            fs.readFile(contentPath, function(error, content) {
                if (error) { return onMissing(); }
                staticFileCache[contentPath] = content;
                onSuccess(content);
            });
        });
    }
}


var routingProxy = new httpProxy.RoutingProxy();

function addStaticFileHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', 0);
}

function proxy(req, res) {
    var hostname = buildStaticHostname(req, res);
    if (!hostname) {

        var host = req.headers.host || "";
        if (host.match(/polisapp.herokuapp.com$/)) {
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


        var port = process.env.STATIC_FILES_PORT;
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
        var origin = req.headers.host;
        if (!whitelistedBuckets[origin]) {
            console.error("got request with host that's not whitelisted: (" + req.headers.host + ")");
            return;
        }
        if (/about.polis.io/.exec(origin)) {
            return process.env.STATIC_FILES_ABOUTPAGE_HOST;
        }
        origin = whitelistedBuckets[origin];
        return origin + "." + process.env.STATIC_FILES_HOST;
    }
}

function makeRedirectorTo(path) {
  return function(req, res) {
    var protocol = devMode ? "http://" : "https://";
    var url = protocol + req.headers.host + path;
    res.writeHead(302, {
        Location: url
    });
    res.end();
  };
}


function makeFileFetcher(hostname, port, path, headers, preloadData) {

    return function(req, res) {
        var hostname = buildStaticHostname(req, res);
        if (!hostname) {
            fail(res, 500, "polis_err_file_fetcher_serving_to_domain");
            console.error(req.headers.host);
            console.error(req.path);
            return;
        }
        var url;
        if (devMode) {
            url = "http://" + hostname + ":" + port + path;
        } else {
            // pol.is.s3-website-us-east-1.amazonaws.com
            // preprod.pol.is.s3-website-us-east-1.amazonaws.com

            // TODO https - buckets would need to be renamed to have dashes instead of dots.
            // http://stackoverflow.com/questions/3048236/amazon-s3-https-ssl-is-it-possible
            url = "http://" + hostname + path;
        }
        winston.log("info","fetch file from " + url);
        var x = request(url);
        req.pipe(x);
        if (!_.isUndefined(preloadData)) {
            x = x.pipe(replaceStream("\"REPLACE_THIS_WITH_PRELOAD_DATA\"", JSON.stringify(preloadData)));
        }
        // var title = "foo";
        // var description = "bar";
        // var site_name = "baz";

        var fbMetaTagsString = "<meta property=\"og:image\" content=\"https://s3.amazonaws.com/pol.is/polis_logo.png\" />\n";
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

function isIE(req) {
    var h = req.headers['user-agent'];
    return /MSIE [0-9]/.test(h) || /Trident/.test(h);
}

function isUnsupportedBrowser(req) {
    return /MSIE [234567]/.test(req.headers['user-agent']);
}
function browserSupportsPushState(req) {
    return !/MSIE [23456789]/.test(req.headers['user-agent']);
}

// serve up index.html in response to anything starting with a number
var hostname = process.env.STATIC_FILES_HOST;
var portForParticipationFiles = process.env.STATIC_FILES_PORT;
var portForAdminFiles = process.env.STATIC_FILES_ADMINDASH_PORT;

var fetchUnsupportedBrowserPage = makeFileFetcher(hostname, portForParticipationFiles, "/unsupportedBrowser.html", {'Content-Type': "text/html"});

function fetchIndex(req, res, preloadData, port) {
    var headers = {'Content-Type': "text/html"};
    if (!devMode) {
        _.extend(headers, {
          'Cache-Control': 'no-transform,public,max-age=60,s-maxage=60', // Cloudflare will probably cache it for one or two hours
      });
    }
    var doFetch = makeFileFetcher(hostname, port, "/index.html", headers, preloadData);
    if (isUnsupportedBrowser(req)){

        return fetchUnsupportedBrowserPage(req, res);

    } else if (!browserSupportsPushState(req) &&
        req.path.length > 1 &&
        !/^\/api/.exec(req.path) // TODO probably better to create a list of client-side route regexes (whitelist), rather than trying to blacklist things like API calls.
        ) {

        // Redirect to the same URL with the path behind the fragment "#"
        res.writeHead(302, {
            Location: "https://" + req.headers.host +"/#"+ req.path,
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
    var match = req.path.match(/[0-9][0-9A-Za-z]+/);
    var conversation_id;
    if (match && match.length) {
        conversation_id = match[0];
    }

    setTimeout(function() {
        // Kick off requests to twitter and FB to get the share counts.
        // This will be nice because we cache them so it will be fast when
        // client requests these later.
        // TODO actually store these values in a cache that is shared between
        // the servers, probably just in the db.
        getTwitterShareCountForConversation(conversation_id).catch(function (err) {
            console.log("fetchIndexForConversation/getTwitterShareCountForConversation err " + err);
        });
        getFacebookShareCountForConversation(conversation_id).catch(function (err) {
            console.log("fetchIndexForConversation/getFacebookShareCountForConversation err " + err);
        });
    }, 100);

    getZidFromConversationId(conversation_id).then(function(zid) {
        return Promise.all([
            getConversationInfo(zid),
            // optionalItems,
        ]);
    }).then(function(a) {
        var conv = a[0];
        var optionalResults = a[1];

        var auth_opt_allow_3rdparty = ifDefinedFirstElseSecond(conv.auth_opt_allow_3rdparty , true);
        var auth_opt_fb_computed = auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_fb , true);
        var auth_opt_tw_computed = auth_opt_allow_3rdparty && ifDefinedFirstElseSecond(conv.auth_opt_tw , true);

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
            auth_needed_to_write: ifDefinedFirstElseSecond(conv.auth_needed_to_write , true),
            auth_opt_allow_3rdparty: auth_opt_allow_3rdparty,
            auth_opt_fb_computed: auth_opt_fb_computed,
            auth_opt_tw_computed: auth_opt_tw_computed,
        };
        conv.conversation_id = conversation_id;
        // conv = _.extend({}, optionalResults, conv);
        return conv;
    }).then(function(x) {
        var preloadData = {
            conversation: x,
            // Nothing user-specific can go here, since we want to cache these per-conv index files on the CDN.
        };
        fetchIndex(req, res, preloadData, portForParticipationFiles);
    }).catch(function(err) {
        fail(res, 500, "polis_err_fetching_conversation_info2", err);
    });
}


var fetchIndexForAdminPage = makeFileFetcher(hostname, portForAdminFiles, "/index_admin.html", {'Content-Type': "text/html"});

app.get(/^\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // conversation view
app.get(/^\/explore\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // power view
app.get(/^\/share\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // share view
app.get(/^\/summary\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // summary view
app.get(/^\/ot\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForConversation); // conversation view, one-time url
// TODO consider putting static files on /static, and then using a catch-all to serve the index.
app.get(/^\/conversation\/create(\/.*)?/, fetchIndexWithoutPreloadData);
app.get(/^\/user\/create(\/.*)?$/, fetchIndexWithoutPreloadData);
app.get(/^\/user\/login(\/.*)?$/, fetchIndexWithoutPreloadData);
app.get(/^\/welcome\/.*$/, fetchIndexWithoutPreloadData);
app.get(/^\/settings(\/.*)?$/, fetchIndexWithoutPreloadData);
app.get(/^\/user\/logout(\/.*)?$/, fetchIndexWithoutPreloadData);

// admin dash routes
app.get(/^\/m\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/integrate(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/account(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/conversations(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/signout(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/signin(\/.*)?/, fetchIndexForAdminPage);
app.get(/^\/dist\/admin_bundle.js$/, makeFileFetcher(hostname, portForAdminFiles, "/dist/admin_bundle.js", {'Content-Type': "application/javascript"}));
app.get(/^\/__webpack_hmr$/, makeFileFetcher(hostname, portForAdminFiles, "/__webpack_hmr", {'Content-Type': "eventsource"}));
// admin dash-based landers
app.get(/^\/home(\/.*)?/, fetchIndexForAdminPage);


app.get("/iip/:conversation_id",
// function(req, res, next) {
//     req.p.conversation_id = req.params.conversation_id;
//     next();
// },
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var conversation_id = req.params.conversation_id;
    res.set({
        'Content-Type': 'text/html',
    });
    res.send("<a href='https://pol.is/" + conversation_id + "' target='_blank'>" + conversation_id + "</a>");
});
// app.get(/^\/iip\/([0-9][0-9A-Za-z]+)$/, fetchIndex);

app.get("/iim/:conversation_id",
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var zid = req.p.zid;
    var conversation_id = req.params.conversation_id;
    getConversationInfo(zid).then(function(info) {
        res.set({
            'Content-Type': 'text/html',
        });
        var title = info.topic || info.created;
        res.send("<a href='https://pol.is/" + conversation_id + "' target='_blank'>" + title + "</a>" +
                "<p><a href='https://pol.is/m" + conversation_id + "' target='_blank'>moderate</a></p>" +
                (info.description ? "<p>"+info.description+"</p>" : "")
                );
    }).catch(function(err) {
        fail(res, 500, "polis_err_fetching_conversation_info", err);
    });
});
// app.get(/^\/iim\/([0-9][0-9A-Za-z]+)$/, fetchIndex);




function makeReactClientProxy(hostname, port) {
    return function(req, res) {
        var temp = req.path.split("/");
        temp.shift();
        temp.shift();
        var path = "/" + temp.join("/");
        var url;
        if (devMode) {
            url = "http://" + hostname + ":" + port + path;
        } else {
            fail(res, 404, "polis_err_finding_file " + path);
            return;
        }
        console.log("ORIG", req.path);
        console.log("URL", url);
        var x = request(url);
        req.pipe(x);
        x.pipe(res);
        x.on("error", function(err) {
            fail(res, 500, "polis_err_finding_file " + path, err);
        });
    };
}



app.get(/^\/react(\/.*)?$/, makeReactClientProxy("localhost", 3000));
app.get(/^\/inbox(\/.*)?$/, fetchIndexWithoutPreloadData);
app.get(/^\/r/, fetchIndexWithoutPreloadData);
app.get(/^\/hk/, fetchIndexWithoutPreloadData);
app.get(/^\/s\//, fetchIndexWithoutPreloadData);
app.get(/^\/s$/, fetchIndexWithoutPreloadData);
app.get(/^\/hk\/new/, fetchIndexWithoutPreloadData);
app.get(/^\/inboxApiTest/, fetchIndexWithoutPreloadData);
app.get(/^\/pwresetinit.*/, fetchIndexForAdminPage);
app.get(/^\/demo\/[0-9][0-9A-Za-z]+/, fetchIndexForConversation);
app.get(/^\/pwreset.*/, fetchIndexForAdminPage);
app.get(/^\/prototype.*/, fetchIndexWithoutPreloadData);
app.get(/^\/plan.*/, fetchIndexWithoutPreloadData);
app.get(/^\/professors$/, makeFileFetcher(hostname, portForParticipationFiles, "/lander.html", {'Content-Type': "text/html"}));
app.get(/^\/football$/, makeFileFetcher(hostname, portForParticipationFiles, "/football.html", {'Content-Type': "text/html"}));
app.get(/^\/pricing$/, makeFileFetcher(hostname, portForParticipationFiles, "/pricing.html", {'Content-Type': "text/html"}));
app.get(/^\/news$/, fetchIndexForAdminPage);
app.get(/^\/company$/, makeFileFetcher(hostname, portForParticipationFiles, "/company.html", {'Content-Type': "text/html"}));
app.get(/^\/api$/, function (req, res) { res.redirect("/docs/api/v3");});
app.get(/^\/docs\/api$/, function (req, res) { res.redirect("/docs/api/v3");});
app.get(/^\/docs\/api\/v3$/, makeFileFetcher(hostname, portForParticipationFiles, "/api_v3.html", {'Content-Type': "text/html"}));
app.get(/^\/embed$/, makeFileFetcher(hostname, portForParticipationFiles, "/embed.html", {'Content-Type': "text/html"}));
app.get(/^\/politics$/, makeFileFetcher(hostname, portForParticipationFiles, "/politics.html", {'Content-Type': "text/html"}));
app.get(/^\/marketers$/, makeFileFetcher(hostname, portForParticipationFiles, "/marketers.html", {'Content-Type': "text/html"}));
app.get(/^\/faq$/, makeFileFetcher(hostname, portForParticipationFiles, "/faq.html", {'Content-Type': "text/html"}));
app.get(/^\/blog$/, makeFileFetcher(hostname, portForParticipationFiles, "/blog.html", {'Content-Type': "text/html"}));
app.get(/^\/billions$/, makeFileFetcher(hostname, portForParticipationFiles, "/billions.html", {'Content-Type': "text/html"}));
app.get(/^\/plus$/, makeFileFetcher(hostname, portForParticipationFiles, "/plus.html", {'Content-Type': "text/html"}));
app.get(/^\/tos$/, makeFileFetcher(hostname, portForParticipationFiles, "/tos.html", {'Content-Type': "text/html"}));
app.get(/^\/privacy$/, makeFileFetcher(hostname, portForParticipationFiles, "/privacy.html", {'Content-Type': "text/html"}));
app.get(/^\/canvas_setup_backup_instructions$/, makeFileFetcher(hostname, portForParticipationFiles, "/canvas_setup_backup_instructions.html", {'Content-Type': "text/html"}));
app.get(/^\/styleguide$/, makeFileFetcher(hostname, portForParticipationFiles, "/styleguide.html", {'Content-Type': "text/html"}));
// Duplicate url for content at root. Needed so we have something for "About" to link to.
app.get(/^\/about$/, makeRedirectorTo("/home"));
app.get(/^\/s\/CTE\/?$/, makeFileFetcher(hostname, portForParticipationFiles, "/football.html", {'Content-Type': "text/html"}));
app.get(/^\/wimp$/, makeFileFetcher(hostname, portForParticipationFiles, "/wimp.html", {'Content-Type': "text/html"}));
app.get(/^\/edu$/, makeFileFetcher(hostname, portForParticipationFiles, "/lander.html", {'Content-Type': "text/html"}));
app.get(/^\/try$/, makeFileFetcher(hostname, portForParticipationFiles, "/try.html", {'Content-Type': "text/html"}));
app.get(/^\/twitterAuthReturn$/, makeFileFetcher(hostname, portForParticipationFiles, "/twitterAuthReturn.html", {'Content-Type': "text/html"}));

// proxy for fetching twitter profile images
// Needed because Twitter doesn't provide profile pics in response to a request - you have to fetch the user info, then parse that to get the URL, requiring two round trips.
// There is a bulk user data API, but it's too slow to block on in our /famous route.
// So references to this route are injected into the twitter part of the /famous response.
app.get("/twitter_image",
    moveToBody,
    need('id', getStringLimitLength(999), assignToP),
function(req, res) {
    getTwitterUserInfo({twitter_user_id: req.p.id}, true).then(function(data) {
        data = JSON.parse(data);
        if (!data || !data.length) {
            fail(res, 500, "polis_err_finding_twitter_user_info");
            return;
        }
        data = data[0];
        var url = data.profile_image_url; // not https to save a round-trip

        var finished = false;
        http.get(url, function(twitterResponse) {
            if (!finished) {
                clearTimeout(timeoutHandle);
                finished = true;
                res.setHeader('Cache-Control', 'no-transform,public,max-age=18000,s-maxage=18000');
                twitterResponse.pipe(res);
            }
        }).on("error", function(e) {
            fail(res, 500, "polis_err_finding_file " + url, err);
        });

        var timeoutHandle = setTimeout(function() {
            if (!finished) {
                finished = true;
                res.writeHead(504);
                res.end("request timed out");
                console.log("twitter_image timeout");
            }
        }, 9999);

    }).catch(function(err) {
        res.status(404).end();
    });
});


var conditionalIndexFetcher = (function() {
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
            var url = getServerNameWithProtocol(req) + "/home";
            res.redirect(url);
        }
    };
}());

app.get("/", conditionalIndexFetcher);





app.get(/^\/localFile\/.*/, function(req, res) {
    var filename = String(req.path).split("/");
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
        }
        else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
        }
    });
});

// proxy everything else
app.get(/^\/[^(api\/)]?.*/, proxy);


app.listen(process.env.PORT);

winston.log("info",'started on port ' + process.env.PORT);
} // End of initializePolisAPI

async.parallel([connectToMongo], initializePolisAPI);

}());
