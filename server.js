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

var http = require('http'),
    httpProxy = require('http-proxy'),
    Promise = require('es6-promise').Promise,
    express = require('express'),
    app = express(),
    sql = require("sql"),
    squel = require("squel"),
    pg = require('pg').native, //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    bcrypt = require('bcrypt'),
    crypto = require('crypto'),
    Intercom = require('intercom.io'), // https://github.com/tarunc/intercom.io
    Pushover = require( 'pushover-notifications' ),
    pushoverInstance = new Pushover( {
        user: process.env['PUSHOVER_GROUP_POLIS_DEV'],
        token: process.env['PUSHOVER_POLIS_PROXY_API_KEY'],
    }),
    // sendgrid = require('sendgrid')(
    //   process.env['SENDGRID_USERNAME'],
    //   process.env['SENDGRID_PASSWORD'],
    //   {api: 'smtp'}
    // ),
    Mailgun = require('mailgun').Mailgun,
    mailgun = new Mailgun(process.env['MAILGUN_API_KEY']),
    devMode = "localhost" === process.env["STATIC_FILES_HOST"],
    SimpleCache = require("simple-lru-cache"),
    _ = require('underscore');

app.disable('x-powered-by'); // save a whale

// airbrake.handleExceptions();

// sendgrid.send({
//   to: 'm@bjorkegren.com',
//   from: 'noreply@polis.io',
//   subject: 'Hello World',
//   text: 'Sending email with NodeJS through SendGrid!'
// }, function(err, json) {
//     if (err) { 
//         console.log("sendgrid");
//         console.error(err);

//         return;
//     }
//     console.log(json);
// });

// mailgun.sendText('noreply@polis.io', ['Mike <m@bjorkegren.com>', 'michael@bjorkegren.com'],
//   'This is the subject',
//   'This is the text',
//   'noreply@polis.io', {},
//   function(err) {
//     if (err) {
//         console.log('mailgun Oh noes: ' + err);
//         console.dir(arguments);
//     } else {
//         console.log('mailgun success');
//     }
// });

var cookieNames = [
    "token",
    "uid",
    "pids",
    "email",
    // also a cookie for each zid the user has a pid for... 314p=100; 451p=20;
];

var domainOverride = process.env.DOMAIN_OVERRIDE || null;

function connectError(errorcode, message){
  var err = new Error(message);
  err.status = errorcode;
  return err;
}

var AUTH_FAILED = 'auth failed';
var ALLOW_ANON = true;


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
    }
}());
var yell = errorNotifications.add;



var redisForAuth;
if (process.env.REDISTOGO_URL) {
    var rtg   = url.parse(process.env.REDISTOGO_URL);
    var redisForAuth = require("redis").createClient(rtg.port, rtg.hostname);
    redisForAuth.auth(rtg.auth.split(":")[1]);
} else {
    redisForAuth = require('redis').createClient();
}

var redisForMathResults;
if (process.env.REDISCLOUD_URL) {
    var rc   = url.parse(process.env.REDISCLOUD_URL);
    var redisForMathResults= require("redis").createClient(rc.port, rc.hostname);
    redisForMathResults.auth(rc.auth.split(":")[1]);
} else {
    redisForMathResults = require('redis').createClient();
}

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
    "is_public",
    "email_domain",
    "owner",
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

var sql_otzinvites = sql.define({
  name: 'otzinvites',
  columns: [
    "otzinvite",
    "zid",
    "xid",
    ]
});


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


// Eventually, the plan is to support a larger number-space by using some lowercase letters.
// Waiting to implement that since there's cognitive overhead with mapping the IDs to/from
// letters/numbers.
// Just using digits [2-9] to start with. Omitting 0 and 1 since they can be confused with
// letters once we start using letters.
// This should give us roughly 8^8 = 16777216 conversations before we have to add letters.
var ReadableIds = (function() {
    function rand(a) {
        return _.random(a.length);
    }
    // no 1 (looks like l)
    // no 0 (looks like 0)
    var numbers8 = "23456789".split(""); 

    // should fit within 32 bits
    function generateConversationId() {
       return [
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8)
        ].join('');
    }
    return {
        generateConversationId: generateConversationId,
    };
}());


// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI

console.log(process.env.MONGO_URL);

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

function startSession(userID, cb) {
    var sessionToken = makeSessionToken();
    //console.log('startSession: token will be: ' + sessionToken);
    console.log('startSession');
    redisForAuth.set(sessionToken, userID, function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return; }
        console.log('startSession: token set.');
        redisForAuth.expire(sessionToken, 3*31*24*60*60, function(errSetTokenExpire, repliesExpire) {
            if (errSetTokenExpire) { cb(errSetTokenExpire); return; }
            console.log('startSession: token will expire.');
            cb(null, sessionToken);
        });
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

/*
console.log('b4 starting session');
var testSession = function(userID) {
    console.log('starting session');
    startSession(userID, function(err, token) {
        if (err) {
            console.error('startSession failed with error: ' + err);
            return;
        }
        console.log('started session with token: ' + token);
        getUserInfoForSessionToken(token, function(err, fetchedUserInfo) {
            if (err) { console.error('getUserInfoForSessionToken failed with error: ' + err); return; }
            console.log(userID, fetchedUserInfo.u);
            var status = userID === fetchedUserInfo.u ? "sessions work" : "sessions broken";
            console.log(status);
        });
    });
};
testSession("12345ADFHSADFJKASHDF");
*/


//var mongoServer = new MongoServer(process.env.MONGOLAB_URI, 37977, {auto_reconnect: true});
//var db = new MongoDb('exampleDb', mongoServer, {safe: true});
function connectToMongo(callback) {
mongo.connect(process.env.MONGO_URL, {
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

    db.collection('users', function(err, collectionOfUsers) {
    db.collection('events', function(err, collection) {
    db.collection('stimuli', function(err, collectionOfStimuli) {
    db.collection('polismath_test_mar02', function(err, collectionOfPcaResults) {
        callback(null, {
            mongoCollectionOfEvents: collection,
            mongoCollectionOfUsers: collectionOfUsers,
            mongoCollectionOfStimuli: collectionOfStimuli,
            mongoCollectionOfPcaResults: collectionOfPcaResults,
        });
    });
    });
    });
    });
});
}

function connectToPostgres(callback) {
    var connectionString = process.env.DATABASE_URL;
    var client = new pg.Client(connectionString);

    client.connect();
    callback(null, {
        client: client
    });
}


function hasToken(req) {
    return !!req.cookies[COOKIES.TOKEN];
}

function needOr(condition, primary, alternative) {
    return function(req, res, next) {
        if (condition(req)) {
            return primary(req, res, next);
        } else {
            return alternative(req, req, next);
        }
    };
}

// input token from body or query, and populate req.body.u with userid.
function authOptional(assigner) {
    return auth(assigner, true);
}
function auth(assigner, isOptional) {
    return function(req, res, next) {
        //var token = req.body.token;
        var token = req.cookies[COOKIES.TOKEN];
        console.log("token from cookie");
        console.dir(req.cookies);
        if (!token) {
            if (isOptional) {
                next();
            } else {
                next(connectError(401, "polis_err_auth_token_not_supplied"));
            }
            return;
        }
        //if (req.body.uid) { next(401); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
        getUserInfoForSessionToken(token, res, function(err, uid) {

    console.log("got uid");
        console.log(uid);
            if (err) { next(connectError(err, "polis_err_auth_token_missing")); return;}

            if ( req.body.uid && req.body.uid !== uid) {
                next(connectError(401, "polis_err_auth_mismatch_uid"));
                return;
            }
            assigner(req, "uid", Number(uid));
            next();
        });
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
    next();
}

// function logPath(req, res, next) {
//     console.log(req.method + " " + req.url);
//     next();
// }
    

function makeHash(ary) {
    return _.object(ary, ary.map(function(){return 1;}));
}

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
    console.error(clientVisibleErrorString, err);
    res.writeHead(httpCode || 500);
    res.end(clientVisibleErrorString);
    yell(clientVisibleErrorString);
}


function mysql_real_escape_string (str) {
    return str.replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, function (char) {
        switch (char) {
            case "\0":
                return "\\0";
            case "\x08":
                return "\\b";
            case "\x09":
                return "\\t";
            case "\x1a":
                return "\\z";
            case "\n":
                return "\\n";
            case "\r":
                return "\\r";
            case "\"":
            case "'":
            case "\\":
            case "%":
                return "\\"+char; // prepends a backslash to backslash, percent,
                                  // and double/single quotes
        }
    });
}

var sqlEscape = mysql_real_escape_string;

