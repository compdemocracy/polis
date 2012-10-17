
/*

log based service
all in ram, but logs every event to disk. (assume one server for now)

At some point, we'll have to use a centralized store for that, liek dynamo or whatever db.



APIs


/v1/events/
    POST
        {
          method: "GET",
          items:
            [
                {timestamp: 12847283764, id: 293846, action: "view", object: 294723 },
                {timestamp: 12847283765, id: 293846, action: "pull", object: 294723 },
                {timestamp: 12847283765, id: 293846, action: "pull", object: 294723 },
            ]
        }

        {
          method: "GET", 
          lastServerTimestamp: 9238472389, 
        }

        {
            method: "SYNC",
            items: [
                {timestamp: 12847283764, id: 293846, action: "view", object: 294723 },
                {timestamp: 12847283765, id: 293846, action: "pull", object: 294723 },
                {timestamp: 12847283765, id: 293846, action: "pull", object: 294723 },
            ],
            // lastServerTimestamp: 39823423984, <-- omit this to get everything.
        }


        put in array and sort by timestamp.
*/


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
    return $.extend(responseObject, {t: getTimestamp()});
}

// start server with ds in scope.
var routes = {
    "/addEvents" : function(queryParams) { 
        return JSON.stringify(
                addTimeStamp({
                    foo: queryParams
                });
    },
    "/getEvents" : function(queryParams) { 
        return JSON.stringify(
                addTimeStamp({
                    bar: queryParams
                });
    },
};

var http = require('http');

// Configure our HTTP server to respond with Hello World to all requests.
var server = http.createServer(function (request, response) {
    var parts = request.url.split("?");
    var path = parts[0];
    var queryParams = (parts.length >= 2) ? parts[1].split("&") : [];

    if (routes[path]) {
        console.dir(queryParams);
        response.writeHead(200, {"Content-Type": "text/plain"});
        response.end(routes[path](queryParams));
    } else {
        response.writeHead(404, {"Content-Type": "text/plain"});
        response.end("404 not found\n");
    }
});

// Listen on port 8000, IP defaults to 127.0.0.1
server.listen(8000);

// Put a friendly message on the terminal
console.log("Server running at http://127.0.0.1:8000/");
