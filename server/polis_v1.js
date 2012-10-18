// TODO make different logger
// TODO make output files for data, or use sqlite

var http = require('http'),
    fs = require('fs'),
    path = require('path'),
    _ = require('underscore');

function DataStoreFactory(oldEvents) {
    var events = [];

    function makeEventSelector(timestamp) {
        return function(event) {
            var isNewEnough = event.t >= timestamp;
            console.log("? " + JSON.stringify(event) + " " + timestamp + " " + isNewEnough);
            return isNewEnough;
        }
    }

    function getEventsSince(serverTimestamp) {
        return events.filter(makeEventSelector(serverTimestamp));
    }

    function addEvents(newEvents) {
        for (var i = 0; i < newEvents.length; i++) {
            events.push(newEvents[i]);
            console.log(newEvents[i]);
        }
    }

    // init
    for (var i = 0; i < oldEvents.length; i++) {
        events.push(oldEvents[i]);
    }

    return {
        addEvents: addEvents,
        getEventsSince: getEventsSince,
    };
}


// Read stdin, parse as JSON, and use as oldEvents
process.stdin.resume();
process.stdin.setEncoding('utf8');

// data store
var ds;

var allStdin = "";
process.stdin.on('data', function (chunk) {
      //process.stdout.write('data: ' + chunk);
      allStdin += chunk;
});

// load old events from disk
var oldEvents = [];
process.stdin.on('end', function () {
     var lines = allStdin.split("\n");
     for (var i = 0; i < lines.length; i++) {
         try {
             console.log("a: " + lines[i]);
             oldEvents.push(JSON.parse(lines[i]));
         } catch (err) {
             console.error( "bad line. got: " + lines[i]);
         }
     }
     ds = DataStoreFactory(oldEvents);

     // try it
     allEvents = ds.getEventsSince(1349491010997);
     console.dir(allEvents);
});


function getTimestamp() {
    // This timestamp will be used by the client to compute an
    // offset.
    // The system uses microseconds to enforce per-user uniqueness 
    // of timestamps. (which gives an unambiguous order-of-events)
    // These values will be fudged when we generate events.. the
    // client may keep a counter, which will increment every time
    // it tries to create a new event during the same millisecond
    // it created another event. That counter is reset if the
    // millisecond has changed since the last event was created.
    // (so usually the value will end in 000.
    return Date.now();
}

function addTimeStamp(responseObject) {
    return _.extend(responseObject, {serverTime: getTimestamp()});
}


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
            var json = JSON.parse(body);
            success(json);
        });
    }
}


function makeHash(ary) {
    return _.object(ary, ary.map(function(){return 1;}));
}

// Configure our HTTP server to respond with Hello World to all requests.
var server = http.createServer(function (req, res) {

    // start server with ds in scope.
    var routes = {
        "/v1/syncEvents" : function(req, res) {

            console.log(req.url);
            collectPost(req, res, function(data) {

                var events = data.events;
                if (events && events.length) {
                    ds.addEvents(events);
                }

                var result =  addTimeStamp({
                    received: events.length,
                });
                console.log(types_to_return);
                var types_to_return = data.types_to_return;
                if (types_to_return) {
                    types_to_return = makeHash(types_to_return);
                    console.log(types_to_return);
                    var evs = _.filter(ds.getEventsSince(data.previousServerTime), function(x) {
                        // "p_comment", etc
                        return !!types_to_return[x.type];
                    });
                    result.newEvents = evs;
                }
                
                console.dir(result);
                res.end(JSON.stringify(result));
            });
        },
        "/v1/getEvents" : function(req, res) { 
            console.log(req.url);
            collectPost(req, res, function(data) {
                var result = JSON.stringify(ds.getEventsSince(data.previousServerTime));
                console.log(result);
                req.end(result);
            });
        },
    };

    ds = DataStoreFactory([]);

    var parts = req.url.split("?");
    var basepath = parts[0];
    var queryParams = (parts.length >= 2) ? parts[1].split("&") : [];

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true'
        });

console.log(basepath);
    if (routes[basepath]) {
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

server.listen(8000);
console.log('started');


