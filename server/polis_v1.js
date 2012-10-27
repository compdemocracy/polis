// TODO make different logger
// TODO decide on timestamp/id/hash precision
// TODO add a conversationID
//
// TODO crap! you have to sync ALL the events, or no events.. let's just make a nice rest api and do the work on the server.
//
// TODO try mongo explain https://github.com/mongodb/node-mongodb-native/blob/master/examples/queries.js#L90

var http = require('http'),
    pg = require('pg'),//.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    crypto = require('crypto'),
    _ = require('underscore');



// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI
var polisEventsCollection = 'events';
console.log(process.env.MONGOLAB_URI);
//var mongoServer = new MongoServer(process.env.MONGOLAB_URI, 37977, {auto_reconnect: true});
//var db = new MongoDb('exampleDb', mongoServer, {safe: true});
mongo.connect(process.env.MONGOLAB_URI, {safe: true}, function(err, db) {
    if(err) {
        console.error('mongo failed to init');
        console.error(err);
        process.exit(1);
    }
    db.collection(polisEventsCollection, function(err, collection) {
        if (err) { console.error(err); return; }
        collection.find({s: ObjectId("5084c8e3e4b059e606c9ff2a")}, function(err, cursor) {
            if (err) { console.error(err); return; }

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
        });
        // OK, DB is ready, start the API server.
        initializePolisAPI({
            mongoCollectionOfEvents: collection,
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


function fail(res, code, err) {
    console.error(code, err);
    res.writeHead(500);
    res.end(code);
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

        // Cookies / auth tokens:
        // all we need is a random string to set as the cookie of an authenticated user, and a key that will tell us what is the user ID of the client holding such a random string. 
        //
        "/v2/auth/newAnon" : function(req, res) {
            var response_data = {};
            var retrieveThis = Math.random();
            collection.insert({type: "newuser"}, function(err, docs) {
                if (err) { fail(res, 238943589, err); return; }
                response_data.u = docs[0]._id;
                res.end(JSON.stringify(response_data));
            });
        },

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
                            console.dir(doc);

                            if (doc) {
                                docs.push(doc);
                                cursor.nextObject(onNext);
                            } else {
                                console.log(' finished query ');
                                res.end(JSON.stringify(docs));
                            }
                        }

                        cursor.nextObject( onNext);
                    });
                    return;
                }
                if('POST' === req.method) {
                    collectPost(req, res, function(data) {
                        data.events.forEach(function(ev){
                            // TODO check the user & token database 
                            //
                            if (!ev.txt) { fail(res, 'expected txt field'); return; }

                            if (ev.s) ev.s = ObjectId(ev.s);
                            if (ev.u) {
                                ev.u = ObjectId(ev.u);
                            } else {
                                fail(res, "need u (userid) field.");
                                return;
                            }
                            collection.insert(ev, function(err, cursor) {
                                if (err) { fail(res, 324234331, err); return; }
                                res.end();
                            });
                        });
                    });
                    return;
                }
            };
        }()),
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
                            console.dir(doc);

                            if (doc) {
                                users.push(doc);
                                cursor.nextObject(onNext);
                            } else {
                                console.log(' finished query ');
                                res.end(JSON.stringify(users));
                            }
                        }

                        cursor.nextObject( onNext);
                    });
                    return;
                }
                if('POST' === req.method) {
                    collectPost(req, res, function(data) {
                        data.events.forEach(function(ev){
                            // TODO check the user & token database 
                            if (ev.s) ev.s = ObjectId(ev.s);
                            if (ev.u) {
                                ev.u = ObjectId(ev.u);
                            } else {
                                fail(res, "need u (userid) field.");
                                return;
                            }
                            collection.insert(ev, function(err, cursor) {
                                if (err) { fail(res, 324234324, err); return; }
                                res.end();
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
        var filePath = './static_iran_sample';
        if (req.url === '/')
            filePath += '/index.html';
        else 
            filePath += req.url;
             
        var extname = path.extname(filePath);
        var contentType = 'text/html';
        switch (extname) {
            case '.js':
                contentType = 'text/javascript';
                break;
            case '.css':
                contentType = 'text/css';
                break;
        }
         
        fs.exists(filePath, function(exists) {
            if (exists) {
                fs.readFile(filePath, function(error, content) {
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


