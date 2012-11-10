// TODO start checking auth token, test it, remove it from json data


// TODO make different logger
// TODO decide on timestamp/id/hash precision
// TODO add a conversationID
//
// TODO crap! you have to sync ALL the events, or no events.. let's just make a nice rest api and do the work on the server.
//
// TODO try mongo explain https://github.com/mongodb/node-mongodb-native/blob/master/examples/queries.js#L90

console.log('redis url ' +process.env.REDISTOGO_URL);

var http = require('http'),
    pg = require('pg'),//.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    bcrypt = require('bcrypt'),
    crypto = require('crypto'),
    _ = require('underscore');


var AUTH_FAILED = 'auth failed';

var redis;
if (process.env.REDISTOGO_URL) {
    // inside if statement
    var rtg   = url.parse(process.env.REDISTOGO_URL);
    var redis = require("redis").createClient(rtg.port, rtg.hostname);
    redis.auth(rtg.auth.split(":")[1]);
} else {
    redis = require('redis').createClient();
}

// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI

console.log(process.env.MONGOLAB_URI);

function makeSessionToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(256).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 100);
}

function getUserInfoForSessionToken(sessionToken, cb) {
    redis.get(sessionToken, function(errGetToken, replies) {
        if (errGetToken) { cb(errGetToken); return; }
        //console.log('redis:');
        //console.dir(replies);
        cb(null, {u: replies});
    });
}

function startSession(userID, cb) {
    var sessionToken = makeSessionToken();
    //console.log('startSession: token will be: ' + sessionToken);
    console.log('startSession');
    redis.set(sessionToken, userID, function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return }
        console.log('startSession: token set.');
        redis.expire(sessionToken, 7*24*60*60, function(errSetTokenExpire, repliesExpire) {
            if (errSetTokenExpire) { cb(errSetTokenExpire); return; }
            console.log('startSession: token will expire.');
            cb(null, sessionToken);
        });
    });
}