function getEmail(s) {
    if (typeof s !== "string" || s.length > 999 || -1 === s.indexOf("@")) {
        throw "polis_fail_parse_email";
    }
    return s;
}

function getPassword(s) {
    if (typeof s !== "string" || s.length > 999) {
        throw "polis_fail_parse_password";
    } else if (s.length < 6) {
        throw "polis_err_password_too_short";
    }
    return s;
}

function getOptionalStringLimitLength(limit) {
    return function(s) {
        if (s.length && s.length > limit) {
            throw "polis_fail_parse_string_too_long";
        }
        // strip leading/trailing spaces
        s = s.replace(/^ */,"").replace(/ *$/,"");
        return s;
    };
}



function getBool(s) {
    if ("boolean" === typeof s) {
        return s;
    }
    s = s.toLowerCase();
    if (s === 't' || s === 'true') {
        return true;
    } else if (s === 'f' || s === 'false') {
        return false;
    }
    throw "polis_fail_parse_boolean";
}
function getInt(s) {
    if (_.isNumber(s) && s >> 0 === s) {
        return s;
    }
    var x = parseInt(s);
    if (isNaN(x)) {
        throw "polis_fail_parse_int";
    }
    return x;
}

function getArrayOfString(a) {
    if (_.isString(a)) {
        a = a.split(',');
    }
    if (!_.isArray(a)) {
        throw "polis_fail_parse_int_array";
    }
    return a;
}

function getArrayOfStringNonEmpty(a) {
    if (!a || !a.length) {
        throw "polis_fail_parse_string_array_empty";
    }
    return getArrayOfString(a);
}

function getArrayOfInt(a) {
    if (_.isString(a)) {
        a = a.split(',');
    }
    if (!_.isArray(a)) {
        throw "polis_fail_parse_int_array";
    }
    return a.map(getInt);
}
function getArrayOfIntNonEmpty(a) {
    if (!a || !a.length) {
        throw "polis_fail_parse_int_array_empty";
    }
    return getArrayOfInt(a);
}

function getIntInRange(min, max) {
    return function(s) {
        var x = getInt(s)
        if (x < min || max < x) {
            throw "polis_fail_parse_int_out_of_range";
        }
        return x;
    };
}
function assignToP(req, name, x) {
    req.p = req.p || {};
    req.p[name] = x;
}

var prrrams = (function() {
    function getParam(name, parserWhichThrowsOnParseFail, assigner, required, defaultVal) {
        var f = function(req, res, next) {
            if (req.body && !_.isUndefined(req.body[name])) {
                var parsed;
                try {
                    parsed = parserWhichThrowsOnParseFail(req.body[name]);
                } catch (e) {
                    var s = "polis_err_param_parse_failed" + " " + name;
                    var err = connectError(400, s);
                    console.error(s);
                    console.error(err);
                    yell(s);
                    next(err);
                    return;
                }
                assigner(req, name, parsed);
                next();
            } else if (!required) {
                if (typeof defaultVal !== "undefined") {
                    assigner(req, name, defaultVal);
                }
                next();
            } else {
                console.dir(req);
                var s = "polis_err_param_missing" + " " + name;
                var err = connectError(400, s);
                console.error(s);
                console.error(err);
                yell(s);
                next(err);
            }
        };
        return f;
    }
    function need(name, parserWhichThrowsOnParseFail, assigner) {
        return getParam(name, parserWhichThrowsOnParseFail, assigner, true);
    }
    function want(name, parserWhichThrowsOnParseFail, assigner, defaultVal) {
        return getParam(name, parserWhichThrowsOnParseFail, assigner, false, defaultVal);
    }
    return {
        need: need,
        want: want,
    };
}());
var need = prrrams.need;
var want = prrrams.want;

var COOKIES = {
    TOKEN : 'token2',
    UID : 'uid2',
};

var oneYear = 1000*60*60*24*365;
function addCookies(res, token, uid) {
    if (domainOverride) {
        res.cookie(COOKIES.TOKEN, token, {
            path: '/',
            httpOnly: true,
            maxAge: oneYear,
        });
        res.cookie(COOKIES.UID, uid, {
            path: '/',
            maxAge: oneYear,         
        });
    } else {
        res.cookie(COOKIES.TOKEN, token, {
            path: '/',
            httpOnly: true,
            maxAge: oneYear,
            domain: '.pol.is',
            // secure: true, // TODO need HTTPS
        });
        res.cookie(COOKIES.UID, uid, {
            path: '/',
            // httpOnly: true, (client JS needs to see something to know it's signed in)
            maxAge: oneYear,
            domain: '.pol.is',
            // secure: true, // TODO need HTTPS
        });
    }
}

function generateHashedPassword(password, callback) {
    bcrypt.genSalt(12, function(errSalt, salt) {
        if (errSalt) { return callback("polis_err_salt"); return; }
        bcrypt.hash(password, salt, function(errHash, hashedPassword) {
            if (errHash) { return callback("polis_err_hash");}
            callback(null, hashedPassword);
        });
    });
}






