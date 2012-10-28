// You might need to call this first
// export MONGOLAB_URI=`heroku config:get MONGOLAB_URI`

var http = require('http'),
    pg = require('pg'),//.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    crypto = require('crypto'),
    _ = require('underscore'),
    argv = require('optimist')
        .default('o', process.stdout)
        .alias('o', 'outputfile')
        .default('stimulus', "5084c8e3e4b059e606c9ff2a")
        .argv;

// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI
var polisEventsCollection = 'events';
console.log(process.env.MONGOLAB_URI);


var outfile = argv.o


var stream = fs.createWriteStream(outfile);

function printEvent(item){
    stream.write([item._id, item.to, item.type].join(',') + "\n");
}
   

// First line of CSV (field names)
printEvent({_id:"person", to: "comment", type:"rating"});


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
            // find all the reactions for this conversation
            collection.find( { 
                $and: [
                    {s: ObjectId(argv.stimulus)},
                    {to: {$exists: true}},
                    {$or : [
                            {type: 1},  // TODO add these types to a shared JSON file
                            {type: -1}, 
                            {type: 0}, 
                            {type: "see"}, 
                        ]},
                ],
            }, function(err, cursor) {
                if (err) { console.error(err); return; }
                cursor.each(function(err, item) {
                    if (err) { console.error(err); return; }

                    if (item === null) {
                        process.exit(0);
                    }
                    printEvent(item);
                });
            });
    });
});