function endSession(sessionToken, cb) {
    redis.del(sessionToken, function(errDelToken, repliesSetToken) {
        if (errDelToken) { cb(errDelToken); return }
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
mongo.connect(process.env.MONGOLAB_URI, {safe: true}, function(err, db) {
    if(err) {
        console.error('mongo failed to init');
        console.error(err);
        process.exit(1);
    }

    db.collection('users', function(err, collectionOfUsers) {
        db.collection('events', function(err, collection) {
            if (err) { console.error(err); return; }
            collection.find({s: ObjectId("5084c8e3e4b059e606c9ff2a")}, function(err, cursor) {
                if (err) { console.error(err); return; }

                /*
                cursor.each(function(err, item) {
                    if (err) { console.error(err); return; }

                    if(item != null) {
                        console.dir(item);
                        var timestampBase16 = item._id.toString().substring(0, 8);
                        var timestamp = new Date(parseInt( timestampBase16, 16) * 1000) + "";
                        console.log(timestampBase16);
                        console.log(timestamp);
                    }
                });
                */
            });
            // OK, DB is ready, start the API server.
            initializePolisAPI({
                mongoCollectionOfEvents: collection,
                mongoCollectionOfUsers: collectionOfUsers,
            });
        });
    });
});



// TODO add error callback
function collectPost(req, res, success) {
    if(req.method == 'POST') {
        var body = '';
        req.on('data', function (data) {
            body += data;
         //  if(body.length > 1e6) // FLOOD ATTACK OR FAULTY CLIENT, NUKE req
         //  {
         //       req.connection.destroy();
         //  }
        });
        req.on('end', function () { 
            var data = JSON.parse(body);
            success(data);
        });
    }
}

function convertFromSession(postData, callback) {
    var token = postData.token;
    if (!token) { callback('missing token'); return; }
    getUserInfoForSessionToken(token, function(err, fetchedUserInfo) {
        if (err) { callback(AUTH_FAILED); return; }
        postData = _.omit(postData, ['token']);
        if (postData.u) { console.error('got postData.u, not needed'); }
        postData.u = fetchedUserInfo.u;
        callback(null, postData);
    });
}

function makeHash(ary) {
    return _.object(ary, ary.map(function(){return 1;}));
}

String.prototype.hashCode = function(){
    var hash = 0, i, char;
    if (this.length == 0) return hash;
    for (i = 0; i < this.length; i++) {
        char = this.charCodeAt(i);
        hash = ((hash<<5)-hash)+char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
};

function initializePolisAPI(params) {

var collection = params.mongoCollectionOfEvents;
var collectionOfUsers = params.mongoCollectionOfUsers;


function fail(res, code, err, httpCode) {
    console.error(code, err);
    res.writeHead(httpCode || 500);
    res.end(err);
}

var polisTypes = {
    reactions: {
        push: 1,
        pull: -1,
        see: 0,
    },
};

// Configure our HTTP server to respond with Hello World to all requests.
var server = http.createServer(function (req, res) {
    var parsedUrl = url.parse(req.url, true);
    var query = parsedUrl.query;
    console.dir(parsedUrl);
    var basepath = parsedUrl.pathname;

    // start server with ds in scope.
    var routes = {

        "/v2/auth/deregister" : function(req, res) {
            collectPost(req, res, function(data) {
                endSession(data, function(err, data) {
                    if (err) { fail(res, 213489289, "couldn't end session"); return; }
                    res.end();
                });
                // log the deregister
                convertFromSession(data, function(err, data) {
                    collection.insert({type: "deregister", u: data.u}, function(err, docs) {
                        if (err) { console.error("couldn't add deregister event to eventstream"); return; }
                    });
                });
            });
        },

        "/v2/auth/login" : function(req, res) {
            collectPost(req, res, function(data) {
                var username = data.username;
                var password = data.password;
                var email = data.email;
                var handles = [];
                if (username) { handles.push({username: username}); }
                if (email) { handles.push({email: email}); }
                var query = {
                    $or : handles
                }; 
                if (!_.isString(password)) { fail(res, 238943622, "polis_err_login_need_password", 403); return; }
                collectionOfUsers.find(query, function(errFindPassword, cursor) {
                    if (errFindPassword) { fail(res, 238943622, "polis_err_login_unknown_user_or_password", 403); return; }
                    cursor.toArray( function(err, docs) {
                        if (err) { fail(res, 238943624, "polis_err_login_unknown_user_or_password", 403); return; }
                        if (!docs || docs.length === 0) { fail(res, 238943625, "polis_err_login_unknown_user_or_password", 403); return; }

                        var hashedPassword  = docs[0].pwhash;
                        var userID = docs[0].u;

                        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
                            if (errCompare || !result) { fail(res, 238943623, "polis_err_login_unknown_user_or_password", 403); return; }
                            
                            startSession(userID, function(errSess, token) {
                                var response_data = {
                                    username: username,
                                    email: email,
                                    token: token
                                };
                                res.end(JSON.stringify(response_data));
                                // log the login
                                collection.insert({type: "login", u: docs[0].u}, function(errInsertEvent, docs) {
                                    if (err) { console.error("couldn't add register event to eventstream u:"+docs[0]); return; }
                                });
                            }); // end startSession
                        }); // compare
                    }); // toArray
                }); // find
            }); // collectPost
        },
        "/v2/auth/new" : function(req, res) {
            collectPost(req, res, function(data) {
                var username = data.username;
                var password = data.password;
                var email = data.email;
                if (!email && !username) { fail(res, 5748932, "polis_err_reg_need_username_or_email"); return; }
                if (!password) { fail(res, 5748933, "polis_err_reg_password"); return; }
                if (password.length < 6) { fail(res, 5748933, "polis_err_reg_password_too_short"); return; }
                if (!_.contains(email, "@") || email.length < 3) { fail(res, 5748934, "polis_err_reg_bad_email"); return; }

                var handles = [];
                if (username) { handles.push({username: username}); }
                if (email) { handles.push({email: email}); }
                collectionOfUsers.find({
                    $or: handles
                }, function(err, cursor) {
                    if (err) { fail(res, 5748936, "polis_err_reg_checking_existing_users"); return; }
                    cursor.toArray(function(err, docs) {
                        if (err) { console.error(err); fail(res, 5748935, "polis_err_reg_checking_existing_users"); return; }
                        if (docs.length > 0) { fail(res, 5748934, "polis_err_reg_user_exists", 403); return; }

                        bcrypt.genSalt(12, function(errSalt, salt) {
                            if (errSalt) { fail(res, 238943585, "polis_err_reg_123"); return; }

                            bcrypt.hash(password, salt, function(errHash, hashedPassword) {
                                delete data.password;
                                password = null;
                                if (errHash) { fail(res, 238943594, "polis_err_reg_124"); return; }

                                var response_data = {};
                                var regEvent = {
                                    type: "newuser",
                                };
                                if (email) {
                                    regEvent.email = email;
                                }
                                if (username) {
                                    regEvent.username = username;
                                }
                                collection.insert(regEvent, function(errInsertEvent, docs) {

                                    if (errInsertEvent) { fail(res, 238943603, "polis_err_reg_failed_to_add_event"); return; }

                                    var userID = docs[0]._id;
                                    var userRecord = {
                                        u: userID,
                                        pwhash: hashedPassword
                                    };
                                    if (username) {
                                        userRecord.username = username;
                                    }
                                    if (email) {
                                        userRecord.email = email;
                                    }
                                    collectionOfUsers.insert(userRecord,
                                        function(errInsertPassword, docs) {
                                            if (errInsertPassword) { fail(res, 238943599, "polis_err_reg_failed_to_add_user_record"); return; } // we should probably delete the log entry.. would be nice to have a transaction here

                                            startSession(userID, function(errSessionStart,token) {
                                                if (errSessionStart) { fail(res, 238943600, "polis_err_reg_failed_to_start_session"); return; }
                                                res.end(JSON.stringify({
                                                    username: username,
                                                    email: email,
                                                    token: token
                                                }));
                                            });
                                    }); // end insert user
                                }); // end insert regevent
                            }); // end hash
                        }); // end gensalt
                    }); // end cursor.toArray
                }); // end find existing users
            }); // end collect post
        }, // end auth/new

        "/v2/txt" : (function() {
            function makeQuery(stimulusId, lastServerToken) {
                var q = {
                    $and: [
                        {$or : [
                            {s:   ObjectId(stimulusId)},
                        //    {_id: ObjectId(stimulusId)},// Hmm, lets include the stimulus itself.  We'll need to fetch the "lastServerToken" so we don't redeliver things.
                        ]}, 
                        {txt : {$exists: true}},// return anything that has text attached.
                        //{type: {$neq: "stimulus"}},
                    ],
                }; 
                if (lastServerToken) {
                    q.$and.push({_id: {$gt: ObjectId(lastServerToken)}});
                }
                return q;
            }

            return function(req, res) {
                var stimulus = query.s;
                var lastServerToken = query.lastServerToken;
                if('GET' === req.method) {
                    var docs = [];
                    collection.find(makeQuery(stimulus, lastServerToken), function(err, cursor) {
                        if (err) { fail(res, 234234332, err); return; }

                        function onNext( err, doc) {
                            if (err) { fail(res, 987298787, err); return; }
                            //console.dir(doc);

                            if (doc) {
                                docs.push(doc);
                                cursor.nextObject(onNext);
                            } else {
                                res.end(JSON.stringify({
                                    lastServerToken: lastServerToken,
                                    events: docs,
                                }));
                            }
                        }

                        cursor.nextObject( onNext);
                    });
                    return;
                }
                if('POST' === req.method) {
                    collectPost(req, res, function(data) {
                        convertFromSession(data, function(err, data) {
                            if (err) { fail(res, 93482573, err); return; }

                            data.events.forEach(function(ev){
                                // TODO check the user & token database 
                                //
                                if (!ev.txt) { fail(res, 'expected txt field'); return; }

                                if (ev.s) ev.s = ObjectId(ev.s);
                                if (data.u) {
                                    ev.u = ObjectId(data.u);
                                }
                                collection.insert(ev, function(err, cursor) {
                                    if (err) { fail(res, 324234331, err); return; }
                                    res.end();
                                }); // insert
                            }); // each 
                        }); // session
                    }); // post body
                    return;
                } // POST
            }; // closure
        }()), // route
        "/v2/reactions/me" : function(req, res) {
                convertFromSession({} , function(err, data) {
                if('GET' === req.method) {
                    var users = [];
                    var query = {
                        u : data.u,
                        s: ObjectId(stimulusId), 
                        $or: _.values(polisTypes.reactions).map( function(r) {return { type: r }; }), 
                    };
                    collection.find(query, function(err, cursor) {
                        if (err) { fail(res, 234234325, err); return; }

                        function onNext( err, doc) {
                            if (err) { fail(res, 987298783, err); return; }
                            //console.dir(doc);

                            if (doc) {
                                users.push(doc);
                                cursor.nextObject(onNext);
                            } else {
                                res.end(JSON.stringify(users));
                            }
                        }

                        cursor.nextObject( onNext);
                    });
                    return;
                }
            });
        },
        "/v2/reactions" : (function() {
            function makeQuery(stimulusId) {
                // $or [{type: push}, {type: pull},...]
                return {
                    s: ObjectId(stimulusId), 
                    $or: _.values(polisTypes.reactions).map( function(r) {return { type: r }; }), 
                };
            }

            return function(req, res) {
                var stimulus = query.s;
                if('GET' === req.method) {
                    var users = [];
                    collection.find(makeQuery(stimulus), function(err, cursor) {
                        if (err) { fail(res, 234234325, err); return; }

                        function onNext( err, doc) {
                            if (err) { fail(res, 987298783, err); return; }
                            //console.dir(doc);

                            if (doc) {
                                users.push(doc);
                                cursor.nextObject(onNext);
                            } else {
                                res.end(JSON.stringify(users));
                            }
                        }

                        cursor.nextObject( onNext);
                    });
                    return;
                }
                if('POST' === req.method) {

                    collectPost(req, res, function(data) {

                        //console.log('collected');
                        //console.dir(data);
                        convertFromSession(data, function(err, data) {
                            //console.log('converted');
                            //console.dir(data);
                            if (err) { fail(res, 93482572, err); return; }

                            data.events.forEach(function(ev){

                                if (ev.s) {
                                    ev.s = ObjectId(ev.s);
                                }
                                ev.u = ObjectId(data.u);

                                collection.insert(ev, function(err, cursor) {
                                    if (err) { fail(res, 324234324, err); return; }
                                    res.end();
                                });
                            });
                        });
                    });
                    return;
                }
            };
        }()),
    };

    if (routes[basepath]) {
        res.writeHead(200, { // TODO don't write 200 so early
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        //    'Access-Control-Allow-Origin': '*',
        //    'Access-Control-Allow-Credentials': 'true'
        });

        // Run the route handler
        routes[basepath](req, res);

    } else {

        // try to serve a static file
        var requestPath = req.url;
        var contentPath = './src';
        if (requestPath === '/')
            contentPath += '/desktop/index.html';
        else if (requestPath === '/mobile/')
            contentPath += '/mobile/index.html';
        else if (requestPath.indexOf('/static/') === 0) {
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
                        res.end('{ "status": 404}');
                    }
                    else {
                        res.writeHead(200, { 'Content-Type': contentType });
                        res.end(content, 'utf-8');
                    }
                });
            } else {
                res.writeHead(404);
                res.end('{ "status": 404}');
            }
        });
    }
});
server.listen(process.env.PORT);
console.log('started on port ' + process.env.PORT);
} // End of initializePolisAPI


