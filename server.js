(function() { "use strict";

/*
    DNS notes:

    Mailgun verification:
     mx._domainkey.polis.io
     polis.io TXT record v=spf1 include:mailgun.org ~all

    Mailgun open/click tracking
     CNAME email.polis.io => mailgun.org


*/

console.log('redisAuth url ' +process.env.REDISTOGO_URL);
console.log('redisCloud url ' +process.env.REDISCLOUD_URL);

//require('nodefly').profile(
    //process.env.NODEFLY_APPLICATION_KEY,
    //[process.env.APPLICATION_NAME,'Heroku']
//);

var badwords = require('badwords/object'),
    dgram = require('dgram'),
    http = require('http'),
    httpProxy = require('http-proxy'),
    https = require('https'),
    Promise = require('es6-promise').Promise,
    express = require('express'),
    app = express(),
    sql = require("sql"),
    escapeLiteral = require('pg').Client.prototype.escapeLiteral,
    pg = require('pg').native, //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
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
    request = require('request'),
    SimpleCache = require("simple-lru-cache"),
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY),    
    _ = require('underscore');


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
    console.log("heapUsed: " + heapUsed);
    var start = Date.now();
    metric("api.process.mem.heapUsed", heapUsed, start);
    metric("api.process.mem.rss", rss, start);
    metric("api.process.mem.heapTotal", heapTotal, start);
}, 10*1000);


// BEGIN GITHUB OAUTH2
var CLIENT_SECRET = "0b178e412a10fa023a0153bf7cefaf6dae0f74b9";
var CLIENT_ID = "109a1eb4732b3ec1075b";
var oauth2 = require('simple-oauth2')({
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  site: 'https://github.com/login',
  tokenPath: '/oauth/access_token'
});

console.dir(oauth2);

// Authorization uri definition
var authorization_uri = oauth2.AuthCode.authorizeURL({
  redirect_uri: 'https://preprod.pol.is/oauth2/oauth2_github_callback',
  scope: 'notifications',
  state: '3(#0/!~'
});
// END GITHUB OAUTH2


var POLIS_FROM_ADDRESS = "Polis Team <mike@pol.is>";


var akismet = require('akismet').client({
    blog: 'https://pol.is',  // required: your root level url
    apiKey: process.env.AKISMET_ANTISPAM_API_KEY
});

akismet.verifyKey(function(err, verified) {
  if (verified) {
    console.log('Akismet: API key successfully verified.');
  } else {
    console.log('Akismet: Unable to verify API key.');
  }
});


// heroku pg standard plan has 120 connections
// plus a dev poller connection and a direct db connection
// 3 devs * (2 + 1 + 1) = 12 for devs
// plus the prod and preprod pollers = 14
// round up to 20
// plus the preprod front-end server = 30
// 100 remaining
// so we can have up to 9 prod front-end servers
if (devMode) {
    pg.defaults.poolSize = 2;
} else {
    pg.defaults.poolSize = 10; 
}



function isSpam(o) {
    return new Promise(function(resolve, reject) {
        akismet.checkSpam(o, function(err, spam) {
            if (err) {
                reject(err);
            } else {
                resolve(spam);
            }
        });
    });
}


app.disable('x-powered-by');


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