function initializePolisAPI(err, args) {
var mongoParams = args[0];
var postgresParams = args[1];

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

var client = postgresParams.client;

var polisTypes = {
    reactions: {
        push: 1,
        pull: -1,
        see: 0,
    },
    staractions: {
        unstar: 0,
        star: 1,
    },
};
polisTypes.reactionValues = _.values(polisTypes.reactions);
polisTypes.starValues = _.values(polisTypes.staractions);

var objectIdFields = ["_id", "u", "to"];
var not_objectIdFields = ["s"];
function checkFields(ev) {
    for (var k in ev) {
        if ("string" === typeof ev[k] && objectIdFields.indexOf(k) >= 0) {
            ev[k] = ObjectId(ev[k]);
        }
        // check if it's an ObjectId, but shouldn't be
        if (ev[k].getTimestamp && not_objectIdFields.indexOf(k) >= 0) {
            console.error("field should not be wrapped in ObjectId: " + k);
            process.exit(1);
        }
    }
}
// helper for migrating off of mongo style identifiers
function match(key, zid) {
    var variants = [{}];
    variants[0][key] = zid;
    if (zid.length === 24) {
        variants.push({});
        variants[1][key] = ObjectId(zid);
    }
    return {$or: variants};
}




function authWithApiKey(assigner) {
    return function(req, res, next) {
        var header=req.headers['authorization']||'',          // get the header
              token=header.split(/\s+/).pop()||'',            // and the encoded auth token
              auth=new Buffer(token, 'base64').toString(),    // convert from base64
              parts=auth.split(/:/),                          // split on colon
              appid=parts[0], // not currently used
              apikey=parts[1];
        client.query("SELECT * FROM apikeys WHERE apikey = ($1);", [apikey], function(err, results) {
            if (err) { next(err); }
            if (!results || !results.rows || !results.rows.filter(function(row) {row.apikey === apikey;}).length) {
                next("no_such_apikey");
            }
            next(null, row.uid);
        });
    };
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
        client.query("SELECT pid FROM participants WHERE zid = ($1) and uid = ($2);", [zid, uid], function(err, results) {
            if (err) { yell("polis_err_get_pid_for_participant"); next(err); return }
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

function votesPost(res, pid, zid, tid, voteType) {
    var query = "INSERT INTO votes (pid, zid, tid, vote, created) VALUES ($1, $2, $3, $4, default);";
    var params = [pid, zid, tid, voteType];
    client.query(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
            } else {
                fail(res, 500, "polis_err_vote", err);
            }
            return;
        }
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
}

function votesGet(res, p) {
    var q = sql_votes.select(sql_votes.star())
        .where(sql_votes.zid.equals(p.zid));

    if (!_.isUndefined(p.pid)) {
        q = q.where(sql_votes.pid.equals(p.pid));
    }
    if (!_.isUndefined(p.tid)) {
        q = q.where(sql_votes.tid.equals(p.tid));
    }
    client.query(q.toString(), function(err, docs) {
        if (err) { fail(res, 500, "polis_err_votes_get", err); return; }
        res.json(docs.rows);
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
  if(/www.polis.io/.test(req.headers.host)) {
    res.writeHead(302, {
        Location: "https://pol.is" + req.url
    });
    return res.end();
  }
  return next();
}

app.use(express.logger());
app.use(redirectIfWrongDomain);
app.use(redirectIfNotHttps);
app.use(writeDefaultHead);
app.use(express.cookieParser());
app.use(express.bodyParser());
app.use(function(err, req, res, next) {
    if(!err) return next();
    console.log("error found in middleware");
    yell(err);
    next(err);
});


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
];

app.all("/v3/*", function(req, res, next) {
 
  var host = "";
  if (domainOverride) {
      host = req.protocol + "://" + domainOverride;
  } else {
      // TODO does it make sense for this middleware to look
      // at origin || referer? is Origin for CORS preflight?
      // or for everything? 
      // Origin was missing from FF, so added Referer.
      host =  req.get("Origin") || req.get("Referer"); 
  }

  // Somehow the fragment identifier is being sent by IE10????
  // Remove unexpected fragment identifier
  host = host.replace(/#.*$/, "");

  // Remove characters starting with the first slash following the double slash at the beginning.
  var result = /^[^\/]*\/\/[^\/]*/.exec(host);
  if (result && result[0]) {
      host = result[0];
  }

  if (!domainOverride && -1 === whitelistedDomains.indexOf(host)) {
      console.log('not whitelisted');
      return next(new Error("unauthorized domain: " + host));
  }
  res.header("Access-Control-Allow-Origin", host);
  res.header("Access-Control-Allow-Headers", "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With");
  res.header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Credentials", true);
  return next();
});
app.all("/v3/*", function(req, res, next) {
  if (req.method.toLowerCase() !== "options") {
    return next();
  }
  return res.send(204);
});

app.get("/v3/math/pca",
    moveToBody,
    need('zid', getInt, assignToP),
    want('lastVoteTimestamp', getInt, assignToP, 0),
    function(req, res) {
        collectionOfPcaResults.find({$and :[
            {zid: req.p.zid},
            {lastVoteTimestamp: {$gt: req.p.lastVoteTimestamp}},
            ]}, function(err, cursor) {
            if (err) { fail(res, 500, "polis_err_get_pca_results_find", err); return; }
            cursor.toArray( function(err, docs) {
                if (err) { fail(res, 500, "polis_err_get_pca_results_find_toarray", err); return; }
                if (docs.length) {
                    res.json(docs[0]);
                } else {
                    // Could actually be a 404, would require more work to determine that.
                    res.status(304).end();
                }
            });
        });
    });

app.post("/v3/auth/password",
    need('pwresettoken', getOptionalStringLimitLength(1000), assignToP),
    need('newPassword', getPassword, assignToP),
function(req, res) {
    var pwresettoken = req.p.pwresettoken;
    var newPassword = req.p.newPassword;

    getUidForPwResetToken(pwresettoken, function(err, userParams) {
        if (err) { console.error(err); fail(res, 500, "Password Reset failed. Couldn't find matching pwresettoken.", err); return; }
        var uid = Number(userParams.uid);        
        generateHashedPassword(newPassword, function(err, hashedPassword) {
            client.query("UPDATE users SET pwhash = ($1) where uid=($2);", [hashedPassword, uid], function(err, results) {
                if (err) { console.error(err); fail(res, 500, "Couldn't reset password.", err); return; }
                res.status(200).json("Password reset successful.");
                clearPwResetToken(pwresettoken, function(err) {
                    if (err) { yell(err); console.error("polis_err_auth_pwresettoken_clear_fail"); }
                });
            });
        });
    });
});

app.post("/v3/auth/pwresettoken",
    need('email', getEmail, assignToP),
function(req, res) {
    var email = req.p.email;

    // let's clear the cookies here, in case something is borked.
    clearCookies(req, res);

    getUidByEmail(email, function(err, uid) {
        setupPwReset(uid, function(err, pwresettoken) {
            sendPasswordResetEmail(uid, pwresettoken, function(err) {
                if (err) { console.error(err); fail(res, 500, "Error: Couldn't send password reset email.", err); return; }
                res.status(200).json("Password reset email sent, please check your email.");
            });
        });
    });
});

function getUidByEmail(email, callback) {
    email = email.toLowerCase();
    client.query("SELECT uid FROM users where LOWER(email) = ($1);", [email], function(err, results) {
        if (err) { return callback(err); }
        if (!results || !results.rows || !results.rows.length) {
            return callback(1);
        }
        callback(null, results.rows[0].uid);
    });
}



function clearCookies(req, res) {
    if (domainOverride) {
        for (var cookieName in req.cookies) {
            res.clearCookie(cookieName, {path: "/"});
        }
    } else {       
        for (var cookieName in req.cookies) {
            res.clearCookie(cookieName, {path: "/", domain: ".polis.io"});
        }     
        for (var cookieName in req.cookies) {
            res.clearCookie(cookieName, {path: "/", domain: "www.polis.io"});
        }          
        for (var cookieName in req.cookies) {
            res.clearCookie(cookieName, {path: "/", domain: ".pol.is"});
        }
        for (var cookieName in req.cookies) {
            res.clearCookie(cookieName, {path: "/", domain: "www.pol.is"});
        }
    }
    // addCookies(res, "", "");
    // for (var cookieName in req.cookies) {
    //     res.clearCookie(cookieName, {path: "/"});
    // }
    console.log("after clear res set-cookie: " + JSON.stringify(res._headers["set-cookie"]));
    // cookieNames.forEach(function(name) {
    //     res.clearCookie(name, {path: "/"});
    // });
}

app.post("/v3/auth/deregister",
function(req, res) {
    var token = req.cookies[COOKIES.TOKEN];

    // clear cookies regardless of auth status
    clearCookies(req, res);

    function finish() {
        res.status(200).end();
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


app.get("/v3/zinvites/:zid",
    auth(assignToP),
    need('zid', getInt, assignToP),
function(req, res) {
    // if uid is not conversation owner, fail
    client.query('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) {
            fail(res, 500, "polis_err_fetching_zinvite_invalid_conversation_or_owner", err);
            return;
        }
        if (!results || !results.rows) {
            res.writeHead(404);
            res.json({status: 404});
            return;
        }
        client.query('SELECT * FROM zinvites WHERE zid = ($1);', [req.p.zid], function(err, results) {
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

function generateOTZinvites(numTokens) {
    var dfd = new $.Deferred();
    generateToken(
        12 * numTokens,
        true, // For now, pseodorandom bytes are probably ok. Anticipating API call will generate lots of these at once, possibly draining the entropy pool. Revisit this if the otzinvites really need to be unguessable.
        function(err, longStringOfTokens) {
            if (err) {
                dfd.reject("polis_err_creating_otzinvite");
                return;
            }
            var otzinviteArray = longStringOfTokens.match(/.{1,12}/g);
            dfd.resolve(otzinviteArray);
        });
    return dfd.promise();
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
    gen(12, function(err, buf) {
        if (err) {
            return callback(err);
        }

        var prettyToken = buf.toString('base64')
            .replace(/\//g,'A').replace(/\+/g,'B'); // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)

        callback(0, prettyToken);
    });  
}

function generateAndRegisterZinvite(zid, callback) {
    generateToken(12, false, function(err, zinvite) {
        if (err) {
            return callback("polis_err_creating_zinvite");
        }
        client.query('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite], function(err, results) {
            if (err) {
                return callback("polis_err_creating_zinvite_invalid_conversation_or_owner");
            }
            return callback(0, zinvite);
        });
    });
}



// Custom invite code generator, returns the code in the response
app.get("/v3/oinvites/magicString9823742834/:note",
    moveToBody,
    auth(assignToP),
    want('note', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var note = req.p.note;

    require('crypto').randomBytes(12, function(err, buf) {
        if (err) { fail(res, "polis_err_creating_oinvite_random_bytes", err); return; }

        var oinvite = buf.toString('base64')
            .replace(/\//g,'A').replace(/\+/g,'B'); // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)

        client.query('INSERT INTO oinvites (oinvite, note, created) VALUES ($1, $2, default);', [oinvite, note], function(err, results) {
            if (err) { fail(res, 500, "polis_err_creating_oinvite_db", err); return; }
            res.status(200).end(oinvite);
        });
    });  
});


app.post("/v3/zinvites/:zid",
    moveToBody,
    auth(assignToP),    
    need('zid', getInt, assignToP),
function(req, res) {
    client.query('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) { fail(res, 500, "polis_err_creating_zinvite_invalid_conversation_or_owner", err); return; }

        generateAndRegisterZinvite(req.p.zid, function(err, zinvite) {
            if (err) { fail(res, 500, "polis_err_creating_zinvite", err); return; }
            res.status(200).json({
                zinvite: zinvite,
            });
        });
    });
});


function getConversationProperty(zid, propertyName, callback) {
    client.query('SELECT * FROM conversations WHERE zid = ($1);', [zid], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
            return;
        }
        callback(null, results.rows[0][propertyName]);
    });
}

function checkZinviteCodeValidity(zid, zinvite, callback) {
    client.query('SELECT * FROM zinvites WHERE zid = ($1) AND zinvite = ($2);', [zid, zinvite], function(err, results) {
        if (err || !results || !results.rows || !results.rows.length) {
            callback(1);
        } else {
            callback(null);// ok
        }
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

    client.query(q, [zid], function(err, qa_results) {
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
                client.query(
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

function joinConversation(zid, uid, pmaid_answers, callback) {
    client.query("INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid;", [zid, uid], function(err, docs) {
        if (err) {
            console.log("failed to insert into participants");
            console.dir(err);
            return callback(err);
        }
        var pid = docs && docs.rows && docs.rows[0] && docs.rows[0].pid;

        saveParticipantMetadataChoices(zid, pid, pmaid_answers, function(err) {
            if (err) {
                console.log("failed to saveParticipantMetadataChoices");
                console.dir(err);
                return callback(err);
            }
            callback(err, pid);
        });
    });
}

function isOwnerOrParticipant(zid, uid, callback) { 

    if (true) {
        callback(null); // TODO remove!
        return;
    }

    // TODO should be parallel.
    // look into bluebird, use 'some' https://github.com/petkaantonov/bluebird
    getPid(zid, uid, function(err) {
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
    client.query("SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);", [zid, uid], function(err, docs) {
        var pid;
        if (!docs || !docs.rows || docs.rows.length === 0) {
            err = err || 1;
        }
        callback(err);
    });
}

// returns a pid of -1 if it's missing
function getPid(zid, uid, callback) {
    client.query("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, docs) {
        var pid = -1;
        if (docs && docs.rows && docs.rows[0]) {
            pid = docs.rows[0].pid;
        }
        callback(err, pid);
    });
}

function getAnswersForConversation(zid, callback) {
    client.query("SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;", [zid], function(err, x) {
        if (err) { callback(err); return;}
        callback(0, x.rows);
    });
}

function getUserInfoForUid(uid, callback) {
    client.query("SELECT email, hname from users where uid = $1", [uid], function(err, results) {
        if (err) { return callback(err); }
        if (!results.rows || !results.rows.length) {
            return callback(null);
        }
        callback(null, results.rows[0]);
    });
}
// function sendEmailToUser(uid, subject, bodyText, callback) {
//     getEmailForUid(uid, function(err, email) {
//         if (err) { return callback(err);}
//         if (!email) { return callback('missing email');}
//         // mailgun.sendText('noreply@polis.io', ['Mike <m@bjorkegren.com>', 'michael@bjorkegren.com'],        
//         mailgun.sendText(
//             'noreply@polis.io',
//             [email],
//             subject,
//             bodyText,
//             'noreply@polis.io', {},
//             function(err) {
//                 if (err) {
//                  console.error('mailgun send error: ' + err);
//                 }
//                 callback(err);
//             }
//         ); 
//     });
// }


function sendPasswordResetEmail(uid, pwresettoken, callback) {
    getUserInfoForUid(uid, function(err, userInfo) {
        if (err) { return callback(err);}
        if (!userInfo) { return callback('missing user info');}
        var server = devMode ? "http://localhost:5000" : "https://pol.is";
        var body = "" +
            "Hi " + userInfo.hname + ",\n" +
            "\n" +
            "We have just received a password reset request for " + userInfo.email + "\n" +
            "\n" +
            "To reset your password, visit this url:\n" +
            server + "/#pwreset/" + pwresettoken + "\n" +
            "\n" +
            "Thank you for using Polis\n";

        mailgun.sendText(
            'Polis Support <noreply@polis.io>',
            [userInfo.email],
            "Polis Password Reset",
            body,
            'noreply@polis.io', {},
            function(err) {
                if (err) {
                    console.error('mailgun send error: ' + err);
                }
                callback(err);
            }
        );
    });
}

function sendCreatedLinkToEmail(){

    //todo move stuff out of the post sendConversationLinkToEmail POST and into functions 

}

app.get("/v3/participants",
    moveToBody,
    authOptional(assignToP),
    want('pid', getInt, assignToP),
    need('zid', getInt, assignToP),
    // need('uid', getInt, assignToP), // requester
function(req, res) {
    var pid = req.p.pid;
    var uid = req.p.uid;
    var zid = req.p.zid;

    function fetchOne() {
        client.query("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
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
        client.query("SELECT users.hname, users.email, participants.pid FROM users INNER JOIN participants ON users.uid = participants.uid WHERE zid = ($1) ORDER BY participants.pid;", [zid], function(err, result) {
            if (err || !result || !result.rows || !result.rows.length) { fail(res, 500, "polis_err_fetching_participant_info", err); return; }
            // console.dir(result.rows);
            res.json(result.rows);
            // .map(function(row) {
            //     return _.pick(row, ["hname", "email"]);
            // }));
        });
    }
    client.query("SELECT is_anon FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
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


function userHasAnsweredZeQuestions(zid, answers, callback) {
    getAnswersForConversation(zid, function(err, available_answers) {
        if (err) { callback(err); return;}

        var q2a = _.indexBy(available_answers, 'pmqid');
        var a2q = _.indexBy(available_answers, 'pmaid');
        for (var i = 0; i < answers.length; i++) {
            var pmqid = a2q[answers[i]].pmqid;
            delete q2a[pmqid];
        }
        var remainingKeys = _.keys(q2a);
        var missing = remainingKeys && remainingKeys.length > 0;
        if (missing) {
            return callback('polis_err_metadata_not_chosen_pmqid_' + remainingKeys[0]);
        } else {
            return callback(0);
        }
    });
}

app.post("/v3/participants",
    auth(assignToP),
    need('zid', getInt, assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    want('answers', getArrayOfInt, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
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
    function onAllowed() {
        userHasAnsweredZeQuestions(zid, answers, function(err) {
            if (err) { fail(res, 500, "polis_err_fetching_answers", err); return; }
            joinConversation(zid, uid, answers, function(err, pid) {
                if (err) { fail(res, 500, "polis_err_add_participant", err); return; }
                finish(pid);
            });
        }); // end get is_public
    }

    function doJoin() {
        // get all info, be sure to return is_anon, so we don't poll for user info in polis.js
        getConversationProperty(zid, "is_public", function(err, is_public) {
            if (err) { fail(res, 500, "polis_err_add_participant_property_check", err); return; }
            if (is_public) {
                onAllowed();
            } else {
                checkZinviteCodeValidity(zid, zinvite, function(err) {
                    if (err) {
                        isConversationOwner(zid, uid, function(err) {
                            if (err) { fail(res, 403, "polis_err_add_participant_bad_zinvide_code", err); return; }
                            onAllowed();
                        });
                        return;
                    }
                    onAllowed();
                });
            }
        }); // end userHasAnsweredZeQuestions
    }

    // Check if already in the conversation
    getPid(zid, req.p.uid, function(err, pid) {
        console.dir(arguments);
        if (!err && pid >= 0) {
            finish(pid);
            return;
        }
        doJoin();
    });
});

// client should really supply this
//function getParticipantId(uid, zid, callback) {
    //client.query("SELECT pid FROM participants WHERE uid = ($1) AND zid = ($2);", [uid, zid], function(err, docs) {
        //if (err) { callback(err); return; }
        //var pid = docs && docs[0] && docs[0].pid;
        //callback(null, pid);
    //});
//}


app.post("/v3/beta", 
    need('email', getEmail, assignToP),
    want('name', getOptionalStringLimitLength(999), assignToP),
    want('organization', getOptionalStringLimitLength(999), assignToP),
    function(req,res){

        var email = req.p.email;
        var name = req.p.name;
        var organization = req.p.organization;

        client.query("INSERT INTO beta (email, name, organization, created) VALUES ($1, $2, $3, default);", [email, name, organization], function(err, result) {
            if (err) { 
                console.log(email, name, organization);
                fail(res, 403, "polis_err_beta_registration", err);
                return;
            }
            res.status(200).json({});
        });
});


app.post("/v3/auth/login",
    need('password', getOptionalStringLimitLength(999), assignToP),
    want('email', getEmail, assignToP),
function(req, res) {
    var password = req.p.password;
    var email = req.p.email || "";
    email = email.toLowerCase();
    if (!_.isString(password) || password.length == 0) { fail(res, 403, "polis_err_login_need_password", new Error("polis_err_login_need_password")); return; }
    client.query("SELECT * FROM users WHERE LOWER(email) = ($1);", [email], function(err, docs) {
        docs = docs.rows;
        if (err) { fail(res, 403, "polis_err_login_unknown_user_or_password", err); console.error("polis_err_login_unknown_user_or_password_err"); return; }
        if (!docs || docs.length === 0) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_noresults"); return; }
        var hashedPassword  = docs[0].pwhash;
        var uid = docs[0].uid;

        console.log("email", email);
        console.log("password", password);
        console.log("pw, hashed", password, hashedPassword);
        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
            console.log("errCompare, result", errCompare, result);
            if (errCompare || !result) { fail(res, 403, "polis_err_login_unknown_user_or_password"); console.error("polis_err_login_unknown_user_or_password_badpassword"); return; }
            
            startSession(uid, function(errSess, token) {
                var response_data = {
                    uid: uid,
                    email: email,
                    token: token
                };
                addCookies(res, token, uid);
                res.json(response_data);
            }); // startSession
        }); // compare
    }); // query
}); // /v3/auth/login


function sqlHasResults(query, params, callback) {
    client.query(query, params, function(err, results) {
        if (err) { return callback(err); }
        if (!results || !results.rows || !results.rows.length) {
            return callback(0, false);
        }
        callback(0, true);
    });
}

function oinviteExists(oinvite, callback) {
    sqlHasResults(
        "select oinvite from oinvites where oinvite = ($1);",
        [oinvite], 
        callback);
}
function zinviteExists(zinvite, callback) {
    sqlHasResults(
        "select zinvite from zinvites where zinvite = ($1);",
        [zinvite], 
        callback);
}

app.post("/v3/auth/new",
    want('anon', getBool, assignToP),
    want('password', getPassword, assignToP),
    want('email', getOptionalStringLimitLength(999), assignToP),
    want('hname', getOptionalStringLimitLength(999), assignToP),
    want('oinvite', getOptionalStringLimitLength(999), assignToP),
    want('zinvite', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var hname = req.p.hname;
    var password = req.p.password;
    var email = req.p.email;
    var oinvite = req.p.oinvite;
    var zinvite = req.p.zinvite;

  // Check for an invite code
  // if (!oinvite && !zinvite) {
  //   fail(res, 982748723, "polis_err_missing_invite", 403);
  // }
  if (oinvite) {
    oinviteExists(oinvite, function(err, ok) {
      if (err) { fail(res, 500, "polis_err_reg_oinvite", err); return; }
      if (!ok) { fail(res, 403, "polis_err_reg_unknown_oinvite", new Error("polis_err_reg_unknown_oinvite")); return; }
      finishedValidatingInvite();
   });
  } else if (zinvite) {
    zinviteExists(zinvite, function(err, ok) {
      if (err) { fail(res, 500, "polis_err_reg_zinvite", err); return; }
      if (!ok) { fail(res, 403, "polis_err_reg_unknown_zinvite", new Error("polis_err_reg_unknown_oinvite")); return; }
      finishedValidatingInvite();
    });
  } else {
    finishedValidatingInvite();
  }


  function finishedValidatingInvite() {
    if (!email) { fail(res, 400, "polis_err_reg_need_email"); return; }
    if (!hname) { fail(res, 400, "polis_err_reg_need_name"); return; }
    if (!password) { fail(res, 400, "polis_err_reg_password"); return; }
    if (password.length < 6) { fail(res, 400, "polis_err_reg_password_too_short"); return; }
    if (!_.contains(email, "@") || email.length < 3) { fail(res, 400, "polis_err_reg_bad_email"); return; }

    client.query("SELECT * FROM users WHERE email = ($1)", [email], function(err, docs) {
        if (err) { fail(res, 500, "polis_err_reg_checking_existing_users", err); return; }
            if (docs.length > 0) { fail(res, 403, "polis_err_reg_user_exists", new Error("polis_err_reg_user_exists")); return; }

            generateHashedPassword(password, function(err, hashedPassword) {
                if (err) { fail(res, 500, "polis_err_generating_hash", err); return; }
                    var query = "insert into users " +
                        "(email, pwhash, hname, zinvite, oinvite, is_owner) VALUES "+
                        "($1, $2, $3, $4, $5, $6) "+
                        "returning uid;";
                    var vals = 
                        [email, hashedPassword, hname, zinvite||null, oinvite||null, true];

                    client.query(query, vals, function(err, result) {
                        if (err) { console.dir(err); fail(res, 500, "polis_err_reg_failed_to_add_user_record", err); return; }
                        var uid = result && result.rows && result.rows[0] && result.rows[0].uid;
                        startSession(uid, function(err,token) {
                            if (err) { fail(res, 500, "polis_err_reg_failed_to_start_session", err); return; }
                            addCookies(res, token, uid);
                            res.json({
                                uid: uid,
                                hname: hname,
                                email: email,
                                // token: token
                            });

                            var params = {
                                "email" : email,
                                "name" : hname
                            };
                            intercom.createUser(params, function(err, res) {
                                if (err) {
                                    console.log(err);
                                    console.error("polis_err_intercom_create_user_fail");
                                    console.dir(params);
                                    yell("polis_err_intercom_create_user_fail");
                                    return;
                                }
                                console.log('intercom ok');
                                console.dir(params);
                            });
                        }); // end startSession
                    }); // end insert user
            }); // end generateHashedPassword
    }); // end find existing users
  } // end finishedValidatingInvite
}); // end /v3/auth/new


app.post("/v2/feedback",
    auth(assignToP),
    function(req, res) {
                var data = req.body;
                    data.events.forEach(function(ev){
                        if (!ev.feedback) { fail(res, 400, "polis_err_missing_feedback", new Error("polis_err_missing_feedback")); return; }
                        if (data.uid) { ev.uid = ObjectId(data.uid); }
                        checkFields(ev);
                        collection.insert(ev, function(err, cursor) {
                            if (err) { fail(res, 500, "polis_err_sending_feedback", err); return; }
                            res.end();
                        }); // insert
                    }); // each 
    });

app.get("/v3/comments",
    moveToBody,
    authOptional(assignToP),
    need('zid', getInt, assignToP),
    want('tids', getArrayOfInt, assignToP),
    want('pid', getInt, assignToP),
    want('not_pid', getInt, assignToP),
    want('not_voted_by_pid', getInt, assignToP),
//    need('lastServerToken', _.identity, assignToP),
function(req, res) {

    function handleResult(err, docs) {
        if (err) { fail(res, 500, "polis_err_get_comments", err); return; }
        if (docs.rows && docs.rows.length) {
            res.json(
                docs.rows.map(function(row) { return _.pick(row, ["txt", "tid", "created"]); })
            );
        } else {
            res.json([]);
        }
    }


    var q = sql_comments.select(sql_comments.star())
        .where(
            sql_comments.zid.equals(req.p.zid)
        );
    if (!_.isUndefined(req.p.pid)) {
        q = q.where(sql_comments.pid.equals(req.p.pid));
    }
    if (!_.isUndefined(req.p.tids)) {
        q = q.where(sql_comments.tid.in(req.p.tids));
    }
    if (!_.isUndefined(req.p.not_pid)) {
        q = q.where(sql_comments.pid.notEquals(req.p.not_pid));
    }
    if (!_.isUndefined(req.p.not_voted_by_pid)) {
        // 'SELECT * FROM comments WHERE zid = 12 AND tid NOT IN (SELECT tid FROM votes WHERE pid = 1);'
        // Don't return comments the user has already voted on.
        q = q.where(
            sql_comments.tid.notIn(
                sql_votes.subQuery().select(sql_votes.tid)
                    .where(
                        sql_votes.zid.equals(req.p.zid)
                    ).and(
                        sql_votes.pid.equals(req.p.not_voted_by_pid)
                    )
                )
            );
    }
    q = q.order(sql_comments.created);
    q = q.limit(999); // TODO paginate

    //if (_.isNumber(req.p.not_pid)) {
        //query += " AND pid != ($"+ (i++) + ")";
        //parameters.unshift(req.p.not_pid);
    //}
    //
    //client.query("SELECT * FROM comments WHERE zid = ($1) AND created > (SELECT to_timestamp($2));", [zid, lastServerToken], handleResult);
    console.log("mike", q.toString());
    client.query(q.toString(), [], handleResult);
}); // end GET /v3/comments



function isDuplicateKey(err) {
    return err.code === 23505;
}
function failWithRetryRequest(res) {
    res.setHeader('Retry-After', 0);
    console.warn(57493875);
    res.writeHead(500).send(57493875);
}

app.post("/v3/comments",
    auth(assignToP),
    need('zid', getInt, assignToP),
    need('txt', getOptionalStringLimitLength(1000), assignToP),
function(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
        if (err || pid < 0) { fail(res, 500, "polis_err_getting_pid", err); return; }
        console.log(pid);
        console.log(req.p.uid);
        client.query(
            "INSERT INTO COMMENTS (tid, pid, zid, txt, created) VALUES (null, $1, $2, $3, default) RETURNING tid;",
            [pid, req.p.zid, req.p.txt],
            function(err, docs) {
                if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
                docs = docs.rows;
                var tid = docs && docs[0] && docs[0].tid;
                // Since the user posted it, we'll submit an auto-pull for that.
                //var autopull = {
                    //zid: req.p.zid,
                    //vote: polistypes.reactions.pull,
                    //tid: tid,
                    //pid: req.p.pid
                //};
                res.json({
                    tid: tid,
                });
                //votesPost(res, pid, zid, tid, [autopull]);
            }); // insert
    });

        //var rollback = function(client) {
          //client.query('ROLLBACK', function(err) {
            //if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
          //});
        //};
        //client.query('BEGIN;', function(err) {
            //if(err) return rollback(client);
            ////process.nextTick(function() {
              //client.query("SET CONSTRAINTS ALL DEFERRED;", function(err) {
                //if(err) return rollback(client);
                  //client.query("INSERT INTO comments (tid, pid, zid, txt, created) VALUES (null, $1, $2, $3, default);", [pid, zid, txt], function(err, docs) {
                    //if(err) return rollback(client);
                      //client.query('COMMIT;', function(err, docs) {
                        //if (err) { fail(res, 500, "polis_err_post_comment", err); return; }
                        //var tid = docs && docs[0] && docs[0].tid;
                        //// Since the user posted it, we'll submit an auto-pull for that.
                        //var autoPull = {
                            //zid: zid,
                            //vote: polisTypes.reactions.pull,
                            //tid: tid,
                            //pid: pid
                        //};
                        ////votesPost(res, pid, zid, tid, [autoPull]);
                      //}); // COMMIT
                    //}); // INSERT
                //}); // SET CONSTRAINTS
              ////}); // nextTick
        //}); // BEGIN
}); // end POST /v3/comments

app.get("/v3/votes/me",
    moveToBody,
    auth(assignToP),
    need('zid', getInt, assignToP),
function(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
        if (err || pid < 0) { fail(res, 500, "polis_err_getting_pid", err); return; }
        client.query("SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);", [req.p.zid, req.p.pid], function(err, docs) {
            if (err) { fail(res, 500, "polis_err_get_votes_by_me", err); return; }
            res.json({
                votes: docs.rows,
            });
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

    client.query(query.toString(), function(err, results) {
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
app.get("/v3/selection",
    moveToBody,
    want('users', getArrayOfInt, assignToP),
    need('zid', getInt, assignToP),
function(req, res) {
        var zid = req.p.zid;
        var users = req.p.users || [];
        
        getVotesForZidPids(zid, users, function(err, voteRecords) {
            if (err) { fail(res, 500, "polis_err_get_selection", err); console.dir(results); return; }
            if (!voteRecords.length) { fail(res, 500, "polis_err_get_selection_no_votes", new Error("polis_err_get_selection_no_votes")); return; }

            var commentIdCounts = getCommentIdCounts(voteRecords);
            commentIdCounts = commentIdCounts.slice(0, 10);
            var commentIdsOrdering = commentIdCounts.map(function(x) { return {tid: x[0]};});
            var commentIds = commentIdCounts.map(function(x) { return x[0];});

            var queryForSelectedComments = sql_comments.select(sql_comments.star())
                .where(sql_comments.zid.equals(zid))
                .and(sql_comments.tid.in(commentIds));
            client.query(queryForSelectedComments.toString(), function(err, results) {
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
                res.json(comments);
            }); // end comments query
        }); // end votes query
    }); // end GET selection

app.get("/v3/votes",
    moveToBody,
    need('zid', getInt, assignToP),
    want('pid', getInt, assignToP),
    want('tid', getInt, assignToP),
function(req, res) {
    votesGet(res, req.p);
});

app.post("/v3/votes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('vote', getIntInRange(-1, 1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
        votesPost(res, req.p.pid, req.p.zid, req.p.tid, req.p.vote);
});

app.post("/v3/stars",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('starred', getIntInRange(0,1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
    var query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default);";
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.starred];
    client.query(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
            } else {
                fail(res, 500, "polis_err_vote", err);
            }
            return;
        }
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
});

app.post("/v3/trashes",
    auth(assignToP),
    need('tid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('trashed', getIntInRange(0,1), assignToP),
    getPidForParticipant(assignToP, pidCache),
function(req, res) {
    var query = "INSERT INTO trashes (pid, zid, tid, trashed, created) VALUES ($1, $2, $3, $4, default);";
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.trashed];
    client.query(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 406, "polis_err_vote_duplicate", err); // TODO allow for changing votes?
            } else {
                fail(res, 500, "polis_err_vote", err);
            }
            return;
        }
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
});

function verifyMetadataAnswersExistForEachQuestion(zid) {
  var errorcode = "polis_err_missing_metadata_answers";
  return new Promise(function(resolve, reject) {
    client.query("select pmqid from participant_metadata_questions where zid = ($1);", [zid], function(err, results) {
        if (err) {reject(err); return }
        if (!results.rows || !results.rows.length) {
            resolve();
            return;
        }
        var pmqids = results.rows.map(function(row) { return Number(row.pmqid); });
        client.query(
            "select pmaid, pmqid from participant_metadata_answers where pmqid in ("+pmqids.join(",")+") and alive = TRUE and zid = ($1);",
            [zid],
            function(err, results) {
                if (err) { reject(err); return }
                if (!results.rows || !results.rows.length) {
                    reject(errorcode);
                    return;
                }
                var questions = _.reduce(pmqids, function(o, pmqid) { o[pmqid] = 1; return o; }, {});
                results.rows.forEach(function(row) {
                    delete questions[row.pmqid];
                });
                if (Object.keys(questions).length) {
                    reject(errorcode);
                } else {
                    resolve();
                }
            });
    });
  });
}

app.put('/v3/conversations/:zid',
    moveToBody,
    auth(assignToP),
    need('zid', getInt, assignToP),
    want('is_active', getBool, assignToP),
    want('is_anon', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('is_public', getBool, assignToP),
    want('topic', getOptionalStringLimitLength(1000), assignToP),
    want('description', getOptionalStringLimitLength(50000), assignToP),
    want('verifyMeta', getBool, assignToP),
function(req, res){

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
    if (!_.isUndefined(req.p.is_public)) {
        fields.is_public = req.p.is_public;
    }
    if (!_.isUndefined(req.p.topic)) {
        fields.topic = req.p.topic;
    }
    if (!_.isUndefined(req.p.description)) {
        fields.description = req.p.description;
    }

    var q = sql_conversations.update(
            fields
        )
        .where(
            sql_conversations.zid.equals(req.p.zid)
        ).and(
            sql_conversations.owner.equals(req.p.uid)
        );
    verifyMetaPromise.then(function() {
        client.query(
            q.toString(),
            function(err, result){
                if (err) {
                    fail(res, 500, "polis_err_update_conversation", err);
                    return;
                }
                res.status(200).json({});
            }
        );
    }, function(err) {
        res.status(500).json(err);
    });
});

app.delete('/v3/metadata/questions/:pmqid',
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

app.delete('/v3/metadata/answers/:pmaid',
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
    client.query("SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);", [pmaid], function(err, result) {
        if (err) { callback(err); return;}
        if (!result.rows || !result.rows.length) {
            callback("polis_err_zid_missing_for_answer");
            return;
        }
        callback(null, result.rows[0].zid);
    });
}

function getZidForQuestion(pmqid, callback) {
    client.query("SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);", [pmqid], function(err, result) {
        if (err) {console.dir(err);  callback(err); return;}
        if (!result.rows || !result.rows.length) {
            callback("polis_err_zid_missing_for_question");
            return;
        }
        callback(null, result.rows[0].zid);
    });
}

function deleteMetadataAnswer(pmaid, callback) {
    // client.query("update participant_metadata_choices set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
    //     if (err) {callback(34534545); return;}
        client.query("update participant_metadata_answers set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
            if (err) {callback(err); return;}
            callback(null);
        });           
     // });
}

function deleteMetadataQuestionAndAnswers(pmqid, callback) {
    // client.query("update participant_metadata_choices set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
    //     if (err) {callback(93847834); return;}
        client.query("update participant_metadata_answers set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
            if (err) {callback(err); return;}
            client.query("update participant_metadata_questions set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
                if (err) {callback(err); return;}
                callback(null);
            });
        });           
     // });
}

app.get('/v3/metadata/questions',
    moveToBody,
    needOr(
        hasToken,
        auth(assignToP),
        need('zinvite', getOptionalStringLimitLength(300), assignToP)),
    need('zid', getInt, assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;

    if (zinvite) {
        checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else {
        isOwnerOrParticipant(zid, uid, doneChecking);
    }
    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_get_participant_metadata_auth", err); return; }

        async.parallel([
            function(callback) { client.query("SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);", [zid], callback) },
            //function(callback) { client.query("SELECT * FROM participant_metadata_answers WHERE alive = true AND zid = ($1);", [zid], callback) },
            //function(callback) { client.query("SELECT * FROM participant_metadata_choices WHERE alive = true AND zid = ($1);", [zid], callback) },
        ], function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata_questions", err); return; }
            var keys = result[0] && result[0].rows;
            res.status(200).json(keys);
        });
    }
});

app.post('/v3/metadata/questions',
    moveToBody,
    auth(assignToP),
    need('key', getOptionalStringLimitLength(999), assignToP),
    need('zid', getInt, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var key = req.p.key;
    var uid = req.p.uid;
  
    isConversationOwner(zid, uid, doneChecking);
    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_post_participant_metadata_auth", err); return; }
        client.query("INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2) RETURNING *;", [
            zid,
            key,
            ], function(err, results) {
            if (err || !results || !results.rows || !results.rows.length) { fail(res, 500, "polis_err_post_participant_metadata_key", err); return; }

            res.status(200).json(results.rows[0]);
        });
    }
});
    
app.post('/v3/metadata/answers',
    moveToBody,
    auth(assignToP),
    need('zid', getInt, assignToP),
    need('pmqid', getInt, assignToP),
    need('value', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var pmqid = req.p.pmqid;
    var value = req.p.value;

    function finish(row) {
        res.status(200).json(row);
    }

    isConversationOwner(zid, uid, doneChecking);
    function doneChecking(err, foo) {
        if (err) { fail(res, 403, "polis_err_post_participant_metadata_auth", err); return; }
        client.query("INSERT INTO participant_metadata_answers (pmqid, zid, value, pmaid) VALUES ($1, $2, $3, default) RETURNING *;", [pmqid, zid, value, ], function(err, results) {
            if (err || !results || !results.rows || !results.rows.length) { 
                client.query("UPDATE participant_metadata_answers set alive = TRUE where pmqid = ($1) AND zid = ($2) AND value = ($3) RETURNING *;", [pmqid, zid, value], function(err, results) {
                    if (err) { fail(res, 500, "polis_err_post_participant_metadata_value", err); return; }
                    finish(results.rows[0]);
                });
            } else {
                finish(results.rows[0]);
            }
        });
    }
});

app.get('/v3/metadata/answers',
    moveToBody,
    needOr(
        hasToken,
        auth(assignToP),
        need('zinvite', getOptionalStringLimitLength(300), assignToP)),
    need('zid', getInt, assignToP),
    want('pmqid', getInt, assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
    var pmqid = req.p.pmqid;

    if (zinvite) {
        checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else {
        isOwnerOrParticipant(zid, uid, doneChecking);
    }
    
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
        client.query(query.toString(), function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata_answers", err); return; }
            res.status(200).json(result.rows);
        });
    }
});

app.get('/v3/metadata',
    moveToBody,
    auth(assignToP),
    need('zid', getInt, assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
    // TODO want('lastMetaTime', getInt, assignToP, 0),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;

    if (zinvite) {
        checkZinviteCodeValidity(zid, zinvite, doneChecking);
    } else {
        isOwnerOrParticipant(zid, uid, doneChecking);
    }
    function doneChecking(err) {
        if (err) { fail(res, 403, "polis_err_get_participant_metadata_auth", err); return; }
        async.parallel([
            function(callback) { client.query("SELECT * FROM participant_metadata_questions WHERE zid = ($1);", [zid], callback) },
            function(callback) { client.query("SELECT * FROM participant_metadata_answers WHERE zid = ($1);", [zid], callback) },
            function(callback) { client.query("SELECT * FROM participant_metadata_choices WHERE zid = ($1);", [zid], callback) },
        ], function(err, result) {
            if (err) { fail(res, 500, "polis_err_get_participant_metadata", err); return; }
            var keys = result[0] && result[0].rows;
            var vals = result[1] && result[1].rows;
            var choices = result[2] && result[2].rows;
            var o = {};
            var keyNames = {};
            var valueNames = {};
            var i;
            if (!keys || !keys.length) {
                res.status(200).json({});
                return;
            }
            for (i = 0; i < keys.length; i++) {
                // Add a map for each keyId
                var k = keys[i];
                o[k.pmqid] = {}; 
                // keep the user-facing key name
                keyNames[k.pmqid] = k.key;
            }
            for (i = 0; i < vals.length; i++) {
                // Add an array for each possible valueId
                var k = vals[i];
                var v = vals[i];
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
});

app.post('/v3/metadata/new',
    moveToBody,
    auth(assignToP),
    want('oid', getInt, assignToP),
    need('metaname', getInt, assignToP),
    need('metavalue', getInt, assignToP),
function(req, res) {
});


app.get('/v3/conversations/:zid',
    moveToBody,
    authOptional(assignToP),
    want('zid', getInt, assignToP),
    want('zinvite', getOptionalStringLimitLength(300), assignToP),
function(req, res) {
    var zid = req.p.zid;
    var zinvite = req.p.zinvite;

    // TODO check zinvite before giving out info.

    client.query('SELECT * FROM conversations WHERE zid = ($1);', [zid], function(err, results) {
        if (err) { fail(res, 500, "polis_err_get_conversation_by_zid", err); return; }
        if (!results || !results.rows || !results.rows.length) {
            fail(res, 404, "polis_err_no_such_conversation", new Error("polis_err_no_such_conversation"));
            return;
        }
        var conv = results.rows[0];
        client.query('SELECT * from participant_metadata_questions where zid = ($1)', [zid], function(err, metadataResults) {
            if (err) { fail(res, 500, "polis_err_get_conversation_metadata_by_zid", err); return; }
            if (!metadataResults || !metadataResults.rows || !metadataResults.rows.length) {
                // return the conversation data without adding any metadata stuff
            } else {
                conv.hasMetadata = true;
            }
            client.query('SELECT * from users where uid = ($1)', [conv.owner], function(err, results){
                if (err) { fail(res, 500, "polis_err_get_uid_from_users", err); return; }
                if (!results || !results.rows || !results.rows.length) {
                    fail(res, 500, "polis_err_no_such_conversation_owner", new Error("polis_err_no_such_conversation"));
                    return;
                }
                var ownername = results.rows[0].hname;
                conv.ownername = ownername;
                res.status(200).json(conv);
            })
        });
    });
});


app.get('/v3/conversations',
    moveToBody,
    auth(assignToP),
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('zid', getInt, assignToP),
    want('owner', getInt, assignToP), // TODO needed?
function(req, res) {

  // First fetch a list of conversations that the user is a participant in.
  client.query('select zid from participants where uid = ($1);', [req.p.uid], function(err, results) {
    if (err) { fail(res, 500, "polis_err_get_conversations_participated_in", err); return; }

    var participantIn = results && results.rows && _.pluck(results.rows, "zid") || null;

    var query = sql_conversations.select(sql_conversations.star())
    var orClauses = sql_conversations.owner.equals(req.p.uid);
    if (participantIn.length) {
        orClauses = orClauses.or(sql_conversations.zid.in(participantIn));
    }
    query = query.where(orClauses);
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
    query = query.order(sql_conversations.created);
    query = query.limit(999); // TODO paginate

    client.query(query.toString(), function(err, result) {
        if (err) { fail(res, 500, "polis_err_get_conversations", err); return; }
        var data = result.rows || [];

        var conversationsWithZinvites = data.filter(function(conv) {
            return conv.owner === req.p.uid && !conv.is_public;
        }).map(function(conv) {
            return conv.zid;
        });

        if (!conversationsWithZinvites.length) {
            return res.json(data);
        }
        client.query("select * from zinvites where zid in (" + conversationsWithZinvites.join(",") + ");",[], function(err, results) {
            if (err) { fail(res, 500, "polis_err_get_conversation_zinvites", err); return; }
            var zinvites = _.indexBy(results.rows, "zid");

            data = data.map(function(conv) {
                if (zinvites[conv.zid]) {
                    conv.zinvites = [zinvites[conv.zid].zinvite];
                }
                return conv;
            });
            res.json(data);
        });
    });
  });
});


function isUserAllowedToCreateConversations(uid, callback) {
    callback(null, true);
    // client.query("select is_owner from users where uid = ($1);", [uid], function(err, results) {
    //     if (err) { return callback(err); }
    //     if (!results || !results.rows || !results.rows.length) {
    //         return callback(1);
    //     }
    //     callback(null, results.rows[0].is_owner);
    // });
}

// TODO check to see if ptpt has answered necessary metadata questions.
app.post('/v3/conversations/undefined', // TODO undefined is not ok
    auth(assignToP),
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('is_public', getBool, assignToP, false),
    want('is_anon', getBool, assignToP, false),
    want('topic', getOptionalStringLimitLength(1000), assignToP, ""),
    want('description', getOptionalStringLimitLength(50000), assignToP, ""),
function(req, res) {

  isUserAllowedToCreateConversations(req.p.uid, function(err, isAllowed) {
    if (err) { fail(res, 403, "polis_err_add_conversation_failed_user_check", err); return; }
    if (!isAllowed) { fail(res, 403, "polis_err_add_conversation_not_enabled", new Error("polis_err_add_conversation_not_enabled")); return; }
    client.query(
'INSERT INTO conversations (zid, owner, created, topic, description, participant_count, is_active, is_draft, is_public, is_anon)  VALUES(default, $1, default, $2, $3, default, $4, $5, $6, $7) RETURNING zid;',
[req.p.uid, req.p.topic, req.p.description, req.p.is_active, req.p.is_draft, req.p.is_public, req.p.is_anon], function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                yell(err)
                failWithRetryRequest(res);
            } else {
                fail(res, 500, "polis_err_add_conversation", err);
            }
            return;
        }

        var zid = result && result.rows && result.rows[0] && result.rows[0].zid;
        function finish(zinvite) {
            var data = {
                zid: zid,
            };
            if (zinvite) {
                data.zinvites = [zinvite];
            }
            res.status(200).json(data);
        }
        if (!req.p.is_public) {
            generateAndRegisterZinvite(zid, function(err, zinvite) {
                if (err) { fail(res, 500, "polis_err_zinvite_create", err); return; }
                finish(zinvite);
            });
        } else {
            finish();
        }
    }); // end insert
  }); // end isUserAllowedToCreateConversations
}); // end post conversations

/*
app.get('/v3/users',
function(req, res) {
    // creating a user may fail, since we randomly generate the uid, and there may be collisions.
    var query = client.query('SELECT * FROM users');
    var responseText = "";
    query.on('row', function(row, result) {
        responseText += row.user_id + "\n";
    });
    query.on('end', function(row, result) {
        res.status(200).end(responseText);
    });
});
*/




app.post('/v3/query_participants_by_metadata',
    auth(assignToP),
    need('zid', getInt, assignToP),
    need('pmaids', getArrayOfInt, assignToP, []),
function(req, res) {
    var uid = req.p.uid;
    var zid = req.p.zid;    
    var pmaids = req.p.pmaids;

    if (!pmaids.length) {
        // empty selection
        return res.status(200).json([]);
    }
    isOwnerOrParticipant(zid, uid, doneChecking);
    function doneChecking() {
        // find list of participants who are not eliminated by the list of excluded choices.
        client.query(
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
});

app.post('/v3/sendCreatedLinkToEmail', 
    auth(assignToP),
    need('zid', getInt, assignToP),
function(req, res){
    console.log(req.p)
    client.query("SELECT * FROM users WHERE uid = $1", [req.p.uid], function(err, results){
        if (err) { fail(res, 500, "polis_err_get_email_db", err); return; }
        var email = results.rows[0].email;
        var fullname = results.rows[0].hname;
        client.query("select * from zinvites where zid = $1", [req.p.zid], function(err, results){
            var zinvite = results.rows[0].zinvite;
            var server = devMode ? "http://localhost:5000" : "https://pol.is";
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
    
            mailgun.sendText(
                'pol.is <noreply@pol.is>',
                email,
                "Link: " + createdLink,
                body,
                'noreply@polis.io', {},
                function(err) {
                    if (err) {
                        console.error('mailgun send error: ' + err);
                        fail(res, 500, "mailgun_error", err);
                    }
                    res.status(200).json({})
                }
            );
        })
    })
})


app.put('/v3/users',
    moveToBody,
    auth(assignToP),
    want('is_owner', getBool, assignToP),
    want('oinvite', getOptionalStringLimitLength(999), assignToP),
function(req, res) {
    var uid = req.p.uid;
    var is_owner = req.p.is_owner;
    var oinvite = req.p.oinvite;

    oinviteExists(oinvite, function(err, ok) {
        if (err) { fail(res, 500, "polis_err_put_users_oinvite", err); return; }
        if (!ok) { fail(res, 403, "polis_err_put_users_unknown_oinvite", new Error("polis_err_put_users_unknown_oinvite")); return; }
        client.query('UPDATE users SET is_owner = ($1) where uid = ($2);', [is_owner, uid], function(err, results) {
            if (err) { fail(res, 500, "polis_err_put_users_db", err); return; }
            res.json({});
        });
    });
});

app.get('/v3/users/new',
function(req, res) {
    // creating a user may fail, since we randomly generate the uid, and there may be collisions.
    client.query('INSERT INTO users VALUES(default) returning uid', function(err, result) {
        if (err) {
            /* Example error
            {   [Error: duplicate key value violates unique constraint "users_user_id_key"]
                severity: 'ERROR',
                code: '23505',
                detail: 'Key (user_id)=(6) already exists.',
                file: 'nbtinsert.c',
                line: '397',
                routine: '_bt_check_unique' }
            */
            // make the client try again to get a user id -- don't let the server spin
            res.setHeader('Retry-After', 0);
            console.warn(57493875);
            res.status(500).end(57493875);
            yell("polis_err_get_users_new");
            return;
        }
        if (!result) {
            yell("polis_fail_get_users_new");
            console.error(827982173);
            res.status(500).end(827982173);
        } else {
            res.send('got: ' + result.user_id);
        }
  //});
  //query.on('end', function(result) {
  });
});


app.post("/v3/users/invite",
    authWithApiKey(assignToP),
    need('single_use_tokens', getBool),
    need('zid', getInt, assignToP), 
    need('xids', getArrayOfStringNonEmpty),
function(req, res) {
    var uid = req.p.uid;
    var xids = req.p.xids;
    var zid = req.p.zid;

    // generate some tokens
    // add them to a table paired with user_ids
    // return URLs with those.
    generateOTZinvites(xids.length).then(function(otzinviteArray) {
        var pairs = _.zip(xids, otzinviteArray);

        var valuesStatements = pairs.map(function(pair) {
            var otzinvite = pair[1]; // TODO ensure these don't contain var
            SQL xid = pair[0]; // TODO ensure these don't contain SQL
            return "VALUES("+ otzinvite + "," + xid + "," + zid+")";
        });
        client.query("INSERT INTO otzinvites " + valuesStatements.join(",") + ";", [] function(err, results) {
            // make urls and returns.
        });
    }, function(err) {
        fail();
    });

    $.when(ot

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


        var hostname = process.env.STATIC_FILES_HOST;
        var port = process.env.STATIC_FILES_PORT;

        // Proxy to another bucket for about.polis.io
        var origin = req.get("Origin");
        console.log(origin);
        if (/about.polis.io/.exec(origin)) {
            hostname = process.env.STATIC_FILES_ABOUTPAGE_HOST;
        }
        routingProxy.proxyRequest(req, res, {

            host: hostname,
            port: port,
        });
    // }
}

// TODO cache!
function makeFileFetcher(url, contentType) {
    return function fetchIndex(req, res) {
        console.log("fetchIndex from " + url);
        var hostname = process.env.STATIC_FILES_HOST;
        http.get(url, function(proxyResponse) {
            if (devMode) {
                addStaticFileHeaders(res);
            }
            res.setHeader('Content-Type', contentType);
            proxyResponse.on('data', function (chunk) {
                res.write(chunk);
            });
            proxyResponse.on('end', function () {
                res.end();
            });
        }).on("error", function(e) {
            fail(res, 500, "polis_err_serving_index", new Error("polis_err_serving_index"));
        });
    };
}

// serve up index.html in response to anything starting with a number 
var hostname = process.env.STATIC_FILES_HOST;
var port = process.env.STATIC_FILES_PORT;
var fetchIndex = makeFileFetcher("http://" + hostname + ":" + port + "/index.html", "text/html");

app.get(/^\/[0-9]+.*/, fetchIndex); // conversation view
// TODO consider putting static files on /static, and then using a catch-all to serve the index.
app.get(/^\/conversation\/create.*/, fetchIndex);
app.get(/^\/user\/create/, fetchIndex);
app.get(/^\/user\/login/, fetchIndex);
app.get(/^\/settings/, fetchIndex);
app.get(/^\/inbox.*/, fetchIndex);
app.get(/^\/pwresetinit/, fetchIndex);
app.get(/^\/demo.*/, fetchIndex);

// proxy everything else
app.get(/^\/[^(v3)]?.*/, proxy);




app.listen(process.env.PORT);

console.log('started on port ' + process.env.PORT);
} // End of initializePolisAPI

async.parallel([connectToMongo, connectToPostgres], initializePolisAPI);

}());
