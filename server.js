(function() { "use strict";

// TODO security - the server needs to assert that the uid associated with the auth token matches the pid for the given conversation.

// TODO start checking auth token, test it, remove it from json data
// TODO make different logger
// TODO decide on timestamp/id/hash precision
// TODO add a conversationID
//
// TODO crap! you have to sync ALL the events, or no events.. let's just make a nice rest api and do the work on the server.
//
// TODO try mongo explain https://github.com/mongodb/node-mongodb-native/blob/master/examples/queries.js#L90


console.log('redisAuth url ' +process.env.REDISTOGO_URL);
console.log('redisCloud url ' +process.env.REDISCLOUD_URL);

//require('nodefly').profile(
    //process.env.NODEFLY_APPLICATION_KEY,
    //[process.env.APPLICATION_NAME,'Heroku']
//);

var http = require('http'),
    httpProxy = require('http-proxy'),
    express = require('express'),
    app = express(),
    squel = require('squel'),
    pg = require('pg').native, //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    bcrypt = require('bcrypt'),
    crypto = require('crypto'),
    _ = require('underscore');

app.disable('x-powered-by'); // save a whale


var domainOverride = process.env.DOMAIN_OVERRIDE || null;

function connectError(errorcode, message){
  var err = new Error(message);
  err.status = errorcode;
  return err;
}

var AUTH_FAILED = 'auth failed';
var ALLOW_ANON = true;

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

console.log(process.env.MONGOLAB_URI);

function makeSessionToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 20);
}