var metric = (function() {
    var apikey = process.env.HOSTEDGRAPHITE_APIKEY;
    return function(metricName, numberValue, optionalTimestampOverride) {
        return new Promise(function(resolve, reject) {

            var point = { 
                dur: numberValue,
                time : new Date(),
            };
            console.dir(point);
            metricName = metricName.replace(/[^A-Za-z0-9\.]/g,"");
            console.log(metricName);
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
            console.log(message.toString());
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

metric("api.process.launch", 1);

var errorNotifications = (function() {
    var errors = [];
    function sendAll() {
        if (errors.length === 0) {
            return;
        }
        pushoverInstance.send({
            title: "err",
            message: _.uniq(errors).join("\n"),
        }, function(err, result) {
            console.log("pushover " + err?"failed":"ok");
            console.dir(err);
            console.dir(result);
        });
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



var redisForAuth;
if (process.env.REDISTOGO_URL) {
    var rtg   = url.parse(process.env.REDISTOGO_URL);
    redisForAuth = require("redis").createClient(rtg.port, rtg.hostname);
    redisForAuth.auth(rtg.auth.split(":")[1]);
} else {
    redisForAuth = require('redis').createClient();
}

// var redisForMathResults;
// if (process.env.REDISCLOUD_URL) {
//     var rc   = url.parse(process.env.REDISCLOUD_URL);
//     var redisForMathResults= require("redis").createClient(rc.port, rc.hostname);
//     redisForMathResults.auth(rc.auth.split(":")[1]);
// } else {
//     redisForMathResults = require('redis').createClient();
// }

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
    "created",
    "txt",
    "velocity",
    "active",
    "mod",
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

console.log(process.env.MONGOLAB_URI);

function makeSessionToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 20);
}


// var userTokenCache = new SimpleCache({
//     maxSize: 9000,
// });

function getUserInfoForSessionToken(sessionToken, res, cb) {
    // var uid = userTokenCache.get();
    // if (uid) {
    //     cb(null, uid);
    //     return;
    // }
    redisForAuth.get(sessionToken, function(errGetToken, uid) {
        if (errGetToken) { console.error("token_fetch_error"); cb(500); return; }
        if (!uid) { console.error("token_expired_or_missing"); cb(403); return; }
        // userTokenCache.set(sessionToken, uid);
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

function startSession(userID, cb) {
    // NOTE: If you want to set this to true, be sure to make the cookies expire slightly before the token in redis.
    var SHOULD_EXPIRE_SESSION_TOKENS = false;

    var sessionToken = makeSessionToken();
    //console.log('startSession: token will be: ' + sessionToken);
    console.log('startSession');
    redisForAuth.set(sessionToken, userID, function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return; }
        console.log('startSession: token set.');
        if (SHOULD_EXPIRE_SESSION_TOKENS) {
            redisForAuth.expire(sessionToken, 3*31*24*60*60, function(errSetTokenExpire, repliesExpire) {
                if (errSetTokenExpire) { cb(errSetTokenExpire); return; }
                console.log('startSession: token will expire.');
                cb(null, sessionToken);
            });
        } else {
            cb(null, sessionToken);
        }
    });
}

function endSession(sessionToken, cb) {
    redisForAuth.del(sessionToken, function(errDelToken, repliesSetToken) {
        if (errDelToken) { cb(errDelToken); return; }
        cb(null);
    });
}


function setupPwReset(uid, cb) {
    function makePwResetToken() {
        // These can probably be shortened at some point.
        return crypto.randomBytes(140).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 100);
    }
    var token = makePwResetToken();
    redisForAuth.set(token, uid, function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return; }
        var seconds = 2*60*60;
        redisForAuth.expire(token, seconds, function(errSetTokenExpire, repliesExpire) {
            if (errSetTokenExpire) { cb(errSetTokenExpire); return; }
            cb(null, token);
        });
    });
}
function getUidForPwResetToken(pwresettoken, cb) {
    redisForAuth.get(pwresettoken, function(errGetToken, replies) {
        if (errGetToken) { console.error("pwresettoken_fetch_error"); cb(500); return; }
        if (!replies) { console.error("token_expired_or_missing"); cb(403); return; }
        cb(null, {uid: replies});
    });
}
function clearPwResetToken(pwresettoken, cb) {
    redisForAuth.del(pwresettoken, function(errDelToken, repliesSetToken) {
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
      console.log(name);
      return name;
    }

    db.collection(mongoCollectionName('main'), function(err, collectionOfPcaResults) {
    db.collection(mongoCollectionName('bidToPid'), function(err, collectionOfBidToPidResults) {
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
function pgQuery() {
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

    pg.connect(process.env.DATABASE_URL, function(err, client, done) {
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


function pgQueryP(queryString, params) {
    return new Promise(function(resolve, reject) {
        pgQuery(queryString, params, function(err, result) {
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



function hasAuthToken(req) {
    return !!req.cookies[COOKIES.TOKEN];
}


// input token from body or query, and populate req.body.u with userid.
function authOptional(assigner) {
    return auth(assigner, true);
}

function doCookieAuth(assigner, isOptional, req, res, next) {

    var token = req.cookies[COOKIES.TOKEN];
    
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

function getUidForApiKey(apikey) {
    return pgQueryP("select uid from apikeysndvweifu WHERE apikey = ($1);", [apikey]);
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
        } else if (isOptional) {
            next();
        } else {
            res.status(401);
            next("polis_err_auth_token_not_supplied");
        }
    };
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
//     console.log(req.method + " " + req.url);
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
        if ("boolean" === typeof s) {
            return resolve(s);
        }
        s = s.toLowerCase();
        if (s === 't' || s === 'true' || s === 'on') {
            return resolve(true);
        } else if (s === 'f' || s === 'false' || s === 'off') {
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
            return reject("polis_fail_parse_int");
        }
        resolve(x);
    });
}


// NOTE: currently conversation_id is stored as zinvite
function getZidFromConversationId(conversation_id) {
    return new Promise(function(resolve, reject) {
        pgQuery("select zid from zinvites where zinvite = ($1);", [conversation_id], function(err, results) {
            if (err) {
                return reject(err);
            } else if (!results || !results.rows || !results.rows.length) {
                console.error("polis_err_fetching_zid_for_conversation_id" + conversation_id);
                return reject("polis_err_fetching_zid_for_conversation_id");
            } else {
                return resolve(results.rows[0].zid);
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


var prrrams = (function() {
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
                console.dir(req);
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
//                             console.log("ok " + c.txt);
//                             callback(null);
//                         })
//                         .catch(function() {
//                             console.log("failedd " + c.txt);
//                             callback(1);
//                         });
//                 };
//             }),
//             function(err, results) {
//                 console.log(err);
//             });


//         console.dir(missing);
//         console.log(missing.length);
//         console.log(comments.length);
//     });
// });



var oneYear = 1000*60*60*24*365;

function setCookie(res, setOnPolisDomain, name, value, options) {
    var o = _.clone(options||{});
    o.path = _.isUndefined(o.path) ? '/' : o.path;
    o.maxAge = _.isUndefined(o.maxAge) ? oneYear : o.maxAge;
    if (setOnPolisDomain) {
        o.secure = _.isUndefined(o.secure) ? true : o.secure;
        o.domain = _.isUndefined(o.domain) ? '.pol.is' : o.domain;
    }
    res.cookie(name, value, o);
}

function setPlanCookie(res, setOnPolisDomain, planNumber) {
    if (planNumber > 0) {
        setCookie(res, setOnPolisDomain, COOKIES.PLAN_NUMBER, planNumber, {
            // not httpOnly - needed by JS
        });
    }
    // else falsy

}
function setHasEmailCookie(res, setOnPolisDomain, email) {
    if (email) {
        setCookie(res, setOnPolisDomain, COOKIES.HAS_EMAIL, 1, {
            // not httpOnly - needed by JS
        });
    }
    // else falsy
}

function setUserCreatedTimestampCookie(res, setOnPolisDomain, timestamp) {
    setCookie(res, setOnPolisDomain, COOKIES.USER_CREATED_TIMESTAMP, timestamp, {
        // not httpOnly - needed by JS
    });
}

function setTokenCookie(res, setOnPolisDomain, token) {
    setCookie(res, setOnPolisDomain, COOKIES.TOKEN, token, {
        httpOnly: true,
    });
}

function setUidCookie(res, setOnPolisDomain, uid) {
    setCookie(res, setOnPolisDomain, COOKIES.UID, uid, {
        // not httpOnly - needed by JS
    });
}

function setPermanentCookie(res, setOnPolisDomain, token) {
    setCookie(res, setOnPolisDomain, COOKIES.PERMANENT_COOKIE, token, {
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

        setTokenCookie(res, setOnPolisDomain, token);
        setUidCookie(res, setOnPolisDomain, uid);
        setPlanCookie(res, setOnPolisDomain, plan);
        setHasEmailCookie(res, setOnPolisDomain, email);
        setUserCreatedTimestampCookie(res, setOnPolisDomain, o.created);
        if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
            setPermanentCookie(res, setOnPolisDomain, makeSessionToken());
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



var pidCache = new SimpleCache({
    maxSize: 9000,
});

// must follow auth and need('zid'...) middleware
function getPidForParticipant(assigner, cache) {
    return function(req, res, next) {
        var zid = req.p.zid;
        var uid = req.p.uid;
        var cacheKey;
        function finish(pid) {
            assigner(req, "pid", pid);
            next();
        }
        if (cache) {
            cacheKey = zid + "_" + uid;
            var pid = cache.get(cacheKey);
            if (pid !== void 0) {
                finish(pid);
                return;
            }
        }
        pgQuery("SELECT pid FROM participants WHERE zid = ($1) and uid = ($2);", [zid, uid], function(err, results) {
            if (err) { yell("polis_err_get_pid_for_participant"); next(err); return; }
            var pid = -1;
            if (results && results.rows && results.rows.length) {
                pid = results.rows[0].pid;
                if (cache) {
                    cache.set(cacheKey, pid);
                }
                finish(pid);
            } else {
                var msg = "polis_err_get_pid_for_participant_missing";
                yell(msg);
                console.log(zid);
                console.log(uid);
                console.dir(req.p);
                next(msg);
            }
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
    return pgQueryP("select is_active from conversations where zid = ($1);", [zid]).then(function(rows) {
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

function votesGet(res, p) {
    return new Promise(function(resolve, reject) {
        var q = sql_votes.select(sql_votes.star())
            .where(sql_votes.zid.equals(p.zid));

        if (!_.isUndefined(p.pid)) {
            q = q.where(sql_votes.pid.equals(p.pid));
        }
        if (!_.isUndefined(p.tid)) {
            q = q.where(sql_votes.tid.equals(p.tid));
        }
        pgQuery(q.toString(), function(err, results) {
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
  if(/polis.io/.test(req.headers.host) ||
     /polisapp.herokuapp.com/.test(req.headers.host) || // needed for heroku integrations (like slack?)
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

// metered promise
function MPromise(name, f) {
    var p = new Promise(f);
    var start = Date.now();
    setTimeout(function() {
        metric(name + ".go", 1, start);
    }, 100);
    p.then(function() {
        var end = Date.now();
        var duration = end - start;
        setTimeout(function() {
            metric(name + ".ok", duration, end);
        }, 100);
    }, function() {
        var end = Date.now();
        var duration = end - start;
        setTimeout(function() {
            metric(name + ".fail", duration, end);
        }, 100);
    });
    return p;
}


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

app.use(meter("api.all"));
app.use(express.logger());
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
if (devMode) {
    app.use(express.compress());
} else {
    // Cloudflare would apply gzip if we didn't
    // but it's about 2x faster if we do the gzip (for the inbox query on mike's account)
    app.use(express.compress());
}
app.use(function(req, res, next) {
    if (req.body) {
        console.log(req.path);
        var temp = _.clone(req.body);
        if (temp.email) {
            temp.email = "foo@foo.com";
        }
        if (temp.password) {
            temp.password = "some_password";
        }
        if (temp.newPassword) {
            temp.newPassword = "some_password";
        }
        if (temp.hname) {
            temp.hname = "somebody";
        }
        console.dir(req.body);
    }
    next();
});
app.use(function(err, req, res, next) {
    if(!err) {
        return next();
    }
    console.log("error found in middleware");
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
  "http://embed.pol.is",
  "https://embed.pol.is",
  "http://localhost:8000",
  "https://canvas.instructure.com", // LTI
  "", // for API
];

var whitelistedBuckets = {
    "pol.is": "pol.is",
    "embed.pol.is": "pol.is",
    "preprod.pol.is": "preprod.pol.is",
    "about.polis.io": "about.polis.io",
};

app.all("/api/v3/*", function(req, res, next) {
 
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
      console.log('not whitelisted');
      console.dir(req);
      console.dir(req.headers);
      console.dir(req.path);
      return next(new Error("unauthorized domain: " + host));
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
});
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
        setPermanentCookie(res, setOnPolisDomain, makeSessionToken());
    }

    setCookie(res, setOnPolisDomain, "top", "ok", {
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
//         setPermanentCookie(res, setOnPolisDomain, makeSessionToken());
//     }
//     setCookie(res, setOnPolisDomain, "top", "ok", {
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
        setCookie(res, setOnPolisDomain, COOKIES.TRY_COOKIE, "ok", {
            httpOnly: false,            // not httpOnly - needed by JS
        });
    }
    res.status(200).json({});
});


var pcaCache = new SimpleCache({
    maxSize: 9000,
});

var lastPrefetchedVoteTimestamp = -1;

// this scheme might not last forever. For now, there are only a couple of MB worth of conversation pca data.
function fetchAndCacheLatestPcaData() {
    var lastPrefetchPollStartTime = Date.now();
    function waitTime() {
        var timePassed = Date.now() - lastPrefetchPollStartTime;
        return Math.max(0, 2500 - timePassed);
    }

    console.log("mathpoll begin", lastPrefetchedVoteTimestamp);
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
            console.log("mathpoll done");
            setTimeout(fetchAndCacheLatestPcaData, waitTime());
            return;
        }

        console.log("mathpoll updating", item.lastVoteTimestamp, item.zid);
        // var prev = pcaCache.get(item.zid);
        pcaCache.set(item.zid, item);
        if (item.lastVoteTimestamp > lastPrefetchedVoteTimestamp) {
            lastPrefetchedVoteTimestamp = item.lastVoteTimestamp;
        }
        cursor.nextObject(processItem);
    }
    cursor.nextObject(processItem);
}

// don't start immediately, let other things load first.
setTimeout(fetchAndCacheLatestPcaData, 3000);

function getPca(zid, lastVoteTimestamp) {
    var cached = pcaCache.get(zid);
    if (cached) {
        if (cached.lastVoteTimestamp <= lastVoteTimestamp) {
            console.log("mathpoll related", "math was cached but not new", zid, lastVoteTimestamp);
            return Promise.resolve(null);
        } else {
            console.log("mathpoll related", "math from cache", zid, lastVoteTimestamp);
            return Promise.resolve(cached);
        }
    }

    console.log("mathpoll cache miss", zid, lastVoteTimestamp);

    // NOTE: not caching results from this query for now, think about this later.
    // not caching these means that conversations without new votes might not be cached. (closed conversations may be slower to load)
    // It's probably not difficult to cache, but keeping things simple for now, and only caching things that come down with the poll.
    return new MPromise("db.math.pca.get", function(resolve, reject) {
        collectionOfPcaResults.find({$and :[
            {zid: zid},
            {lastVoteTimestamp: {$gt: lastVoteTimestamp}},
            ]}, function(err, cursor) {
            if (err) {
                reject(new Error("polis_err_get_pca_results_find"));
                return;
            }
            cursor.toArray( function(err, docs) {
                if (err) {
                    reject(new Error("polis_err_get_pca_results_find_toarray"));
                } else if (!docs.length) {
                    console.log("mathpoll related", "after cache miss, unable to find item", zid, lastVoteTimestamp);
                    resolve(null);
                } else {
                    var item = docs[0];
                    console.log("mathpoll related", "after cache miss, found item, adding to cache", zid, lastVoteTimestamp);
                    // save in LRU cache, but don't update the lastPrefetchedVoteTimestamp
                    pcaCache.set(zid, item);
                    // return the item
                    resolve(item);
                }
            });
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
                reject(new Error("polis_err_get_pca_playback_result_find"));
                return;
            }
            cursor.toArray( function(err, docs) {
                if (err) {
                    reject(new Error("polis_err_get_pca_playback_result_find_toarray"));
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
                reject(new Error("polis_err_get_pca_playback_results_list_find"));
                return;
            }
            // TODO save some memory by using the cursor as a cursor
            cursor.toArray( function(err, docs) {
                if (err) {
                    reject(new Error("polis_err_get_pca_playback_results_list_find_toarray"));
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
    console.log("redirecting old zid user to about page");
    res.writeHead(302, {
        Location: "https://pol.is/about"
    });
    return res.end();
  }
  return next();
}



// Cache the knowledge of whether there are any pca results for a given zid.
// Needed to determine whether to return a 404 or a 304.
// zid -> boolean
var pcaResultsExistForZid = {};

app.get("/api/v3/math/pca",
    meter("api.math.pca.get"),
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
            finishOne(res, data);
        } else {
            // check whether we should return a 304 or a 404
            if (_.isUndefined(pcaResultsExistForZid[zid])) {
                // This server doesn't know yet if there are any PCA results in the DB
                // So try querying from 0
                getPca(zid, 0).then(function(data) {
                    var exists = !!data;
                    pcaResultsExistForZid[zid] = exists;
                    finishWith304or404();
                }).catch(function(err) {
                    fail(res, 500, err);
                });
            } else {
                finishWith304or404();
            }
        }
    }).catch(function(err) {
        fail(res, 500, err);
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
    return new MPromise("db.bidToPid.get", function(resolve, reject) {
        collectionOfBidToPidResults.find({$and :[
            {zid: zid},
            {lastVoteTimestamp: {$gt: lastVoteTimestamp}},
            ]}, function(err, cursor) {
            if (err) { reject(new Error("polis_err_get_pca_results_find")); return; }
            cursor.toArray( function(err, docs) {
                if (err) { reject(new Error("polis_err_get_pca_results_find_toarray")); return; }
                if (docs.length) {
                    resolve(docs[0]);
                } else {
                    // Could actually be a 404, would require more work to determine that.
                    reject(new Error("polis_err_get_pca_results_missing"));
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
    return new Promise(function(resolve, reject) {

        pgQuery("select pid, xid from xids inner join "+
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
    auth(assignToP),
    moveToBody,
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

// TODO cache
app.get("/api/v3/bid",
    auth(assignToP),
    moveToBody,
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
        var b2p = items[0].bidToPid;
        var pid = items[1];
        var mathResults = items[2];


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
    var server = devMode ? "http://localhost:5000" : "https://pol.is";

    if (req.headers.host.indexOf("preprod.pol.is") >= 0) {
        server = "https://preprod.pol.is";
    }
    if (req.headers.host.indexOf("embed.pol.is") >= 0) {
        server = "https://embed.pol.is";
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
    return pgQueryP("SELECT uid FROM users where LOWER(email) = ($1);", [email]).then(function(rows) {
        if (!rows || !rows.length) {
            throw new Error("polis_err_no_user_matching_email");
        }
        return rows[0].uid;
    });
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
    console.log("after clear res set-cookie: " + JSON.stringify(res._headers["set-cookie"]));
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


app.get("/api/v3/zinvites/:zid",
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    // if uid is not conversation owner, fail
    pgQuery('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) {
            fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner", err);
            return;
        }
        if (!results || !results.rows) {
            res.writeHead(404);
            res.json({status: 404});
            return;
        }
        pgQuery('SELECT * FROM zinvites WHERE zid = ($1);', [req.p.zid], function(err, results) {
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
            console.log(longStringOfTokens);
            var otzinviteArray = longStringOfTokens.match(/.{1,31}/g);
            otzinviteArray = otzinviteArray.slice(0, numTokens); // Base64 encoding expands to extra characters, so trim to the number of tokens we want.
            otzinviteArray = otzinviteArray.map(function(suzinvite) {
                return generateConversationURLPrefix() + suzinvite;
            });
            console.dir(otzinviteArray);
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
        gen = require('crypto').pseudoRandomBytes;
    } else {
        gen = require('crypto').randomBytes;
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
        ;
        // replace first character with a number between 2 and 9 (avoiding 0 and 1 since they look like l and O)
        prettyToken = _.random(2,9) + prettyToken.slice(1);
        prettyToken = prettyToken.toLowerCase();
        prettyToken = prettyToken.slice(0, len); // in case it's too long

        callback(0, prettyToken);
    });  
}

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
    return new Promise(function(resolve, reject) {
        pgQuery("SELECT * FROM users WHERE uid = ($1);", [uid], function(err, results) {
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
    pgQuery('SELECT * FROM conversations WHERE zid = ($1);', [zid], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
            return;
        }
        callback(null, results.rows[0][propertyName]);
    });
}

function checkZinviteCodeValidity(zid, zinvite, callback) {
    pgQuery('SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);', [zid, zinvite], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
        } else {
            callback(null);// ok
        }
    });
}

function getZidForZinvite(zinvite) {
    return new Promise(function(resolve, reject) {
        pgQuery("select zid from zinvites where zinvite = ($1);", [zinvite], function(err, result) {
            if (err) {
                reject(err);
            } else if (!result || !result.rows || !result.rows[0] || !result.rows[0].zid) {
                reject("polis_err_no_zid_for_zinvite");
            } else {
                resolve(result.rows[0].zid);
            }
        });
    });
}


// TODO consider LRU cache
function getZinvite(zid) {
    return new Promise(function(resolve, reject) {
        pgQuery("select * from zinvites where zid = ($1);", [zid], function(err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result && result.rows && result.rows[0] && result.rows[0].zinvite || void 0);
            }
        });
    });
}

// TODO consider LRU cache
function getZinvites(zids) {
    if (!zids.length) {
        return Promise.resolve(zids);
    }
    zids = _.map(zids, function(zid) {
        return Number(zid); // just in case
    });
    zids = _.uniq(zids);
    return new Promise(function(resolve, reject) {
        pgQuery("select * from zinvites where zid in ("+zids.join(",")+");", [], function(err, result) {
            if (err) {
                reject(err);
            } else {
                var zid2conversation_id = {};
                var len = result.rows.length;
                for (var i = 0; i < len; i++) {
                    var o = result.rows[i];
                    zid2conversation_id[o.zid] = o.zinvite;
                }
                resolve(zid2conversation_id);
            }
        });
    });
}

function addConversationId(o) {
    if (!o.zid) {
        // if no zid, resolve without fetching zinvite.
        return Promise.resolve(o);
    }
    return getZinvite(o.zid).then(function(conversation_id) {
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

function finishOne(res, o) {
    addConversationId(o).then(function(item) {
        // ensure we don't expose zid
        if (item.zid) {
            delete item.zid;
        }
        res.status(200).json(item);
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
    }).catch(function(err) {
        fail(res, 500, "polis_err_finishing_response", err);
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
    return new Promise(function(resolve, reject) {
        pgQuery("SELECT owner FROM conversations where zid = ($1);", [zid], function(err, results) {
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
        if (err) { console.log("adsfasdfasd"); return callback(err);}

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
                        if (err) { console.log("sdkfuhsdu"); return cb(err);}
                        cb(0);
                    }
                );
            },
            function(err) {
                if (err) { console.log("ifudshf78ds"); return callback(err);}
                // finished with all the inserts
                callback(0);
            }
        );
    });
}


function tryToJoinConversation(zid, uid, pmaid_answers) {
    // there was no participant row, so create one
    return new Promise(function(resolve, reject) {
        pgQuery("INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid;", [zid, uid], function(err, docs) {
            if (err) {
                console.log("failed to insert into participants");
                console.dir(err);
                return reject(err);
            }
            var pid = docs && docs.rows && docs.rows[0] && docs.rows[0].pid;

            saveParticipantMetadataChoices(zid, pid, pmaid_answers, function(err) {
                if (err) {
                    console.log("failed to saveParticipantMetadataChoices");
                    console.dir(err);
                    return reject(err);
                }
                resolve(pid);
            });
        });
    });
}

function joinConversation(zid, uid, pmaid_answers) {
    function tryJoin() {
        return tryToJoinConversation(zid, uid, pmaid_answers);
    }


  return getPidPromise(zid, uid).then(function(pid) {
    // already a ptpt, so don't create another
    yell("polis_warn_participant_exists");
  }, function(err) {
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
  });
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
    pgQuery("SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);", [zid, uid], function(err, docs) {
        var pid;
        if (!docs || !docs.rows || docs.rows.length === 0) {
            err = err || 1;
        }
        callback(err);
    });
}

function isOwner(zid, uid) {
    return getConversationInfo(zid).then(function(info) {
        console.log(39847534987 + " isOwner " + uid);
        console.dir(info);
        console.log(info.owner === uid);
        return info.owner === uid;
    });
}

function isModerator(zid, uid) {
    return isOwner(zid, uid);
}

// returns a pid of -1 if it's missing
function getPid(zid, uid, callback) {
    pgQuery("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, docs) {
        var pid = -1;
        if (docs && docs.rows && docs.rows[0]) {
            pid = docs.rows[0].pid;
        }
        callback(err, pid);
    });
}
// returns a pid of -1 if it's missing
function getPidPromise(zid, uid) {
    return new Promise(function(resolve, reject) {
        pgQuery("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, results) {
            if (err) {return reject(err);}
            if (!results || !results.rows || !results.rows.length) {
                return reject(new Error("polis_err_getPidPromise_failed"));
            }
            resolve(results.rows[0].pid);
        });
    });        
}

function getAnswersForConversation(zid, callback) {
    pgQuery("SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;", [zid], function(err, x) {
        if (err) { callback(err); return;}
        callback(0, x.rows);
    });
}
function getChoicesForConversation(zid) {
    return new Promise(function(resolve, reject) {
        pgQuery("select * from participant_metadata_choices where zid = ($1) and alive = TRUE;", [zid], function(err, x) {
            if (err) { reject(err); return; }
            if (!x || !x.rows) { resolve([]); return; }
            resolve(x.rows);
        });
    });
}


function getUserInfoForUid(uid, callback) {
    pgQuery("SELECT email, hname from users where uid = $1", [uid], function(err, results) {
        if (err) { return callback(err); }
        if (!results.rows || !results.rows.length) {
            return callback(null);
        }
        callback(null, results.rows[0]);
    });
}
function getUserInfoForUid2(uid, callback) {
    return new Promise(function(resolve, reject) {
        pgQuery("SELECT * from users where uid = $1", [uid], function(err, results) {
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
    console.log("sending email with mailgun: " + [sender, recipient, subject, text].join(" "));
    var servername = "";
    var options = {};
    return new Promise(function(resolve, reject) {
        mailgun.sendText(sender, [recipient], subject, text, servername, options, function(err) {
            if (err) {
                console.error("Unable to send email via mailgun to " + recipient + " " + err);                
                yell("polis_err_mailgun_email_send_failed");                
                reject(err);
            } else {
                console.log("sent email with mailgun to " + recipient);
                resolve();
            }
        });
    });
}

function sendTextEmailWithPostmark(sender, recipient, subject, text) {
    console.log("sending email with postmark: " + [sender, recipient, subject, text].join(" "));
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
                console.log("sent email with postmark to " + recipient);
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


// tags: ANON_RELATED
app.get("/api/v3/participants",
    moveToBody,
    authOptional(assignToP),
    want('pid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
    var pid = req.p.pid;
    var uid = req.p.uid;
    var zid = req.p.zid;

    function fetchOne() {
        pgQuery("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
            if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
            var ptpt = result.rows[0];
            var data = {};
            // choose which fields to expose
            data.hname = ptpt.hname;

            res.status(200).json(data);
        });
    }
    function fetchAll() {
        // NOTE: it's important to return these in order by pid, since the array index indicates the pid.
        pgQuery("SELECT users.hname, users.email, participants.pid FROM users INNER JOIN participants ON users.uid = participants.uid WHERE zid = ($1) ORDER BY participants.pid;", [zid], function(err, result) {
            if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
            res.json(result.rows);
        });
    }
    pgQuery("SELECT is_anon FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
        if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
        if (result.rows[0].is_anon) {
            fail(res, 403, "polis_err_fetching_participant_info_conversation_is_anon");
            return;
        }
        if (pid !== undefined) {
            fetchOne();
        } else {
            fetchAll();
        }

    });
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
    return new Promise(function(resolve, reject) {
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
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var answers = req.p.answers;

    function finish(pid) {
        // Probably don't need pid cookies..?
        // function getZidToPidCookieKey(zid) {
        //     return zid + "p";
        // }
        // addCookie(res, getZidToPidCookieKey(zid), pid);
        res.status(200).json({
            pid: pid,
        });
    }

    function doJoin() {




        userHasAnsweredZeQuestions(zid, answers).then(function() {
            joinConversation(zid, uid, answers).then(function(pid) {
                finish(pid);
            }, function(err) {
                fail(res, 500, "polis_err_add_participant", err);
            });
        }, function(err) {
            userFail(res, 400, err.message, err);
        });
    }

    // Check if already in the conversation
    getPid(zid, req.p.uid, function(err, pid) {
        console.dir(arguments);
        if (!err && pid >= 0) {
            finish(pid);
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
    });
});


function addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid) {
    return pgQueryP("select * from lti_users where lti_user_id = ($1) and tool_consumer_instance_guid = ($2);", [lti_user_id, tool_consumer_instance_guid]).then(function(rows) {
        if (!rows || !rows.length) {
            return pgQueryP("insert into lti_users (uid, lti_user_id, tool_consumer_instance_guid) values ($1, $2, $3);", [uid, lti_user_id, tool_consumer_instance_guid]);
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

app.post("/api/v3/auth/login",
    need('password', getPassword, assignToP),
    want('email', getEmail, assignToP),
    want('lti_user_id', getStringLimitLength(1, 9999), assignToP),
    want('lti_context_id', getStringLimitLength(1, 9999), assignToP),
    want('tool_consumer_instance_guid', getStringLimitLength(1, 9999), assignToP),
    want('afterJoinRedirectUrl', getStringLimitLength(1, 9999), assignToP),
function(req, res) {
    var password = req.p.password;
    var email = req.p.email || "";
    var lti_user_id = req.p.lti_user_id;
    var lti_context_id = req.p.lti_context_id;
    var tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    var afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    email = email.toLowerCase();
    if (!_.isString(password) || !password.length) { fail(res, 403, "polis_err_login_need_password", new Error("polis_err_login_need_password")); return; }
    pgQuery("SELECT * FROM users WHERE LOWER(email) = ($1);", [email], function(err, docs) {
        docs = docs.rows;
        if (err) { fail(res, 403, "polis_err_login_unknown_user_or_password", err); console.error("polis_err_login_unknown_user_or_password_err"); return; }
        if (!docs || docs.length === 0) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_noresults"); return; }

        var uid = docs[0].uid;

        pgQuery("select pwhash from jianiuevyew where uid = ($1);", [uid], function(err, results) {
            results = results.rows;
            if (err) { fail(res, 403, "polis_err_login_unknown_user_or_password", err); console.error("polis_err_login_unknown_user_or_password_err"); return; }
            if (!results || results.length === 0) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_noresults"); return; }

            var hashedPassword  = results[0].pwhash;

            bcrypt.compare(password, hashedPassword, function(errCompare, result) {
                console.log("errCompare, result", errCompare, result);
                if (errCompare || !result) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_badpassword"); return; }
                
                startSession(uid, function(errSess, token) {
                    var response_data = {
                        uid: uid,
                        email: email,
                        token: token
                    };
                    addCookies(req, res, token, uid).then(function() {
                        console.log("uid", uid);                        
                        console.log("lti_user_id", lti_user_id);
                        console.log("lti_context_id", lti_context_id);
                        var ltiUserPromise = lti_user_id ?
                            addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid) :
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

function createDummyUser() {
    return new Promise(function(resolve, reject) {
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
    })
    .then(function(o) {
        var uid = o.uid;
        console.log("startSessionAndAddCookies " + uid + " existing " + o.existingAuth);
        // TODO check for possible security implications
        if (!o.existingAuth) {
            return startSessionAndAddCookies(req, res, uid).then(function() {
                return o;
            });
        }
        return Promise.resolve(o);
    })
    .then(function(o) {
        console.log("permanentCookieToken", o.permanentCookieToken);
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
        if (err.message = "polis_err_need_full_user") {
            userFail(res, 403, err.message, err);
        } else {
            fail(res, 500, err.message, err);
        }
    });
});


// Test for deadlock condition
// _.times(2, function() {
// setInterval(function() {
//         console.log("foobar test call begin");
//         joinWithZidOrSuzinvite({
//             answers: [],
//             existingAuth: false,
//             zid: 11580,
//             // uid: req.p.uid,
//         }).then(function() {
//             console.log('foobar test ok');
//         }).catch(function(err) {
//             console.log('foobar test failed');
//             console.dir(err);
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
        console.log("joinWithZidOrSuzinvite convinfo begin");
        return getConversationInfo(o.zid).then(function(conv) {
            console.log("joinWithZidOrSuzinvite convinfo done");
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
        console.log("joinWithZidOrSuzinvite userinfo begin");
        if (!o.uid) {
            console.log("joinWithZidOrSuzinvite userinfo nope");
            return o;
        }
        return getUserInfoForUid2(o.uid).then(function(user) {
            console.log("joinWithZidOrSuzinvite userinfo done");
            o.user = user;
            return o;
        });
    })
    .then(function(o) {
        console.log("joinWithZidOrSuzinvite check email");
      if (o.conv.owner_sees_participation_stats) {
        // User stats can be provided either by having the users sign in with polis
        // or by having them join via suurls.
        if (!(o.user && o.user.email) && !o.suzinvite) { // may want to inspect the contenst of the suzinvite info object instead of just the suzinvite
          throw new Error("polis_err_need_full_user");
        }
      }
      return o;
    })
    .then(function(o) {
        console.log("joinWithZidOrSuzinvite check email done");
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
      return joinConversation(o.zid, o.uid, o.answers).then(function(pid) {
        return _.extend({pid: pid}, o);
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

app.post("/api/v3/auth/new",
    want('anon', getBool, assignToP),
    want('password', getPasswordWithCreatePasswordRules, assignToP),
    want('password2', getPasswordWithCreatePasswordRules, assignToP),    
    want('email', getOptionalStringLimitLength(999), assignToP),
    want('hname', getOptionalStringLimitLength(999), assignToP),
    want('oinvite', getOptionalStringLimitLength(999), assignToP),
    want('zinvite', getOptionalStringLimitLength(999), assignToP),
    want('organization', getOptionalStringLimitLength(999), assignToP),
    want('gatekeeperTosPrivacy', getBool, assignToP),
    want('lti_user_id', getStringLimitLength(1, 9999), assignToP),
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
    var lti_context_id = req.p.lti_context_id;
    var tool_consumer_instance_guid = req.p.tool_consumer_instance_guid;
    var afterJoinRedirectUrl = req.p.afterJoinRedirectUrl;

    if (password2 && (password !== password2)) { fail(res, 400, "Passwords do not match."); return; }
    if (!gatekeeperTosPrivacy) { fail(res, 400, "polis_err_reg_need_tos"); return; }
    if (!email) { fail(res, 400, "polis_err_reg_need_email"); return; }
    if (!hname) { fail(res, 400, "polis_err_reg_need_name"); return; }
    if (!password) { fail(res, 400, "polis_err_reg_password"); return; }
    if (password.length < 6) { fail(res, 400, "polis_err_reg_password_too_short"); return; }
    if (!_.contains(email, "@") || email.length < 3) { fail(res, 400, "polis_err_reg_bad_email"); return; }

    pgQuery("SELECT * FROM users WHERE email = ($1)", [email], function(err, docs) {
        if (err) { fail(res, 500, "polis_err_reg_checking_existing_users", err); return; }
            if (docs.length > 0) { fail(res, 403, "polis_err_reg_user_exists", new Error("polis_err_reg_user_exists")); return; }

            generateHashedPassword(password, function(err, hashedPassword) {
                if (err) { fail(res, 500, "polis_err_generating_hash", err); return; }
                    var query = "insert into users " +
                        "(email, hname, zinvite, oinvite, is_owner) VALUES "+
                        "($1, $2, $3, $4, $5) "+
                        "returning uid;";
                    var vals = 
                        [email, hname, zinvite||null, oinvite||null, true];

                    pgQuery(query, vals, function(err, result) {
                        if (err) { console.dir(err); fail(res, 500, "polis_err_reg_failed_to_add_user_record", err); return; }
                        var uid = result && result.rows && result.rows[0] && result.rows[0].uid;

                        pgQuery("insert into jianiuevyew (uid, pwhash) values ($1, $2);", [uid, hashedPassword], function(err, results) {
                            if (err) { console.dir(err); fail(res, 500, "polis_err_reg_failed_to_add_user_record", err); return; }


                            startSession(uid, function(err,token) {
                              if (err) { fail(res, 500, "polis_err_reg_failed_to_start_session", err); return; }
                              addCookies(req, res, token, uid).then(function() {

                                var ltiUserPromise = lti_user_id ?
                                  addLtiUserifNeeded(uid, lti_user_id, tool_consumer_instance_guid) :
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
                                        console.log(err);
                                        console.error("polis_err_intercom_create_user_fail");
                                        console.dir(params);
                                        yell("polis_err_intercom_create_user_fail");
                                        return;
                                    }
                                });
                              }, function(err) {
                                  fail(res, 500, "polis_err_adding_cookies", err);
                              }).catch(function(err) {
                                  fail(res, 500, "polis_err_adding_user", err);
                              });
                            }); // end startSession
                        }); // end insert pwhash
                    }); // end insert user
            }); // end generateHashedPassword
    }); // end find existing users
}); // end /api/v3/auth/new


app.get("/api/v3/users",
    moveToBody,
    authOptional(assignToP),
function(req, res) {
    var uid = req.p.uid;
    if (!uid) {
        // this api may be called by a new user, so we don't want to trigger a failure here.
        res.json({});
        return;
    }
    getUserInfoForUid2(uid).then(function(info) {
        res.json({
            uid: uid,
            email: info.email,
            hname: info.hname,
            created: Number(info.created),
            daysInTrial: 10 + (usersToAdditionalTrialDays[uid] || 0),
            plan: planCodeToPlanName[info.plan],
        });
    }, function(err) {
        fail(res, 500, "polis_err_getting_user_info", err);
    });
});

// These map from non-ui string codes to number codes used in the DB
// The string representation ("sites", etc) is also used in intercom.
var planCodes = {
    mike: 9999,
    trial: 0,
    individuals: 1,
    students: 2,
    pp: 3,
    sites: 100,
    orgs: 1000,
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
    console.log('updatePlan', uid, planCode);
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
            setPlanCookie(res, setOnPolisDomain, planCode);

            // Redirect to the same URL with the path behind the fragment "#"
            res.writeHead(302, {
                Location: protocol + "://" + req.headers.host +"/settings",
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
  console.log("XXX - Got the params!");
  console.log("XXX - Got the params!" + res);
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
        orgs: 5000 * 100,
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


function getComments(o) {
    var isModerationRequest = o.moderation;

    return new Promise(function(resolve, reject) {
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
        if (!_.isUndefined(o.not_pid)) {
            q = q.and(sql_comments.pid.notEquals(o.not_pid));
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
        if (isModerationRequest) {

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

        //if (_.isNumber(req.p.not_pid)) {
            //query += " AND pid != ($"+ (i++) + ")";
            //parameters.unshift(req.p.not_pid);
        //}
        //
        //pgQuery("SELECT * FROM comments WHERE zid = ($1) AND created > (SELECT to_timestamp($2));", [zid, lastServerToken], handleResult);

        pgQuery(q.toString(), [], function(err, docs) {
            if (err) { 
                reject(err);
                return;
            }

            if (docs.rows && docs.rows.length) {
                var cols = [
                    "txt",
                    "tid",
                    "created",
                ];
                var rows = docs.rows;

                if (isModerationRequest) {
                    cols.push("velocity");
                    cols.push("zid");
                    cols.push("mod");
                    cols.push("active");
                }
                rows = rows.map(function(row) { return _.pick(row, cols); });
                resolve(rows);

            } else {
                resolve([]);

            }
        }); // end pgQuery
      }).catch(function(err) {

        reject(err);
      }); // end getConversationInfo
    }); // end new Promise
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
            pgQueryP("select pid, count(*) from votes where zid = ($1) group by pid;", [zid]),
            pgQueryP("select pid, count(*) from comments where zid = ($1) group by pid;", [zid]),
            pgQueryP("select pid, xid from xids inner join (select * from participants where zid = ($1)) as p on xids.uid = p.uid;", [zid]),
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
    want('pid', getInt, assignToP),
    want('not_pid', getInt, assignToP),
    want('not_voted_by_pid', getInt, assignToP),
    want('moderation', getBool, assignToP),
    want('mod', getInt, assignToP),
//    need('lastServerToken', _.identity, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var tids = req.p.tids;
    var pid = req.p.pid;
    var not_pid = req.p.not_pid;
    var not_voted_by_pid = req.p.not_voted_by_pid;
    var mod = req.p.mod;

    var rid = req.headers["x-request-id"] + " " + req.headers['user-agent'];
    console.log("getComments " + rid + " begin");

    getComments(req.p).then(function(comments) {
        finishArray(res, comments);
    }).catch(function(err) {
        console.log("getComments " + rid + " failed");
        fail(res, 500, "polis_err_get_comments", new Error("polis_err_get_comments"), err);
    });
}); // end GET /api/v3/comments


function isDuplicateKey(err) {
    return err.code === 23505;
}

function failWithRetryRequest(res) {
    res.setHeader('Retry-After', 0);
    console.warn(57493875);
    res.writeHead(500).send(57493875);
}

function getNumberOfCommentsWithModerationStatus(zid, mod) {
    return new Promise(function(resolve, reject) {
        pgQuery("select count(*) from comments where zid = ($1) and mod = ($2);", [zid, mod], function(err, result) {
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

        body += createModerationUrl(req, zinvite);

        body += "\n\nThank you for using Polis.";

             // NOTE: adding a changing element (date) at the end to prevent gmail from thinking the URL is a signature, and hiding it. (since the URL doesn't change between emails, Gmail tries to be smart, and hides it)        
             // "Sent: " + Date.now() + "\n";

        // NOTE: Adding zid to the subject to force the email client to create a new email thread.
        return sendEmailByUid(uid, "Waiting for review (conversation " + zid + ")", body);
    }).catch(function(err) {
        console.error(err);
    });
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
        pgQuery("UPDATE COMMENTS SET active=($3), mod=($4) WHERE zid=($1) and tid=($2);", [zid, tid, active, mod], function(err) {
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
    return new Promise(function(resolve, reject) {
        pgQuery("select * from comments where zid = ($1) and tid = ($2);", [zid, tid], function(err, results) {
            if (err) {
                reject(err);
            } else if (!results || !results.rows || !results.rows.length) {
                reject(new Error("polis_err_missing_comment"));
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
//     console.log("mute", 1);
//     verifyHmacForQueryParams("v3/mute", params).catch(function() {
//     console.log("mute", 2);

//         fail(res, 403, "polis_err_signature_mismatch");
//     }).then(function() {
//     console.log("mute", 3);
//         return muteComment(zid, tid);
//     }).then(function() {
//     console.log("mute", 4);
//         return getComment(zid, tid);
//     }).then(function(c) {
//     console.log("mute", 5);
//         res.set('Content-Type', 'text/html');
//         res.send(
//             "<h1>muted tid: "+c.tid+" zid:" + c.zid + "</h1>" +
//             "<p>" + c.txt + "</p>" +
//             "<a href=\"" + createUnmuteUrl(zid, tid) + "\">Unmute this comment.</a>"
//         );
//     }).catch(function(err) {
//     console.log("mute", 6);
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
    return new Promise(function(resolve, reject) {
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
    need('txt', getOptionalStringLimitLength(997), assignToP),
    want('vote', getIntInRange(-1, 1), assignToP),
    want('prepop', getBool, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var txt = req.p.txt;
    var vote = req.p.vote;
    var prepopulating = req.p.prepop;

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
        console.dir(err);
    });
    // var isSpamPromise = Promise.resolve(false);
    var isModeratorPromise = isModerator(zid, uid);

    var conversationInfoPromise = getConversationInfo(zid);

    var pidPromise = getPidPromise(zid, uid);
    var commentExistsPromise = commentExists(zid, txt);

    Promise.all([pidPromise, conversationInfoPromise, isModeratorPromise, commentExistsPromise]).then(function(results) {
        var pid = results[0];
        var conv = results[1];
        var is_moderator = results[2];
        var commentExists = results[3];

        if (commentExists) {
            fail(res, 409, "polis_err_post_comment_duplicate", err);
            return;
        }

        if (!conv.is_active) {
            fail(res, 403, "polis_err_conversation_is_closed", err);
        }
 
        var bad = hasBadWords(txt);
        isSpamPromise.then(function(spammy) {
            console.log("spam test says: " + txt + " " + (spammy?"spammy":"not_spammy"));
            return spammy;
        }, function(err) {
            console.error("spam check failed");
            console.dir(err);
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

            pgQuery(
                "INSERT INTO COMMENTS "+
                  "(pid, zid, txt, velocity, active, mod, created, tid) VALUES "+
                  "($1,   $2,  $3,       $4,     $5,  $6, default, null) RETURNING tid, created;",
                   [pid, zid, txt, velocity, active, mod],

                function(err, docs) {
                    if (err) { 
                        console.dir(err);
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
                            // send to mike for moderation
                            sendCommentModerationEmail(req, 125, zid, n);

                            // send to conversation owner for moderation
                            sendCommentModerationEmail(req, conv.owner, zid, n);
                        });
                    }

                    var autoVotePromise = _.isUndefined(vote) ?
                        Promise.resolve() :
                        votesPost(pid, zid, tid, vote);

                    autoVotePromise.then(function() {

                        setTimeout(function() {
                            updateConversationModifiedTime(zid, createdTime);
                        }, 100);
                        
                        res.json({
                            tid: tid,
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
        pgQuery("SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);", [req.p.zid, req.p.pid], function(err, docs) {
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

    pgQuery(query.toString(), function(err, results) {
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

// TODO Since we know what is selected, we also know what is not selected. So server can compute the ratio of support for a comment inside and outside the selection, and if the ratio is higher inside, rank those higher.
app.get("/api/v3/selection",
    moveToBody,
    want('users', getArrayOfInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
function(req, res) {
        var zid = req.p.zid;
        var users = req.p.users || [];
        
        getVotesForZidPids(zid, users, function(err, voteRecords) {
            if (err) { fail(res, 500, "polis_err_get_selection", err); return; }
            if (!voteRecords.length) { fail(res, 500, "polis_err_get_selection_no_votes", new Error("polis_err_get_selection_no_votes")); return; }

            var commentIdCounts = getCommentIdCounts(voteRecords);
            commentIdCounts = commentIdCounts.slice(0, 10);
            var commentIdsOrdering = commentIdCounts.map(function(x) { return {tid: x[0]};});
            var commentIds = commentIdCounts.map(function(x) { return x[0];});

            var queryForSelectedComments = sql_comments.select(sql_comments.star())
                .where(sql_comments.zid.equals(zid))
                .and(sql_comments.tid.in(commentIds));
            pgQuery(queryForSelectedComments.toString(), function(err, results) {
                if (err) { fail(res, 500, "polis_err_get_selection_comments", err); return; }
                var comments = results.rows;
                // map the results onto the commentIds list, which has the right ordering
                comments = orderLike(comments, commentIdsOrdering, "tid"); // TODO fix and test the extra declaration of comments
                for (var i = 0; i < comments.length; i++) {
                    comments[i].freq = i;
                }

                comments.sort(function(a, b) {
                    // desc sort primarily on frequency(ascending), then on recency
                    if (b.freq > a.freq) {
                        return -1;
                    } else if (b.freq < a.freq) {
                        return 1;
                    } else {
                        return b.created > a.created;
                    }
                });
                finishArray(res, comments);
            }); // end comments query
        }); // end votes query
    }); // end GET selection

app.get("/api/v3/votes",
    moveToBody,
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    want('pid', getInt, assignToP),
    want('tid', getInt, assignToP),
function(req, res) {
    votesGet(res, req.p).then(function(votes) {
        finishArray(res, votes);
    }, function(err) {
        fail(res, 500, "polis_err_votes_get", err);
    });
});


function getNextComment(zid, pid, withoutTids) {
    var params = {
        zid: zid,
        not_voted_by_pid: pid,
        limit: 1,
        random: true,
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

app.get("/api/v3/nextComment",
    moveToBody,
    authOptional(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('not_voted_by_pid', getInt, assignToP),
    want('without', getArrayOfInt, assignToP),
function(req, res) {

    // NOTE: I tried to speed up this query by adding db indexes, and by removing queries like getConversationInfo and finishOne.
    //          They didn't help much, at least under current load, which is negligible. pg:diagnose isn't complaining about indexes.
    //      I think the direction to go as far as optimizing this is to asyncronously build up a synced in-ram list of next comments
    //        for each participant, for currently active conversations. (this would probably be a math-poller-esque process on another
    //         hostclass)
    //         Along with this would be to cache in ram info about moderation status of each comment so we can filter before returning a comment.
    
    getNextComment(req.p.zid, req.p.not_voted_by_pid, req.p.without).then(function(c) {
        if (c) {
            finishOne(res, c);
        } else {
            res.status(200).json({});
        }
    }).catch(function(err) {
        fail(res, 500, "polis_err_get_next_comment", err);
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
    getPidForParticipant(assignToP, pidCache),
function(req, res) {

    // We allow viewing (and possibly writing) without cookies enabled, but voting requires cookies (except the auto-vote on your own comment, which seems ok)
    var token = req.cookies[COOKIES.TOKEN];
    var apiToken = req.headers.authorization;
    if (!token && !apiToken) {
        fail(res, 403, "polis_err_vote_noauth");
        return;
    }

    votesPost(req.p.pid, req.p.zid, req.p.tid, req.p.vote).then(function(createdTime) {
        setTimeout(function() {
            updateConversationModifiedTime(req.p.zid, createdTime);
        }, 100);
        return getNextComment(req.p.zid, req.p.pid);
    }).then(function(nextComment) {
        var result = {};
        if (nextComment) {
            result.nextComment = nextComment;
        }
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

app.post("/api/v3/stars",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('starred', getIntInRange(0,1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
    var query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default) RETURNING created;";
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.starred];
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
    pgQuery("select pmqid from participant_metadata_questions where zid = ($1);", [zid], function(err, results) {
        if (err) {reject(err); return; }
        if (!results.rows || !results.rows.length) {
            resolve();
            return;
        }
        var pmqids = results.rows.map(function(row) { return Number(row.pmqid); });
        pgQuery(
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
                    console.log("grades foo failed");
                    console.error(e);     
                    reject(e);
                } else {
                    console.log('grades foo ok!');
                    resolve(params, data);
                }
                // console.log(require('util').inspect(data));
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
            console.log("grades assigned" + gradeFromZeroToOne + " lti_user_id " + assignmentCallbackInfo.lti_user_id);
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
        console.log("grading set to " + gradingContext.gradeFromZeroToOne);
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

app.put('/api/v3/conversations',
    moveToBody,
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('conversation_id', getStringLimitLength(1, 1000), assignToP), // we actually need conversation_id to build a url
    want('is_active', getBool, assignToP),
    want('is_anon', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('owner_sees_participation_stats', getBool, assignToP, false),
    want('profanity_filter', getBool, assignToP),
    want('short_url', getBool, assignToP, false),
    want('spam_filter', getBool, assignToP),
    want('strict_moderation', getBool, assignToP),
    want('topic', getOptionalStringLimitLength(1000), assignToP),
    want('description', getOptionalStringLimitLength(50000), assignToP),
    want('verifyMeta', getBool, assignToP),
    want('send_created_email', getBool, assignToP), // ideally the email would be sent on the post, but we post before they click create to allow owner to prepopulate comments.
    want('launch_presentation_return_url_hex', getStringLimitLength(1, 9999), assignToP), // LTI editor tool redirect url (once conversation editing is done)
    want('context', getOptionalStringLimitLength(999), assignToP),
    want('tool_consumer_instance_guid', getOptionalStringLimitLength(999), assignToP),    
    want('custom_canvas_assignment_id', getInt, assignToP),        
function(req, res){
  var generateShortUrl = req.p.short_url;
  isOwner(req.p.zid, req.p.uid).then(function(ok) {
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
    if (!_.isUndefined(req.p.owner_sees_participation_stats)) {
        fields.owner_sees_participation_stats = !!req.p.owner_sees_participation_stats;
    }
    if (!_.isUndefined(req.p.launch_presentation_return_url_hex)) {
        fields.lti_users_only = true;
    }


    var q = sql_conversations.update(
            fields
        )
        .where(
            sql_conversations.zid.equals(req.p.zid)
        ).and(
            sql_conversations.owner.equals(req.p.uid)
        ).returning('*');
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
                promise.then(function() {

                     // send notification email
                    if (req.p.send_created_email) {
                        Promise.all([getUserInfoForUid2(req.p.uid), getConversationUrl(req, req.p.zid)]).then(function(results) {
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
                            console.dir(err);
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
                                finishOne(res, conv);
                            }).catch(function(err) {
                                fail(res, 500, "polis_err_saving_assignment_grading_context", err);
                                emailBadProblemTime("PUT conversation worked, but couldn't save assignment context");
                            });
                    } else {
                        finishOne(res, conv);
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
        if (err) {console.dir(err);  callback(err); return;}
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
            function(callback) { pgQuery("SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);", [zid], callback); },
            //function(callback) { pgQuery("SELECT * FROM participant_metadata_answers WHERE alive = true AND zid = ($1);", [zid], callback); },
            //function(callback) { pgQuery("SELECT * FROM participant_metadata_choices WHERE alive = true AND zid = ($1);", [zid], callback); },
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
        pgQuery(query.toString(), function(err, result) {
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
            function(callback) { pgQuery("SELECT * FROM participant_metadata_questions WHERE zid = ($1);", [zid], callback); },
            function(callback) { pgQuery("SELECT * FROM participant_metadata_answers WHERE zid = ($1);", [zid], callback); },
            function(callback) { pgQuery("SELECT * FROM participant_metadata_choices WHERE zid = ($1);", [zid], callback); },
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
        pgQuery('SELECT * from participant_metadata_questions where zid = ($1)', [zid], function(err, metadataResults) {
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

function getOneConversation(req, res) {
  var uid = req.p.uid;
  var zid = req.p.zid;
    // var fail = failNotWithin(500);
    // no need for auth, since conversation_id was provided
    Promise.all([
        getConversationInfo(zid),
        getConversationHasMetadata(zid),
    ]).then(function(results) {
        var conv = results[0];
        var convHasMetadata = results[1];
        getUserProperty(conv.owner, "hname").then(function(ownername) {
            if (convHasMetadata) {
                conv.hasMetadata = true;
            }
            if (!_.isUndefined(ownername)) {
                conv.ownername = ownername;
            }

            conv.is_owner = conv.owner === uid;
            conv.pp = false; // participant pays (WIP)
            
            finishOne(res, conv);
            
        }, function(err) {
            fail(res, 500, "polis_err_getting_conversation_info", err);
        }).catch(function(err) {
            fail(res, 500, "polis_err_getting_conversation", err);
        });
    }, function(err) {
        fail(res, 500, "polis_err_getting_conversation", err);
    }).catch(function(err) {
        fail(res, 500, "polis_err_getting_conversation", err);
    });
}

function getConversations(req, res) {
  var uid = req.p.uid;
  var zid = req.p.zid;
  var xid = req.p.xid;
  var course_invite = req.p.course_invite;
  var include_all_conversations_i_am_in = req.p.include_all_conversations_i_am_in;
  var want_mod_url = req.p.want_mod_url;
  var want_inbox_item_admin_url = req.p.want_inbox_item_admin_url;
  var want_inbox_item_participant_url = req.p.want_inbox_item_participant_url;
  var want_inbox_item_admin_html = req.p.want_inbox_item_admin_html;
  var want_inbox_item_participant_html = req.p.want_inbox_item_participant_html;
  var context = req.p.context;
  var limit = req.p.limit;
  console.log("thecontext", context);

  // var fail = failNotWithin(500);
      // First fetch a list of conversations that the user is a participant in.

  pgQuery('select zid from participants where uid = ($1);', [uid], function(err, results) {
    if (err) { fail(res, 500, "polis_err_get_conversations_participated_in", err); return; }

    var participantIn = results && results.rows && _.pluck(results.rows, "zid") || null;

    var query = sql_conversations.select(sql_conversations.star());

    var orClauses;
    if (!_.isUndefined(req.p.context)) {
        // knowing a context grants access to those conversations (for now at least)
        orClauses = sql_conversations.context.equals(req.p.context);
    } else {
        orClauses = sql_conversations.owner.equals(uid);
    }

    // TODO_PERF Check include_all_conversations_i_am_in before making the above DB query.
    if (include_all_conversations_i_am_in && participantIn.length) {
        orClauses = orClauses.or(sql_conversations.zid.in(participantIn));
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

    //query = whereOptional(query, req.p, 'owner');
    query = query.order(sql_conversations.created.descending);

    if (!_.isUndefined(req.p.limit)) {
        query = query.limit(req.p.limit);
    } else {
        query = query.limit(999); // TODO paginate
    }

    pgQuery(query.toString(), function(err, result) {
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
            return suurlsPromise.then(function(suurlData) {
                if (suurlData) {
                    suurlData = _.indexBy(suurlData, "zid");
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
                    conv.created = Number(conv.created);
                    conv.modified = Number(conv.modified);

                    // if there is no topic, provide a UTC timstamp instead
                    if (_.isUndefined(conv.topic) || conv.topic === "") {
                        conv.topic = (new Date(conv.created)).toUTCString();
                    }

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

function encodeParams(o) {
    var stringifiedJson = JSON.stringify(o);
    var encoded = strToHex(stringifiedJson);
    enoded = "ep1_" + encodedParams;
    return encoded;
}

app.get('/api/v3/conversations',
    moveToBody,
    authOptional(assignToP),
    want('include_all_conversations_i_am_in', getBool, assignToP),
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('course_invite', getStringLimitLength(1, 32), assignToP),
    want('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
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
    courseIdPromise = pgQueryP("select course_id from courses where course_invite = ($1);", [req.p.course_invite]).then(function(rows) {
        return rows[0].course_id;
    });
  }
  courseIdPromise.then(function(course_id) {
    if (course_id) {
        req.p.course_id = course_id;
    }
    if (req.p.zid) {
      getOneConversation(req, res);
    } else if (req.p.uid) {
      getConversations(req, res);
    } else {
      fail(res, 403, "polis_err_need_auth", new Error("polis_err_need_auth"));
    }
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

    console.log("context", req.p.context);
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
        is_public: req.p.short_url, // TODO remove this column
        is_anon: req.p.is_anon,
        profanity_filter: req.p.profanity_filter,
        spam_filter: req.p.spam_filter,
        strict_moderation: req.p.strict_moderation,
        context: req.p.context,
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
        pgQuery(
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
    console.log(req.p);
    pgQuery("SELECT * FROM users WHERE uid = $1", [req.p.uid], function(err, results){
        if (err) { fail(res, 500, "polis_err_get_email_db", err); return; }
        var email = results.rows[0].email;
        var fullname = results.rows[0].hname;
        pgQuery("select * from zinvites where zid = $1", [req.p.zid], function(err, results){
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
    
    console.log("select * from einvites where einvite = ($1);", [einvite]);
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

function getConversationUrl(req, zid) {
    return getZinvite(zid).then(function(zinvite) {
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
    console.dir(req);
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
                    console.log('lti_linkage didnt exist');
                    // Have them sign in again, since they weren't linked.
                    // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
                    renderLtiLinkagePage(req, res);
                }
            }).catch(function(err) {
                fail(res, 500, "polis_err_launching_lti_finding_user", err);
            });
        } else { // no uid (no cookies)
            // Have them sign in to set up the linkage
            console.log('lti_linkage - no uid');            
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
//     console.dir(req);
//     var roles = req.p.roles;
//     var isInstructor = /[iI]nstructor/.exec(roles); // others: Learner
//     var user_id = req.p.user_id;    
//     var context_id = req.p.context_id;    
//     var user_image = req.p.user_image || "";
//     // if (!req.p.tool_consumer_instance_guid) {
//     //     emailBadProblemTime("couldn't find tool_consumer_instance_guid, maybe this isn't Canvas?");
//     // }

//     console.dir(req.p);

//     // // TODO SECURITY we need to verify the signature
//     // var oauth_consumer_key = req.p.oauth_consumer_key;

//     // Check if linked to this uid.
//     pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {


//         var userForLtiUserId = null;
//         if (rows.length) {
//             userForLtiUserId = rows[0];
//         }

//         console.log('got user for lti_user_id:' + JSON.stringify(userForLtiUserId));

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
//             console.log('lti_linkage didnt exist');
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
    console.log('grades select * from canvas_assignment_conversation_info where tool_consumer_instance_guid = '+tool_consumer_instance_guid+' and lti_context_id = '+lti_context_id+' and custom_canvas_assignment_id = '+custom_canvas_assignment_id+';');
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
            return pgQueryP("update canvas_assignment_callback_info set lis_outcome_service_url = ($5) and lis_result_sourcedid = ($6) and stringified_json_of_post_content = ($7) and where lti_user_id = ($1) and lti_context_id = ($2) and custom_canvas_assignment_id = ($3) and tool_consumer_instance_guid = ($4);", [
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

    console.log("grades req.body " + JSON.stringify(req.body));
    console.log("grades req.p " + JSON.stringify(req.p));

    // TODO SECURITY we need to verify the signature
    var oauth_consumer_key = req.p.oauth_consumer_key;


    function getPolisUserForLtiUser() {
        return pgQueryP("select * from lti_users left join users on lti_users.uid = users.uid where lti_users.lti_user_id = ($1) and lti_users.tool_consumer_instance_guid = ($2);", [user_id, req.p.tool_consumer_instance_guid]).then(function(rows) {
            var userForLtiUserId = null;
            if (rows.length) {
                userForLtiUserId = rows[0];
                console.log('got user for lti_user_id:' + JSON.stringify(userForLtiUserId));
            }
            return userForLtiUserId;
        });
    }

























    if (req.p.lis_result_sourcedid) {
        addCanvasAssignmentConversationCallbackParamsIfNeeded(req.p.user_id, req.p.context_id, req.p.custom_canvas_assignment_id, req.p.tool_consumer_instance_guid, req.p.lis_outcome_service_url, req.p.lis_result_sourcedid, JSON.stringify(req.body)).then(function() {
            console.log("grading info added");
        }).catch(function(err) {
            console.log("grading info error ");
            console.dir(err);
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


    getCanvasAssignmentInfo(
      req.p.tool_consumer_instance_guid,
      req.p.context_id,
      req.p.custom_canvas_assignment_id).then(function(rows) {
        var exists = rows && rows.length;
        var info = rows[0];
        if (exists) {
            return constructConversationUrl(info.zid).then(function(url) {
                return getPolisUserForLtiUser().then(function(user) {
                    if (user) {
                        // we're in business, user can join the conversation
                        res.redirect(url);
                    } else {
                        // not linked yet.
                        // send them to an auth page, which should do the linkage, then send them to inbox with the funky params...

                        // you are signed in, but not linked to the signed in user
                        // WARNING! CLEARING COOKIES - since it's difficult to have them click a link to sign out, and then re-initiate the LTI POST request from Canvas, just sign them out now and move on.
                        clearCookies(req, res);
                        console.log('lti_linkage didnt exist');
                        // Have them sign in again, since they weren't linked.
                        // NOTE: this could be streamlined by showing a sign-in page that also says "you are signed in as foo, link account foo? OR sign in as someone else"
                        renderLtiLinkagePage(req, res, url);
                    }
                });

            }).catch(function(err) {
                fail(res, 500, "polis_err_lti_generating_conversation_url", err);
            });

        } else {
            // uh oh, not ready. If this is an instructor, we'll send them to the create/conversation page.
            if (isInstructor) {
                var encodedParams = encodeParams({
                    tool_consumer_instance_guid: req.p.tool_consumer_instance_guid, 
                    context: context_id,
                    custom_canvas_assignment_id: req.p.custom_canvas_assignment_id
                });
                res.redirect(getServerNameWithProtocol(req) + "/conversation/create/" + encodedParams);
                return;
            } else {
                // double uh-oh, a student is seeing this before the instructor created a conversation...

                // TODO email polis team, email instructor?
                // TODO or just auto-generate a conversation for the instructor, and have no topic and description, then show that?
                // TODO or make a dummy "not ready yet" page
                res.redirect(getServerNameWithProtocol(req) + "/about");                
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
https://preprod.pol.is/api/v3/LTI/conversation_assignment.xml
*/
app.get("/api/v3/LTI/conversation_assignment.xml",
function(req, res) {
var xml = '' +
'<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0" xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0" xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0" xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imslticc_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticc_v1p0.xsd http://www.imsglobal.org/xsd/imsbasiclti_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imsbasiclti_v1p0.xsd http://www.imsglobal.org/xsd/imslticm_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticm_v1p0.xsd http://www.imsglobal.org/xsd/imslticp_v1p0 http://www.imsglobal.org/xsd/lti/ltiv1p0/imslticp_v1p0.xsd">' +

'<blti:title>Polis Setup 1</blti:title>' +
'<blti:description>based on Minecraft LMS integration</blti:description>' +
'<blti:icon>' +
'http://minecraft.inseng.net:8133/minecraft-16x16.png' +
'</blti:icon>' +
'<blti:launch_url>https://preprod.pol.is/api/v3/LTI/conversation_assignment</blti:launch_url>' +

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
        '<lticm:property name="url">https://preprod.pol.is/api/v3/LTI/conversation_assignment</lticm:property>' +  // ?
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


app.post("/api/v3/users/invite",
    // authWithApiKey(assignToP),
    auth(assignToP),
    need('conversation_id', getConversationIdFetchZid, assignToPCustom('zid')),
    need('single_use_tokens', getBool, assignToP),
    need('xids', getArrayOfStringNonEmpty, assignToP),
function(req, res) {
    var owner = req.p.uid;
    var xids = req.p.xids;
    var zid = req.p.zid;


    // generate some tokens
    // add them to a table paired with user_ids
    // return URLs with those.
    generateSUZinvites(xids.length).then(function(suzinviteArray) {
        var pairs = _.zip(xids, suzinviteArray);

        var valuesStatements = pairs.map(function(pair) {
            var xid = escapeLiteral(pair[0]);
            var suzinvite = escapeLiteral(pair[1]);
            var statement = "("+ suzinvite + ", " + xid + "," + zid+","+owner+")";
            console.log(statement);
            return statement;
        });
        var query = "INSERT INTO suzinvites (suzinvite, xid, zid, owner) VALUES " + valuesStatements.join(",") + ";";
        console.log(query);
        pgQuery(query, [], function(err, results) {
            if (err) { fail(res, 500, "polis_err_saving_invites", err); return; }
            getZinvite(zid).then(function(conversation_id) {
                res.json({
                    urls: suzinviteArray.map(function(suzinvite) {
                        return generateSingleUseUrl(req, conversation_id, suzinvite);
                    }),
                    xids: xids,
                });
            }, function(err) {
                fail(res, 500, "polis_err_generating_single_use_invites_missing_conversation_id", err);
            }).catch(function(err) {
                fail(res, 500, "polis_err_generating_single_use_invites", err);
            });
        });
    }).catch(function(err) {
        fail(res, 500, "polis_err_generating_single_use_invites", err);
    });
});





// BEGIN GITHUB OAUTH2 ROUTES

// Initial page redirecting to Github
app.get('/auth', function (req, res) {
    res.redirect(authorization_uri);
});

// Callback service parsing the authorization token and asking for the access token
app.get('/oauth2/oauth2_github_callback', function (req, res) {

  function saveToken(error, result) {
    if (error) {
        console.log('Access Token Error', error.message);
        fail(res, 500, "polis_err_oauth_callback_github", error);
    }
    var token = oauth2.AccessToken.create(result);
    console.log("thetoken", token);
    console.dir(token);
    console.log("thetoken", token);
    // res.status(200).end();
    res.redirect("/inboxApiTest"); // got the token, go somewhere when auth is done.
  }

  var code = req.query.code;
  console.log('/oauth2/oauth2_github_callback');
  oauth2.AuthCode.getToken({
    code: code,
    redirect_uri: 'https://preprod.pol.is/oauth2/oauth2_github_callback'
  }, saveToken);


});

app.get('/oauthTest', function (req, res) {
  res.send('Hello World');
});

// END GITHUB OAUTH2 ROUTES



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

// TODO cache!
function makeFileFetcher(hostname, port, path, contentType) {
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
        console.log("fetch file from " + url);
        var x = request(url);
        req.pipe(x);
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
var port = process.env.STATIC_FILES_PORT;
var fetchUnsupportedBrowserPage = makeFileFetcher(hostname, port, "/unsupportedBrowser.html", "text/html");

function fetchIndex(req, res) {
    var doFetch = makeFileFetcher(hostname, port, "/index.html", "text/html");
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


app.get(/^\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // conversation view
app.get(/^\/explore\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // power view
app.get(/^\/share\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // share view
app.get(/^\/summary\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // summary view
app.get(/^\/m\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // moderation view
app.get(/^\/ot\/[0-9][0-9A-Za-z]+(\/.*)?/, fetchIndex); // conversation view, one-time url
// TODO consider putting static files on /static, and then using a catch-all to serve the index.
app.get(/^\/conversation\/create(\/.*)?/, fetchIndex);
app.get(/^\/user\/create(\/.*)?$/, fetchIndex);
app.get(/^\/user\/login(\/.*)?$/, fetchIndex);
app.get(/^\/welcome\/.*$/, fetchIndex);
app.get(/^\/settings(\/.*)?$/, fetchIndex);
app.get(/^\/user\/logout(\/.*)?$/, fetchIndex);


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

app.get(/^\/inbox(\/.*)?$/, fetchIndex);
app.get(/^\/inboxApiTest/, fetchIndex);
app.get(/^\/pwresetinit$/, fetchIndex);
app.get(/^\/demo\/[0-9][0-9A-Za-z]+/, fetchIndex);
app.get(/^\/pwreset.*/, fetchIndex);
app.get(/^\/prototype.*/, fetchIndex);
app.get(/^\/plan.*/, fetchIndex);
app.get(/^\/professors$/, makeFileFetcher(hostname, port, "/professors.html", "text/html"));
app.get(/^\/pricing$/, makeFileFetcher(hostname, port, "/pricing.html", "text/html"));
app.get(/^\/company$/, makeFileFetcher(hostname, port, "/company.html", "text/html"));
app.get(/^\/api$/, function (req, res) { res.redirect("/docs/api/v3");});
app.get(/^\/docs\/api$/, function (req, res) { res.redirect("/docs/api/v3");});
app.get(/^\/docs\/api\/v3$/, makeFileFetcher(hostname, port, "/api_v3.html", "text/html"));
app.get(/^\/embed$/, makeFileFetcher(hostname, port, "/embed.html", "text/html"));
app.get(/^\/politics$/, makeFileFetcher(hostname, port, "/politics.html", "text/html"));
app.get(/^\/marketers$/, makeFileFetcher(hostname, port, "/marketers.html", "text/html"));
app.get(/^\/faq$/, makeFileFetcher(hostname, port, "/faq.html", "text/html"));
app.get(/^\/blog$/, makeFileFetcher(hostname, port, "/blog.html", "text/html"));
app.get(/^\/tos$/, makeFileFetcher(hostname, port, "/tos.html", "text/html"));
app.get(/^\/privacy$/, makeFileFetcher(hostname, port, "/privacy.html", "text/html"));
app.get(/^\/canvas_setup_backup_instructions$/, makeFileFetcher(hostname, port, "/canvas_setup_backup_instructions.html", "text/html"));
app.get(/^\/styleguide$/, makeFileFetcher(hostname, port, "/styleguide.html", "text/html"));
// Duplicate url for content at root. Needed so we have something for "About" to link to.
app.get(/^\/about$/, makeFileFetcher(hostname, port, "/lander.html", "text/html"));
app.get(/^\/try$/, makeFileFetcher(hostname, port, "/try.html", "text/html"));


var conditionalIndexFetcher = (function() {
    var fetchLander = makeFileFetcher(hostname, port, "/lander.html", "text/html");
    return function(req, res) {
        if (hasAuthToken(req)) {
            // user is signed in, serve the app
            return fetchIndex(req, res);
        } else if (!browserSupportsPushState(req)) {
            // TEMPORARY: Don't show the landing page.
            // The problem is that /user/create redirects to #/user/create,
            // which ends up here, and since there's no auth token yet,
            // we would show the lander. One fix would be to serve up the auth page
            // as a separate html file, and not rely on JS for the routing.
            return fetchIndex(req, res);
        } else {
            // user not signed in, serve landing page
            return fetchLander(req, res);
        }
    };
}());

app.get("/", conditionalIndexFetcher);

// proxy everything else
app.get(/^\/[^(api\/)]?.*/, proxy);




app.listen(process.env.PORT);

console.log('started on port ' + process.env.PORT);
} // End of initializePolisAPI

async.parallel([connectToMongo], initializePolisAPI);

}());
