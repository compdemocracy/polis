var http = require('http');
var fs = require('fs');
var path = require('path');
var _ = require('underscore');

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
        for (var i = 0; i < newEvents.legth; i++) {
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
    return Date.now() * 1000;
}

function addTimeStamp(responseObject) {
    return _.extend(responseObject, {t: getTimestamp()});
}

// start server with ds in scope.
var routes = {
    "/v1/addEvents" : function(queryParams) { 
        return JSON.stringify(
                addTimeStamp({
                    foo: queryParams
                }));
    },
    "/v1/getEvents" : function(queryParams) { 
        return JSON.stringify(
                addTimeStamp({
                    bar: queryParams
                }));
    },
};

// Configure our HTTP server to respond with Hello World to all requests.
var server = http.createServer(function (request, response) {
    var parts = request.url.split("?");
    var basepath = parts[0];
    var queryParams = (parts.length >= 2) ? parts[1].split("&") : [];

console.log('yawn');
console.dir(queryParams);
    if (routes[basepath]) {
        response.writeHead(200, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Credentials': 'true'
	});
        response.end(routes[basepath](queryParams));
    } else {
	// try to serve a static file
    var filePath = '.' + request.url;
    if (filePath == './')
        filePath = './index.html';
         
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
		    response.writeHead(404);
                    response.end("404 dude");
                }
                else {
                    response.writeHead(200, { 'Content-Type': contentType });
                    response.end(content, 'utf-8');
                }
            });
        } else {
            response.writeHead(404);
	    response.end("404 dude");
        }
    });
    }
});

server.listen(8000);
console.log('started');