function getUserInfoForSessionToken(sessionToken, res, cb) {
    redisForAuth.get(sessionToken, function(errGetToken, replies) {
        if (errGetToken) { console.error("token_fetch_error"); cb(500); return; }
        if (!replies) { console.error("token_expired_or_missing"); cb(403); return; }
        cb(null, {uid: replies});
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

    db.collection('users', function(err, collectionOfUsers) {
    db.collection('events', function(err, collection) {
    db.collection('stimuli', function(err, collectionOfStimuli) {
    db.collection('pcaResults', function(err, collectionOfPcaResults) {
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


function authOr(alternativeAuth) {
    return function(req, res, next) {
        if (req.cookies.token) {
            return auth(req, res, next);
        } else {
            return alternativeAuth(req, req, next);
        }
    };
}

// input token from body or query, and populate req.body.u with userid.
function auth(req, res, next) {
    //var token = req.body.token;
    var token = req.cookies.token;
    if (!token) { next(connectError(400, "polis_err_auth_token_not_supplied")); return; }
    //if (req.body.uid) { next(400); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
    getUserInfoForSessionToken(token, res, function(err, fetchedUserInfo) {
        if (err) { next(connectError(err, "polis_err_auth_token_missing")); return;}
         // don't want to pass the token around
        if (req.body) { delete req.body.token; }
        if (req.query) { delete req.query.token; }

        if ( req.body.uid && req.body.uid !== fetchedUserInfo.uid) {
            next(connectError(400, "polis_err_auth_mismatch_uid"));
            return;
        }
        req.body = req.body || {};
        req.body.uid = fetchedUserInfo.uid;
        next();
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
    next();
}
function logPath(req, res, next) {
    console.log(req.method + " " + req.url);
    next();
}
    

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

function fail(res, code, err, httpCode) {
    console.error(code, err);
    res.writeHead(httpCode || 500);
    res.end(err);
}

function getEmail(s) {
    if (typeof s !== "string" || s.length > 999 || -1 === s.indexOf("@")) {
        throw "polis_fail_parse_email";
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
                    next(connectError(400, "polis_err_param_parse_failed" + " " + name));
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
                next(connectError(400, "polis_err_param_missing" + " " + name));
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


function whereOptional(squelQuery, P, name, nameOfSqlColumnName) {
    if ("undefined" === typeof nameOfSqlColumnName) {
        // assume same name if not provided
        nameOfSqlColumnName = name;
    }
    if (P.hasOwnProperty(name)) {
        squelQuery = squelQuery.where(nameOfSqlColumnName + ' = ?', P[name]);
    }
    return squelQuery;
}
function setOptional(squelQuery, P, name, nameOfSqlColumnName) {
    if ("undefined" === typeof nameOfSqlColumnName) {
        // assume same name if not provided
        nameOfSqlColumnName = name;
    }
    if (P.hasOwnProperty(name)) {
        squelQuery = squelQuery.set(nameOfSqlColumnName, P[name]);
    }
    return squelQuery;
}

var oneYear = 1000*60*60*24*365;
function addCookie(res, token) {
    var o = {
    };
    if (domainOverride) { 
        // set nothing - Assuming localhost
    } else {
        o.domain = 'polis.io';
        o.path = '/';
        o.httpOnly = true;
        o.maxAge = oneYear;
     //   o.secure = true; // TODO need HTTPS
    }

    res.cookie('token', token, o);
}


function initializePolisAPI(err, args) {
var mongoParams = args[0];
var postgresParams = args[1];

if (err) {
    console.error("failed to init db connections");
    console.error(err);
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

function votesPost(res, pid, zid, tid, voteType) {
    var query = "INSERT INTO votes (pid, zid, tid, vote, created) VALUES ($1, $2, $3, $4, default);";
    var params = [pid, zid, tid, voteType];
    console.log(query, params);
    client.query(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 57493886, "polis_err_vote_duplicate", 406); // TODO allow for changing votes?
            } else {
                fail(res, 324234324, "polis_err_vote", 500);
            }
            return;
        }
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
}

function votesGet(res, p) {
    var q = squel.select()
        .from("votes")
        .where("zid = ?", p.zid);
    if (!_.isUndefined(p.pid)) {
        q = q.where("pid = ?", p.pid);
    }
    if (!_.isUndefined(p.tid)) {
        q = q.where("tid = ?", p.tid);
    }
    client.query(q.toString(), [], function(err, docs) {
        if (err) { fail(res, 234234326, err); return; }
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

app.use(writeDefaultHead);
app.use(express.logger());
app.use(express.cookieParser());
app.use(express.bodyParser());

var whitelistedDomains = [
  "http://beta7816238476123.polis.io",
  "https://beta7816238476123.polis.io",  
  "http://www.polis.io",
  "https://www.polis.io",  
  "http://polis.io",
  "https://polis.io",
];

app.all("/v3/*", function(req, res, next) {
 
  var host;
  if (domainOverride) {
      host = req.protocol + "://" + domainOverride;
  } else {
      host =  req.get("Origin");
  }
  console.log(host);
  if (!domainOverride && -1 === whitelistedDomains.indexOf(host)) {
      console.log('not whitelisted');
      return next(); // don't supply the CORS headers, domain is not whitelisted.
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
    logPath,
    moveToBody,
    need('zid', getInt, assignToP),
    want('lastVoteTimestamp', getInt, assignToP, 0),
    function(req, res) {
        collectionOfPcaResults.find({$and :[
            {zid: req.p.zid},
            {lastVoteTimestamp: {$gt: new Date(req.p.lastVoteTimestamp).getTime()}},
            ]}, function(err, cursor) {
            if (err) { fail(res, 2394622, "polis_err_get_pca_results_find", 500); return; }
            cursor.toArray( function(err, docs) {
                if (err) { fail(res, 2389364, "polis_err_get_pca_results_toarray", 500); return; }
                if (docs.length) {
                    res.json(docs[0]);
                } else {
                    // Could actually be a 404, would require more work to determine that.
                    res.status(304).end();
                }
            });
        });

                /*
        redisCloud.get("pca:timestamp:" + stimulus, function(errGetToken, replies) {
            if (errGetToken) {
                fail(res, 287472365, errGetToken, 404);
                return;
            }
            var timestampOfLatestMath = replies;
            if (timestampOfLatestMath <= lastServerToken) {
                res.end(204); // No Content
                // log?
                return;
            }
            // OK, looks like some newer math results are available, let's fetch those.
            redisCloud.get("pca:" + stimulus, function(errGetToken, replies) {
                if (errGetToken) {
                    fail(res, 287472364, errGetToken);
                    return;
                }
                res.json({
                    lastServerToken: lastServerToken,
                    pca: replies,
                });
            });
        });
        */
    });

app.post("/v3/auth/deregister",
    logPath,
    auth,
function(req, res) {
    var data = req.body;
    endSession(data, function(err, data) {
        if (err) { fail(res, 213489289, "couldn't end session"); return; }
        res.end();
    });
});


app.get("/v3/zinvites/:zid",
    logPath,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
function(req, res) {
    // if uid is not conversation owner, fail
    client.query('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) {
            fail(res, 213489295, "polis_err_fetching_zinvite_invalid_conversation_or_owner");
            return;
        }
        if (!results || !results.rows) {
            res.writeHead(404);
            res.json({status: 404});
            return;
        }
        client.query('SELECT * FROM zinvites WHERE zid = ($1);', [req.p.zid], function(err, results) {
            if (err) {
                fail(res, 213489297, "polis_err_fetching_zinvite_invalid_conversation_or_owner_or_something");
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

function createZinvite(zid, callback) {
    // TODO store up a buffer of random bytes sampled at random times to reduce predictability. (or see if crypto module does this for us)
    // TODO if you want more readable tokens, see ReadableIds 
    require('crypto').randomBytes(12, function(err, buf) {
        if (err) {
            return callback("polis_err_creating_zinvite_invalid_conversation_or_owner");
        }

        var zinvite = buf.toString('base64')
            .replace(/\//g,'A').replace(/\+/g,'B'); // replace url-unsafe tokens (ends up not being a proper encoding since it maps onto A and B. Don't want to use any punctuation.)

        client.query('INSERT INTO zinvites (zid, zinvite, created) VALUES ($1, $2, default);', [zid, zinvite], function(err, results) {
            if (err) {
                return callback("polis_err_creating_zinvite");
            }
            return callback(0, zinvite);
        });
    });  
}

app.post("/v3/zinvites/:zid",
    logPath,
    auth,
    moveToBody,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
function(req, res) {
    client.query('SELECT * FROM conversations WHERE zid = ($1) AND owner = ($2);', [req.p.zid, req.p.uid], function(err, results) {
        if (err) { fail(res, 213489299, "polis_err_creating_zinvite_invalid_conversation_or_owner"); return; }

        createZinvite(req.p.zid, function(err, zinvite) {
            if (err) { fail(res, 213489302, err); return; }
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

    var q = squel.select()
        .from("participant_metadata_answers")
        .where("zid = ?", zid)
        .where("pmaid IN ("+ answers.join(",") +")");

    client.query(q.toString(), function(err, qa_results) {
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
                // squel.insert()
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
        if (err) {
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
        console.log('isConversationOwner: ' + err);
        console.log(zid, uid);
        console.dir(docs);
        console.dir(err);
        callback(err);
    });
}

function getPid(zid, uid, callback) {
    client.query("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, docs) {
        var pid;
        if (docs.rows.length == 0) {
            err = err || 1;
        } else {
            pid = docs && docs.rows && docs.rows[0] && docs.rows[0].pid;
        }
        callback(err, pid);
    });
}

function getAnswersForConversation(zid, callback) {
    client.query("SELECT * from participant_metadata_answers WHERE zid = ($1) AND alive=TRUE;", [zid], function(err, x) {
        if (err) { callback(1); return;}
        callback(0, x.rows);
    });
}

app.get("/v3/participants",
    logPath,
    auth,
    moveToBody,
    need('pid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP), // requester
function(req, res) {
    var pid = req.p.pid;
    var uid = req.p.uid;
    var zid = req.p.zid;

    function fetchInfo() {
        client.query("SELECT * FROM users WHERE uid IN (SELECT uid FROM participants WHERE pid = ($1) AND zid = ($2));", [pid, zid], function(err, result) {
            if (err || !result || !result.rows || !result.rows.length) { fail(res, 213489303, "polis_err_fetching_participant_info"); return; }
            var ptpt = result.rows[0];
            var data = {};
            // choose which fields to expose
            data.hname = ptpt.hname;

            res.status(200).json(data);
        });
    }
    client.query("SELECT is_anon FROM conversations WHERE zid = ($1);", [zid], function(err, result) {
        if (err || !result || !result.rows || !result.rows.length) { fail(res, 213489304, "polis_err_fetching_participant_info"); return; }
        if (result.rows[0].is_anon) {
            res.status(403).json({status: "polis_err_fetching_participant_info_conversation_is_anon"});
            return;
        }
        fetchInfo();
    });
});


function userHasAnsweredZeQuestions(zid, answers, callback) {
    getAnswersForConversation(zid, function(err, available_answers) {
        if (err) { callback(err); return;}

        console.dir(available_answers);
        var q2a = _.indexBy(available_answers, 'pmqid');
        var a2q = _.indexBy(available_answers, 'pmaid');
        console.dir(q2a);
        console.dir(a2q);
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
    logPath,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
    want('zinvite', _.identity, assignToP),
    want('answers', _.identity, assignToP, []), // {pmqid: [pmaid, pmaid], ...} where the pmaids are checked choices
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var zinvite = req.p.zinvite;
    var answers = req.p.answers;

console.dir(answers);
    function finish(pid) {
        res.status(200).json({
            pid: pid,
        });
    }

    // Check if already in the conversation
    getPid(zid, req.p.uid, function(err, pid) {
        if (err) {

            userHasAnsweredZeQuestions(zid, answers, function(err) {
                if (err) { fail(res, 213489277, err); return; }
                // need to join
                getConversationProperty(zid, "is_public", function(err, is_public) {
                    if (err) { fail(res, 213489296, "polis_err_add_participant_property_missing"); return; }
                    function doJoin() {
                        joinConversation(zid, uid, answers, function(err, pid) {
                            if (err) { fail(res, 213489292, "polis_err_add_participant"); return; }
                            finish(pid);
                        });
                    }
                    if (is_public) {
                        doJoin();
                    } else {
                        checkZinviteCodeValidity(zid, zinvite, function(err) {
                            if (err) {
                                res.status(403).end("polis_err_add_participant_bad_zinvide_code");
                            } else {
                                doJoin();
                            }
                        });
                    }
                }); // end get is_public
            }); // end userHasAnsweredZeQuestions
        } else {
            finish(pid);
        }
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
    logPath,
    need('email', getEmail, assignToP),
    want('name', getOptionalStringLimitLength(999), assignToP),
    want('organization', getOptionalStringLimitLength(999), assignToP),
    function(req,res){

        var email = req.p.email;
        var name = req.p.name;
        var organization = req.p.organization;

        client.query("INSERT INTO beta (email, name, organization) VALUES ($1, $2, $3);", [email, name, organization], function(err, result) {
            if (err) { 
                console.log(email, name, organization);
                fail(res, 238943628, "polis_err_beta_registration", 403);
                return;
            }
            res.status(200).json({});
        });
});


app.post("/v3/auth/login",
    logPath,
    need('password', _.identity, assignToP),
    want('username', _.identity, assignToP),
    want('email', _.identity, assignToP),
function(req, res) {
    var password = req.p.password;
    var username = req.p.username;
    var email = req.p.email;
    var handles = [];
    if (username) { handles.push({username: username}); }
    if (email) { handles.push({email: email}); }
    if (!_.isString(password)) { fail(res, 238943622, "polis_err_login_need_password", 403); return; }
    client.query("SELECT * FROM users WHERE username = ($1) OR email = ($2);", [username, email], function(err, docs) {
        docs = docs.rows;
        if (err) { fail(res, 238943624, "polis_err_login_unknown_user_or_password", 403); return; }
        if (!docs || docs.length === 0) { fail(res, 238943625, "polis_err_login_unknown_user_or_password", 403); return; }
        var hashedPassword  = docs[0].pwhash;
        var userID = docs[0].uid;

        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
            if (errCompare || !result) { fail(res, 238943623, "polis_err_login_unknown_user_or_password", 403); return; }
            
            startSession(userID, function(errSess, token) {
                var response_data = {
                    username: username,
                    uid: userID,
                    email: email,
                    token: token
                };
                addCookie(res, token);
                res.json(response_data);
            }); // startSession
        }); // compare
    }); // query
}); // /v3/auth/login

app.post("/v3/auth/new",
    logPath,
    want('anon', getBool, assignToP),
    want('username', _.identity, assignToP),
    want('password', _.identity, assignToP),
    want('email', _.identity, assignToP),
    want('hname', _.identity, assignToP),
function(req, res) {
    var username = req.p.username;
    var password = req.p.password;
    var email = req.p.email;
    var zid = req.p.zid;


    if (ALLOW_ANON && req.p.anon) {
        client.query("INSERT INTO users (uid, created) VALUES (default, default) RETURNING uid;", [], function(err, result) {
            if (err) {
                if (isDuplicateKey(err)) {
                    console.error(57493882);
                    failWithRetryRequest(res);
                } else {
                    fail(res, 57493883, "polis_err_add_user", 500);
                }
                return;
            }

            console.log('baba');
            console.dir(result);
            var uid = result && result.rows && result.rows[0] && result.rows[0].uid;
            startSession(uid, function(errSessionStart,token) {
                if (errSessionStart) { fail(res, 238943597, "polis_err_reg_failed_to_start_session_anon"); return; }
                //var response = result.rows && result.rows[0]
                function finish(pid) {
                    var o = {
                        uid: uid,
                        token: token
                    };
                    if (pid) {
                        o.pid = pid;
                    }
                    addCookie(res, token);
                    res.status(200).json(o);
                }
                if (zid) {
                    joinConversation(zid, uid, [], function(err, pid) {
                        if (err) { fail(res, 5748941, "polis_err_joining_conversation_anon"); return; }
                        finish(pid);
                    });
                } else {
                    finish();
                }
            });
        });
        return;
    }
    // not anon
    if (!email && !username) { fail(res, 5748932, "polis_err_reg_need_username_or_email"); return; }
    if (!password) { fail(res, 5748933, "polis_err_reg_password"); return; }
    if (password.length < 6) { fail(res, 5748933, "polis_err_reg_password_too_short"); return; }
    if (!_.contains(email, "@") || email.length < 3) { fail(res, 5748934, "polis_err_reg_bad_email"); return; }

    client.query("SELECT * FROM users WHERE username = ($1) OR email = ($2)", [username, email], function(err, docs) {
        if (err) { fail(res, 5748936, "polis_err_reg_checking_existing_users"); return; }
            if (err) { console.error(err); fail(res, 5748935, "polis_err_reg_checking_existing_users"); return; }
            if (docs.length > 0) { fail(res, 5748934, "polis_err_reg_user_exists", 403); return; }

            bcrypt.genSalt(12, function(errSalt, salt) {
                if (errSalt) { fail(res, 238943585, "polis_err_reg_123"); return; }

                bcrypt.hash(password, salt, function(errHash, hashedPassword) {
                    delete req.p.password;
                    password = null;
                    if (errHash) { fail(res, 238943594, "polis_err_reg_124"); return; }
                    client.query("INSERT INTO users (uid, username, email, pwhash, created) VALUES (default, $1, $2, $3, default) RETURNING uid;", [username, email, hashedPassword], function(err, result) {
                        if (err) { fail(res, 238943599, "polis_err_reg_failed_to_add_user_record"); return; }
                        var uid = result && result.rows && result.rows[0] && result.rows[0].uid;
                        startSession(uid, function(errSessionStart,token) {
                            if (errSessionStart) { fail(res, 238943600, "polis_err_reg_failed_to_start_session"); return; }
                            addCookie(res, token);
                            res.json({
                                uid: uid,
                                username: username,
                                email: email,
                                token: token
                            });
                        }); // end startSession
                    }); // end insert user
                }); // end hash
            }); // end gensalt
    }); // end find existing users
}); // end /v3/auth/new


app.post("/v2/feedback",
    auth,
    function(req, res) {
                var data = req.body;
                    data.events.forEach(function(ev){
                        if (!ev.feedback) { fail(res, 'expected feedback field'); return; }
                        if (data.uid) { ev.uid = ObjectId(data.uid); }
                        checkFields(ev);
                        collection.insert(ev, function(err, cursor) {
                            if (err) { fail(res, 324234332, err); return; }
                            res.end();
                        }); // insert
                    }); // each 
    });

app.get("/v3/comments",
    logPath,
    moveToBody,
    auth,
    need('zid', getInt, assignToP),
    want('not_pid', getInt, assignToP),
    want('not_voted_by_pid', getInt, assignToP),
//    need('lastServerToken', _.identity, assignToP),
function(req, res) {

    function handleResult(err, docs) {
        console.dir(docs);
        if (err) { fail(res, 234234332, err); return; }
        if (docs.rows && docs.rows.length) {
            res.json(
                docs.rows.map(function(row) { return _.pick(row, ["txt", "tid", "created"]); })
            );
        } else {
            res.json([]);
        }
    }

    var query = squel.select().from('comments');
    query = query.where("zid = ?", req.p.zid);
    if (!_.isUndefined(req.p.not_pid)) {
        query = query.where("pid != ?", req.p.not_pid);
    }
    if (!_.isUndefined(req.p.not_voted_by_pid)) {
        // 'SELECT * FROM comments WHERE zid = 12 AND tid NOT IN (SELECT tid FROM votes WHERE pid = 1);'
        // Don't return comments the user has already voted on.
        query = query.where( "tid NOT IN (SELECT tid FROM votes WHERE zid = ? AND pid = ?)", req.p.zid, req.p.not_voted_by_pid);
    }
    query = query.order('created', true);
    query = query.limit(999); // TODO paginate

    //if (_.isNumber(req.p.not_pid)) {
        //query += " AND pid != ($"+ (i++) + ")";
        //parameters.unshift(req.p.not_pid);
    //}
    //
    //client.query("SELECT * FROM comments WHERE zid = ($1) AND created > (SELECT to_timestamp($2));", [zid, lastServerToken], handleResult);
    client.query(query.toString(), [], handleResult);
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
    logPath,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
    need('txt', _.identity, assignToP),
function(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
        if (err) { console.dir(err); fail(res, 324234336, "polis_err_getting_pid"); return; }
        console.log(pid);
        console.log(req.p.uid);
        client.query(
            "INSERT INTO COMMENTS (tid, pid, zid, txt, created) VALUES (null, $1, $2, $3, default) RETURNING tid;",
            [pid, req.p.zid, req.p.txt],
            function(err, docs) {
                if (err) { console.dir(err); fail(res, 324234331, "polis_err_post_comment"); return; }
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
            //if (err) { console.dir(err); fail(res, 324234331, "polis_err_post_comment"); return; }
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
                        //if (err) { console.dir(err); fail(res, 324234331, "polis_err_post_comment"); return; }
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
    logPath,
    moveToBody,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
function(req, res) {
    getPid(req.p.zid, req.p.uid, function(err, pid) {
        client.query("SELECT * FROM votes WHERE zid = ($1) AND pid = ($2);", [req.p.zid, req.p.pid], function(err, docs) {
            if (err) { fail(res, 234234325, err); return; }
            res.json({
                votes: docs.rows,
            });
        });
    });
});

// TODO Since we know what is selected, we also know what is not selected. So server can compute the ratio of support for a comment inside and outside the selection, and if the ratio is higher inside, rank those higher.
app.get("/v3/selection",
    logPath,
    moveToBody,
    need('users', _.identity, assignToP),
    need('zid', getInt, assignToP),
function(req, res) {
        var zid = req.p.zid;
        var users = req.p.users;
        if (_.isUndefined(users)) { 
            res.json([]);
            return;
        }
        var usersListOk = /^([0-9]+,)?[0-9]$/;
        if (!usersListOk.test(users)) {
            if (err) { fail(res, 2389373, "polis_err_get_selection_users_list_formatting", 400); return; }
        }
        
        var query = squel.select()
            .from("votes")
            .where("zid = ?", zid)
            .where("vote = 1 OR vote = -1")
            .where("pid IN (" + users + ")");

        client.query(query.toString(), [], function(err, results) {
            console.log('votes query');
            if (err) { fail(res, 2389369, "polis_err_get_selection", 500); console.dir(results); return; }
            var votes = results.rows;
            var commentIdCounts = {};
            for (var i = 0; i < votes.length; i++) {
                var vote = votes[i];
                var count = commentIdCounts[vote.tid];
                if (vote.vote === polisTypes.reactions.pull) {
                    commentIdCounts[vote.tid] = count + 1 || 1;
                } else if (vote.vote === polisTypes.reactions.push) {
                    // push
                    commentIdCounts[vote.tid] = count - 1 || -1;
                } else {
                    console.error("expected just push and pull in query");
                }
            }
            commentIdCounts = _.pairs(commentIdCounts);
            commentIdCounts = commentIdCounts.filter(function(c) { return Number(c[1]) > 0; }); // remove net negative items
            commentIdCounts.forEach(function(c) { c[0].txt += c[1]; }); // remove net negative items ????
            commentIdCounts.sort(function(a,b) {
                return b[1] - a[1]; // descending by freq
            });
            commentIdCounts = commentIdCounts.slice(0, 10);
            var commentIdsOrdering = commentIdCounts.map(function(x) { return {tid: x[0]};});
            var commentIds = commentIdCounts.map(function(x) { return x[0];});
            var queryForSelectedComments = squel.select()
                .from("comments")
                .where("zid = ?", zid)
                .where("tid IN (" + commentIds.join(",") + ")");
            client.query(queryForSelectedComments.toString(), [], function(err, results) {
                console.log('comments query');
                if (err) { fail(res, 2389366, "polis_err_get_selection_comments", 500); console.dir(err); return; }
                var comments = results.rows;
                // map the results onto the commentIds list, which has the right ordering
                comments = orderLike(comments, commentIdsOrdering, "tid"); // TODO fix and test the extra declaration of comments
                for (var i = 0; i < comments.length; i++) {
                    comments[i].freq = i;
                }

                comments.sort(function(a, b) {
                    // desc sort primarily on frequency, then on recency
                    if (b.freq > a.freq) {
                        return 1;
                    } else if (b.freq < a.freq) {
                        return -1;
                    } else {
                        return b.created > a.created;
                    }
                });
                res.json(comments);
            }); // end comments query
        }); // end votes query
    }); // end GET selection

app.get("/v3/votes",
    logPath,
    moveToBody,
    need('zid', getInt, assignToP),
    want('pid', getInt, assignToP),
    want('tid', getInt, assignToP),
function(req, res) {
    votesGet(res, req.p);
});

app.post("/v3/votes",
    logPath,
    auth,
    need('tid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('pid', getInt, assignToP),
    need('vote', getIntInRange(-1, 1), assignToP),
function(req, res) {
        votesPost(res, req.p.pid, req.p.zid, req.p.tid, req.p.vote);
});

app.post("/v3/stars",
    logPath,
    auth,
    need('tid', getInt, assignToP),
    need('zid', getInt, assignToP),
    need('pid', getInt, assignToP),
    need('starred', getIntInRange(0,1), assignToP),
function(req, res) {
    var query = "INSERT INTO stars (pid, zid, tid, starred, created) VALUES ($1, $2, $3, $4, default);";
    var params = [req.p.pid, req.p.zid, req.p.tid, req.p.starred];
    client.query(query, params, function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                fail(res, 57493890, "polis_err_vote_duplicate", 406); // TODO allow for changing votes?
            } else {
                fail(res, 324234324, "polis_err_vote", 500);
            }
            return;
        }
        res.status(200).json({});  // TODO don't stop after the first one, map the inserts to deferreds.
    });
});

app.put('/v3/conversations/:zid',
    logPath,
    moveToBody,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
    want('is_active', getBool, assignToP),
    want('is_anon', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('is_public', getBool, assignToP),
    want('topic', _.identity, assignToP),
    want('description', _.identity, assignToP),
function(req, res){
    var query = squel.update().table('conversations');
    query = query.where("zid = ?", req.p.zid);
    query = query.where("owner = ?", req.p.uid);
    query = setOptional(query, req.p, 'is_active');
    query = setOptional(query, req.p, 'is_anon');
    query = setOptional(query, req.p, 'is_draft');
    query = setOptional(query, req.p, 'is_public');
    query = setOptional(query, req.p, 'topic');
    query = setOptional(query, req.p, 'description');
    client.query(
        query.toString(),
        function(err, result){
            if (err) {
                fail(res, 435673243, "polis_err_update_conversation", 500);
                return;
            }
            res.status(200).json({});
        }
    );
});

app.delete('/v3/metadata/questions/:pmqid',
    logPath,
    auth,
    moveToBody,
    need('uid', getInt, assignToP),
    need('pmqid', getInt, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var pmqid = req.p.pmqid;

    getZidForQuestion(pmqid, function(err, zid) {
        if (err) { fail(res, 45434534, "polis_err_delete_participant_metadata_questions_zid", 500); return; }
        isConversationOwner(zid, uid, function(err) {
            if (err) { fail(res, 34534565, "polis_err_delete_participant_metadata_questions_auth", 403); return; }

            deleteMetadataQuestionAndAnswers(pmqid, function(err) {
                if (err) { fail(res, 324234, "polis_err_delete_participant_metadata_questions_"+err, 500); return; }
                console.log('ok');
                res.status(200)
            });
        });
    });
});

app.delete('/v3/metadata/answers/:pmaid',
    logPath,
    auth,
    moveToBody,
    need('uid', getInt, assignToP),
    need('pmaid', getInt, assignToP),
function(req, res) {
    var uid = req.p.uid;
    var pmaid = req.p.pmaid;

    getZidForAnswer(pmaid, function(err, zid) {
        if (err) { fail(res, 3345345, "polis_err_delete_participant_metadata_answers_zid", 500); return; }
        isConversationOwner(zid, uid, function(err) {
            if (err) { fail(res, 34534565, "polis_err_delete_participant_metadata_answers_auth", 403); return; }

            deleteMetadataAnswer(pmaid, function(err) {
                if (err) { fail(res, 324234, "polis_err_delete_participant_metadata_answers_"+err, 500); return; }
                console.log('ok');
                res.send(200);
            });
        });
    });
});

function getZidForAnswer(pmaid, callback) {
    client.query("SELECT zid FROM participant_metadata_answers WHERE pmaid = ($1);", [pmaid], function(err, result) {
        console.dir(arguments);
        if (err) { console.dir(err); callback(err); return;}
        if (!result.rows || !result.rows.length) {
            console.log('no result');
            console.dir(result);
            callback(1);
            return;
        }
        callback(null, result.rows[0].zid);
    });
}

function getZidForQuestion(pmqid, callback) {
    client.query("SELECT zid FROM participant_metadata_questions WHERE pmqid = ($1);", [pmqid], function(err, result) {
        console.dir(arguments);
        if (err) {console.dir(err);  callback(err); return;}
        if (!result.rows || !result.rows.length) {
                        console.log('no result');
            console.dir(result);
            callback(1);
            return;
        }
        callback(null, result.rows[0].zid);
    });
}

function deleteMetadataAnswer(pmaid, callback) {
    // client.query("update participant_metadata_choices set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
    //     if (err) {callback(34534545); return;}
        client.query("update participant_metadata_answers set alive = FALSE where pmaid = ($1);", [pmaid], function(err) {
            if (err) {callback(23424234); return;}
            callback(null);
        });           
     // });
}

function deleteMetadataQuestionAndAnswers(pmqid, callback) {
    // client.query("update participant_metadata_choices set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
    //     if (err) {callback(93847834); return;}
        client.query("update participant_metadata_answers set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
            if (err) {callback(92374827); return;}
            client.query("update participant_metadata_questions set alive = FALSE where pmqid = ($1);", [pmqid], function(err) {
                if (err) {callback(29386827); return;}
                callback(null);
            });
        });           
     // });
}

app.get('/v3/metadata/questions',
    logPath,
    moveToBody,
    authOr(need('zinvite', _.identity, assignToP)),
    need('zid', getInt, assignToP),
    want('uid', getInt, assignToP),
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
        if (err) { fail(res, 2394631, "polis_err_get_participant_metadata_auth", 403); return; }

        async.parallel([
            function(callback) { client.query("SELECT * FROM participant_metadata_questions WHERE alive = true AND zid = ($1);", [zid], callback) },
            //function(callback) { client.query("SELECT * FROM participant_metadata_answers WHERE alive = true AND zid = ($1);", [zid], callback) },
            //function(callback) { client.query("SELECT * FROM participant_metadata_choices WHERE alive = true AND zid = ($1);", [zid], callback) },
        ], function(err, result) {
            if (err) { fail(res, 2394629, "polis_err_get_participant_metadata_questions", 500); return; }
            var keys = result[0] && result[0].rows;
            res.status(200).json(keys);
        });
    }
});

app.post('/v3/metadata/questions',
    logPath,
    moveToBody,
    auth,
    need('key', _.identity, assignToP),
    need('zid', getInt, assignToP),
    want('uid', getInt, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var key = req.p.key;
    var uid = req.p.uid;
  
    isConversationOwner(zid, uid, doneChecking);
    function doneChecking(err, foo) {
        if (err) { fail(res, 2394632, "polis_err_post_participant_metadata_auth", 403); return; }
        client.query("INSERT INTO participant_metadata_questions (pmqid, zid, key) VALUES (default, $1, $2)", [
            zid,
            key,
            ], function(err, results) {
            if (err) { fail(res, 2394630, "polis_err_post_participant_metadata_key", 500); console.dir(err); return; }
            res.status(200).json({});
        });
    }
});
    
app.post('/v3/metadata/answers',
    logPath,
    moveToBody,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
    need('pmqid', getInt, assignToP),
    need('value', _.identity, assignToP),
function(req, res) {
    var zid = req.p.zid;
    var uid = req.p.uid;
    var pmqid = req.p.pmqid;
    var value = req.p.value;

    isConversationOwner(zid, uid, doneChecking);
    function doneChecking(err, foo) {
        if (err) { fail(res, 2394635, "polis_err_post_participant_metadata_auth", 403); return; }
        client.query("INSERT INTO participant_metadata_answers (pmqid, zid, value) VALUES ($1, $2, $3)", [
            pmqid,
            zid,
            value,
            ], function(err, results) {
            if (err) { fail(res, 2394638, "polis_err_post_participant_metadata_value", 500); console.dir(err); return; }
            res.status(200).json({});
        });
    }
});

app.get('/v3/metadata/answers',
    logPath,
    moveToBody,
    authOr(want('zinvite', _.identity, assignToP)),
    need('zid', getInt, assignToP),
    want('uid', getInt, assignToP),
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
        if (err) { fail(res, 2394631, "polis_err_get_participant_metadata_auth", 403); return; }
        var query = squel.select().from('participant_metadata_answers');


        query = query.where("zid = ?", zid);
        query = query.where("alive = true");
        if (pmqid) {
            query = query.where("pmqid = ?", pmqid);
        }
        client.query(query.toString(), [], function(err, result) {
            if (err) { fail(res, 2394629, "polis_err_get_participant_metadata_answers", 500); console.dir(err); return; }
            res.status(200).json(result.rows);
        });
    }
});

app.get('/v3/metadata',
    logPath,
    moveToBody,
    auth,
    need('zid', getInt, assignToP),
    need('uid', getInt, assignToP),
    want('zinvite', _.identity, assignToP),
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
        if (err) { fail(res, 2394631, "polis_err_get_participant_metadata_auth", 403); return; }
        async.parallel([
            function(callback) { client.query("SELECT * FROM participant_metadata_questions WHERE zid = ($1);", [zid], callback) },
            function(callback) { client.query("SELECT * FROM participant_metadata_answers WHERE zid = ($1);", [zid], callback) },
            function(callback) { client.query("SELECT * FROM participant_metadata_choices WHERE zid = ($1);", [zid], callback) },
        ], function(err, result) {
            if (err) { fail(res, 2394629, "polis_err_get_participant_metadata", 500); return; }
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
    logPath,
    moveToBody,
    auth,
    want('oid', getInt, assignToP),
    need('uid', getInt, assignToP),
    need('metaname', getInt, assignToP),
    need('metavalue', getInt, assignToP),
function(req, res) {
});

app.get('/v3/conversations/:zid',
    logPath,
    moveToBody,
    auth,
    want('zid', getInt, assignToP),
function(req, res) {
    client.query('SELECT * FROM conversations WHERE zid = ($1);', [req.p.zid], function(err, results) {
        if (err) { console.dir(err); fail(res, 324234342, "polis_err_get_conversation_by_zid", 500); return; }
        if (!results || !results.rows || !results.rows.length) {
            res.writeHead(404);
            res.json({status: 404});
        } else {
            res.status(200).json(results.rows[0]);
        }
    });
});


app.get('/v3/conversations',
    logPath,
    moveToBody,
    auth,
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('zid', getInt, assignToP),
    want('owner', getInt, assignToP), // TODO needed?
    need('uid', getInt, assignToP),
function(req, res) {

  // First fetch a list of conversations that the user is a participant in.
  client.query('select zid from participants where uid = ($1);', [req.p.uid], function(err, results) {
    if (err) { console.dir(err); fail(res, 324234338, "polis_err_get_conversations_participated_in", 500); return; }

    var participantIn = results && results.rows && _.pluck(results.rows, "zid") || null;

    var query = squel.select().from('conversations');
    var or_clauses = ["owner = " + req.p.uid];
    if (participantIn.length) {
        or_clauses.push("zid IN (" + participantIn.join(",") + ")");
    }
    query = query.where("("+ or_clauses.join(" OR ") + ")");
    query = whereOptional(query, req.p, 'is_active');
    query = whereOptional(query, req.p, 'is_draft');
    query = whereOptional(query, req.p, 'zid');
    //query = whereOptional(query, req.p, 'owner');
    query = query.order('created', true);
    query = query.limit(999); // TODO paginate

    console.log(query.toString());
    client.query(query.toString(), [], function(err, result) {
        if (err) { console.dir(err); fail(res, 324234339, "polis_err_get_conversations", 500); return; }
        var data = result.rows || [];

        // fetch invites
        function fetchZinvites(conv) {
            return function(callback) {
                if (conv.is_public) {
                    console.log('public');
                    console.dir(conv);
                    return callback(null);
                }
                isConversationOwner(conv.zid, req.p.uid, function(err) {
                    if (err) {
                        console.log('not owner, nothing to do');
                        return callback(null);
                    }

                    client.query("SELECT * FROM zinvites WHERE zid = ($1);", [conv.zid], function(err, zinviteResults) {
                        if (err) { console.dir(err); fail(res, 324234340, "polis_err_get_conversation_zinvites", 500); return callback(1); }
                        if (!zinviteResults.rows || !zinviteResults.rows.length) {
                            zinviteResults.rows = [];
                        }

                        console.log('zinvites');
                        console.dir(zinviteResults);
                        console.dir(data);
                        conv.zinvites = _.pluck(zinviteResults.rows, "zinvite");;
                        callback(null);
                    });
                });
            };
        }

        async.parallel(result.rows.map(fetchZinvites), function(err) {
            if (err) { console.dir(err); fail(res, 324234341, "polis_err_get_conversation_zinvites", 500); return; }
            res.json(data);
        });

    });
  });
});

// TODO check to see if ptpt has answered necessary metadata questions.
app.post('/v3/conversations/undefined', // TODO undefined is not ok
    logPath,
    auth,
    want('is_active', getBool, assignToP),
    want('is_draft', getBool, assignToP),
    want('is_public', getBool, assignToP, false),
    want('is_anon', getBool, assignToP, false),
    want('topic', _.identity, assignToP, ""),
    want('description', _.identity, assignToP, ""),
    need('uid', getInt, assignToP),
function(req, res) {
    client.query(
'INSERT INTO conversations (zid, owner, created, topic, description, participant_count, is_active, is_draft, is_public, is_anon)  VALUES(default, $1, default, $2, $3, default, $4, $5, $6, $7) RETURNING zid;',
[req.p.uid, req.p.topic, req.p.description, req.p.is_active, req.p.is_draft, req.p.is_public, req.p.is_anon], function(err, result) {
        if (err) {
            if (isDuplicateKey(err)) {
                console.error(57493879);
                failWithRetryRequest(res);
            } else {
                fail(res, 324234335, "polis_err_add_conversation", 500);
            }
            return;
        }

        var zid = result && result.rows && result.rows[0] && result.rows[0].zid;
        function finish() {
            res.status(200).json({
                zid: zid,
            });
        }
        if (!req.p.is_public) {
            createZinvite(zid, function(err, zinvite) {
                if (err) { console.dir(err); fail(res, 324234339, err, 500); return; }
                finish();
            });
        } else {
            finish();
        }
    });
});

/*
app.get('/v3/users',
logPath,
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




function staticFile(req, res) {
    // try to serve a static file
    var requestPath = req.url;
    var contentPath = './src';

    // polis.io/2fdsi style URLs. The JS will interpret the path as stimulusId=2fdsi
    if (/^\/[0-9]/.exec(requestPath) || requestPath === '/') {
        contentPath += '/desktop/index.html';
    } else if (requestPath.indexOf('/static/') === 0) {
        contentPath += requestPath.slice(7);
    }

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
     
    console.log("PATH " + contentPath);
    fs.exists(contentPath, function(exists) {
        if (exists) {
            fs.readFile(contentPath, function(error, content) {
                if (error) {
                    res.writeHead(404);
                    res.json({status: 404});
                }
                else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content, 'utf-8');
                }
            });
        } else {
            res.writeHead(404);
            res.json({status: 404});
        }
    });
}

app.get('/v3/users/new',
logPath,
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
            return;
        }
        if (!result) {
            console.error(827982173);
            res.status(500).end(827982173);
        } else {
            res.send('got: ' + result.user_id);
        }
  //});
  //query.on('end', function(result) {
  });
});



function staticFile(req, res) {
    // try to serve a static file
    var requestPath = req.url;
    var contentPath = './src';

    // polis.io/2fdsi style URLs. The JS will interpret the path as stimulusId=2fdsi
    if (/^\/[0-9]/.exec(requestPath) || requestPath === '/') {
        contentPath += '/desktop/index.html';
    } else if (requestPath.indexOf('/static/') === 0) {
        contentPath += requestPath.slice(7);
    }

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
     
    console.log("PATH " + contentPath);
    fs.exists(contentPath, function(exists) {
        if (exists) {
            fs.readFile(contentPath, function(error, content) {
                if (error) {
                    res.writeHead(404);
                    res.json({status: 404});
                }
                else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content, 'utf-8');
                }
            });
        } else {
            res.writeHead(404);
            res.json({status: 404});
        }
    });
}

//app.use(express.static(__dirname + '/src/desktop/index.html'));
//app.use('/static', express.static(__dirname + '/src'));

//app.get('/', staticFile);



var routingProxy = new httpProxy.RoutingProxy();


var devMode = !!process.env.STATIC_FILES_HOST;
function proxy(req, res) {
    if (devMode) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', 0);
    }
    if (req.host === "polis.io" || req.host === "www.polis.io") {
        req.host = process.env.STATIC_FILES_HOST;
    }
    routingProxy.proxyRequest(req, res, {

        host: process.env.STATIC_FILES_HOST,
        port: process.env.STATIC_FILES_PORT,
    });
}

// proxy everything that isn't an API call
app.get(/^\/[^(v3)]?.*/, proxy);

app.listen(process.env.PORT);

console.log('started on port ' + process.env.PORT);
} // End of initializePolisAPI

async.parallel([connectToMongo, connectToPostgres], initializePolisAPI);

}());
