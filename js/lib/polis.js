var eb = require("../eventBus");
var metric = require("../util/gaMetric");
var Utils = require("../util/utils")
var shuffleWithSeed = require("../util/shuffleWithSeed");
var brain = require("brain");
var URLs = require("../util/url");
var mapObj = Utils.mapObj;
var urlPrefix = URLs.urlPrefix;


module.exports = function(params) {

    var polisTypes = {
        reactions: {
            push: 1,
            pull: -1,
            pass: 0,
            trash: "trash",
            see: "see"
        },
        staractions: {
            unstar: 0,
            star: 1
        }
    };

    var commentsToVoteOn = {}; // tid -> comment

    var basePath = params.basePath;

    var votesPath = "api/v3/votes";
    var starsPath = "api/v3/stars";
    var trashesPath = "api/v3/trashes";
    var commentsPath = "api/v3/comments";
    var nextCommentPath = "api/v3/nextComment";

    var createAccountPath = "api/v3/auth/new";
    var loginPath = "api/v3/auth/login";
    var deregisterPath = "api/v3/auth/deregister";
    var pcaPath = "api/v3/math/pca";
    var pcaPlaybackPath = "api/v3/math/pcaPlaybackByLastVoteTimestamp";
    var bidToPidPath = "api/v3/bidToPid";
    var bidPath = "api/v3/bid";
    var selectionPath = "api/v3/selection";

    var conversationsPath = "api/v3/conversations";
    var participantsPath = "api/v3/participants";

    var queryParticipantsByMetadataPath = "api/v3/query_participants_by_metadata";

    var commentVelocitiesPath = "api/v3/velocities";
    var metadataAnswersPath = "api/v3/metadata/answers";
    var metadataChoicesPath = "api/v3/metadata/choices";
    var xidsPath = "api/v3/xids";

    var logger = params.logger;

    var lastServerTokenForPCA = -1;
    var lastServerTokenForComments = -1;
    var lastServerTokenForBid = -1;
    var lastServerTokenForBidToPid = -1;

    var initReadyCallbacks = $.Callbacks();
    var authStateChangeCallbacks = $.Callbacks();
    var personUpdateCallbacks = $.Callbacks();
    var commentsAvailableCallbacks = $.Callbacks();

    var firstPcaCallPromise = $.Deferred();
    var clustersCachePromise = $.Deferred();
    var votesForTidBidPromise = $.Deferred();

    var projectionPeopleCache = [];
    var clustersCache = [];

    var tidSubsetForReprojection = [];

    // collections
    var votesByMe = params.votesByMe;
    var allComments = [];

    // allComments.on("add remove reset", function() {
    //     eb.trigger(eb.commentCount, this.length);
    // });

    var pcX = {};
    var pcY = {};
    var centerX = 0;
    var centerY = 0;
    var repness; // gid -> [{data about most representative comments}]
    var votesForTidBid = {}; // tid -> bid -> {A: agree count, B: disagree count}
    var participantCount = 0;
    var bidToPid = [];
    var pidToBidCache = null;
    var bid;

    var pollingScheduledCallbacks = [];

    var tokenStore = params.tokenStore;
    var uidStore = params.uidStore;

    var needAuthCallbacks = $.Callbacks();

    var conversation_id = params.conversation_id;
    var zinvite = params.zinvite;
    var pid = params.pid;

    var means = null; // TODO move clustering into a separate file

    var BUCKETIZE_THRESH = 64;
    var BUCKETIZE_ROWS = 8;
    var BUCKETIZE_COLUMNS = 8;

    var shouldPoll = true;

    function demoMode() {
        return getPid() < 0;
    }

    // TODO if we decide to do manifest the chain of comments in a discussion, then we might want discussionClients that spawn discussionClients..?
    // Err... I guess discussions can be circular.
    //function discussionClient(params)

    // TODO rename
    function syncAllCommentsForCurrentStimulus(optionalStimulusId) { // more like sync?
        var dfd = $.Deferred();
        var params = {
            lastServerToken: (new Date(0)).getTime(),
            // not_pid: getPid(), // don't want to see own coments
            not_voted_by_pid: getPid(),
            conversation_id: conversation_id
            //?
        };
        function fail() {
            dfd.reject(0);
        }
        getComments(params).then( function(comments) {
            if (!comments) {
                logger.log("no new comments for stimulus");
                dfd.resolve(0);
                return;
            }
           // getCommentVelocities().then(function() {
                var IDs = _.pluck(comments, "tid");
                var oldkeys = _.keys(commentsToVoteOn).map(
                    function(tid) {
                        return parseInt(tid, 10);
                    }
                );
                var newIDs = _.difference(IDs, oldkeys);
                comments.forEach(function(ev) {
                    var d = ev.created;
                    if (d > lastServerTokenForComments) {
                        lastServerTokenForComments = d;
                    }
                });
                var newComments = comments.filter(function(ev) {
                    return _.contains(newIDs, ev.tid);
                });
                for (var i = 0; i < newComments.length; i++) {
                    var tid = newComments[i].tid;
                    var alreadyVotedOn = !!votesByMe.findWhere({tid: tid});
                    if (!alreadyVotedOn) {
                        commentsToVoteOn[tid] = newComments[i];
                    }
                }
                var numComments = _.keys(commentsToVoteOn).length;
                if (numComments) {
                    commentsAvailableCallbacks.fire();
                    dfd.resolve(numComments);
                } else {
                    fail();
                }
           // }, fail);
        }, function(err) {
            logger.error("failed to fetch comments");
            logger.dir(err);
            fail();
        });
        return dfd.promise();
    }

    function getNumComments() {
        return _.keys(commentsToVoteOn).length;
    }

    function getNextComment(o) {
        // var dfd = $.Deferred();

        // var index;
        // var numComments = getNumComments();
        // if (numComments > 0) {
        //     // Pick a random comment
        //     index = _.shuffle(_.keys(commentsToVoteOn)).pop();
        //     dfd.resolve(commentsToVoteOn[index]);
        // } else {
        //     // return the number of votes user has done.
        //     // This is useful to know if there are no
        //     // comments because the user is done voting,
        //     // or if there aren't any comments available yet.
        //     dfd.reject(votesByMe.size());
        // }
        // return dfd.promise();


        var params = {
            not_voted_by_pid: getPid(),
            limit: 1,
            conversation_id: conversation_id
        };

        if (demoMode()) {
            // DEMO_MODE
            params.without = votesByMe.pluck("tid");
        }

        if (o && !_.isUndefined(o.notTid)) {
            // Don't return the comment that's currently showing.
            // We expect the server to know what we've voted on,
            // but not what client is currently viewing.
            if (!params.without) {
                params.without = [];
            }
            params.without.push(o.notTid);
        }


        return polisGet(nextCommentPath, params);
    }

    function submitComment(model) {


        // CAUTION - possibly dead code, comments are submitted through backbone


        if (demoMode()) {
            return $.Deferred().resolve();
        }

        model = $.extend(model, {
            // server will find the pid
            conversation_id: conversation_id
        });
        if (typeof model.txt !== "string" || model.txt.length === 0) {
            logger.error("bad comment");
            return $.Deferred().reject().promise();
        }
        return polisPost(commentsPath, model).pipe(function(commentResponse) {
            // auto agree
            return agree(commentResponse.tid).pipe(function() {
                // return the result of the comment post, rather than the response of the auto-agree.
                return commentResponse;
            });
        });
    }

    function clearComment(tid) {
        delete commentsToVoteOn[tid];
    }

    function disagree(commentId) {
        clearComment(commentId, "push");
        return react({
            vote: polisTypes.reactions.push,
            tid: commentId
        });
    }

    // returns promise {nextComment: {tid:...}} or {} if no further comments
    function react(params) {
        if (params.conversation_id && params.conversation_id !== conversation_id) {
            if (params.vote !== polisTypes.reactions.see) {
                console.error("wrong stimulus");
            }
        }
        if (typeof params.tid === "undefined") {
            console.error("missing tid");
            console.error(params);
        }
        if (demoMode()) {
            return getNextComment({
                notTid: params.tid // Also don't show the comment that was just voted on.
            }).then(function(c) {
                var o = {};
                if (c) {
                    o.nextComment = c;
                }
                return o;
            });
        }
        return polisPost(votesPath, $.extend({}, params, {
                // server will find the pid
                conversation_id: conversation_id
            })
        );
    }

    function agree(commentId) {
        clearComment(commentId);
        return react({
            vote: polisTypes.reactions.pull,
            tid: commentId
        });
    }

    function pass(tid) {

        clearComment(tid);
        return react({
            vote: polisTypes.reactions.pass,
            tid: tid
        });
    }

    function trash(tid) {
        clearComment(tid, "trash");

        if (demoMode()) {
            return $.Deferred().resolve();
        }

        return polisPost(trashesPath, {
            tid: tid,
            trashed: 1,
            conversation_id: conversation_id
        });
    }

    function doStarAction(params) {
        if (params.conversation_id && params.conversation_id !== conversation_id) {
            console.error("wrong stimulus");
        }
        if (typeof params.tid === "undefined") {
            console.error("missing tid");
            console.error(params);
        }
        if (typeof params.starred === "undefined") {
            console.error("missing star type");
            console.error(params);
        }

        // DEMO_MODE
        if (getPid() < 0) {
            return $.Deferred().resolve();
        }

        return polisPost(starsPath, $.extend({}, params, {
                conversation_id: conversation_id
            })
        );
    }

    function unstar(tid) {
        return doStarAction({
            starred: polisTypes.staractions.unstar,
            tid: tid
        });
    }

    function star(tid) {
        return doStarAction({
            starred: polisTypes.staractions.star,
            tid: tid
        });
    }

    function getCommentVelocities() {
        return polisGet(commentVelocitiesPath, {
            conversation_id: conversation_id
        });
    }

    function invite(xids) {
        return polisPost("api/v3/users/invite", {
            single_use_tokens: true,
            conversation_id: conversation_id,
            xids: xids
        });
    }

    function polisPost(api, data) {
        return polisAjax(api, data, "POST");
    }

    function polisGet(api, data) {
        return polisAjax(api, data, "GET");
    }

    function polisAjax(api, data, type) {
        if (!_.isString(api)) {
            throw "api param should be a string";
        }

        var url = urlPrefix + basePath + api;

        // Add the auth token if needed.
        // if (_.contains(authenticatedCalls, api)) {
        //     var token = tokenStore.get();
        //     if (!token) {
        //         needAuthCallbacks.fire();
        //         console.error("auth needed");
        //         return $.Deferred().reject("auth needed");
        //     }
        //     //data = $.extend({ token: token}, data); // moving to cookies
        // }

        var promise;
        var config = {
            url: url,
            contentType: "application/json; charset=utf-8",
            headers: {
                //"Cache-Control": "no-cache"  // no-cache
                "Cache-Control": "max-age=0"
            },
            xhrFields: {
                withCredentials: true
            },
            // crossDomain: true,
            dataType: "json"
        };
        if ("GET" === type) {
            promise = $.ajax($.extend(config, {
                type: "GET",
                data: data
            }));
        } else if ("POST" === type) {
            promise = $.ajax($.extend(config, {
                type: "POST",
                data: JSON.stringify(data)
            }));
        }

        promise.fail( function(jqXHR, message, errorType) {

            // sendEvent("Error", api, jqXHR.status);

            logger.error("SEND ERROR");
            console.dir(arguments);
            if (403 === jqXHR.status) {
                needAuthCallbacks.fire();
            }
                //logger.dir(data);
                //logger.dir(message);
                //logger.dir(errorType);
        });
        return promise;
    }

    function Bucket() {
        if (_.isNumber(arguments[0])) {
            var bid = arguments[0];
            var people = arguments[1];
            this.ppl = _.isArray(people) ? people : [];
            this.bid = bid;
            this.proj = {
                x: 0,
                y: 0
            };
        } else {
            var o = arguments[0];
            this.bid = o.id;
            this.proj = o.proj;
            this.count = o.count;
            if (o.containsSelf) {
                this.containsSelf = true;
            }
        }

    }
    function average(items, getter) {
        var avg = 0;
        for (var i = 0; i < items.length; i++) {
            avg += getter(items[i]);
        }
        return avg / items.length;
    }
    function getX(person) {
        return person.proj.x;
    }

    function getY(person) {
        return person.proj.y;
    }

    Bucket.prototype.containsPid = function(pid) {
        if (!this.ppl) {
            // TODO dfd
            return false;
        }
        for (var i = 0; i < this.ppl.length; i++) {
            if (this.ppl[i].pid === pid) {
                return true;
            }
        }
        return false;
    };
    Bucket.prototype.update = function() {
        if (!this.ppl) {
            // TODO remove update method?
            return;
        }
        this.proj.x = average(this.ppl, getX);
        this.proj.y = average(this.ppl, getY);
        this.count = this.ppl.length;
        if (this.containsPid(getPid())) {
            this.containsSelf = true;
            // Decrease the size of the bucket which contains self...
            this.count -= 1;
            for (var i = 0; i < this.ppl.length; i++) {
                if (this.ppl[i].isBlueDot) {
                    // ... but if this is the blue dot, we don't want it to have a zero count.
                    this.count += 1;
                    break;
                }
            }
        }
    };
    Bucket.prototype.getPeople = function() {
        // return getUserInfoByBid(this.bid);
        // TODO make service call instead.
        var dfd = $.Deferred();
        if (this.ppl) {
            dfd.resolve(this.ppl);
        } else {
            dfd.resolve([{
                pid: 123,
                email: "person1@att.net"
            }, {
                pid: 234,
                email: "person2@att.net"
            }]);
        }
        return dfd.promise();
    };
    function bucketizeSelf(self, selfDotBid) {
        var bucket = new Bucket({
            containsSelf: true,
            proj: self.proj,
            count: 1,
            bid: selfDotBid
        });
        return bucket;
    }


        // var bid = 0; // TODO expecting bid (Bucket id) to be set (or implicit in array index) in math worker
        // return people.map(function(p) {
        //     var b = new Bucket(bid);
        //     b.ppl.push(p);
        //     b.update();
        //     bid += 1;
        //     return b;
        // });
    // }
    // function bucketize(people) {
    //     function Bucket() {
    //         this.people = [];
    //     }
    //     Bucket.prototype.add = function(person) {
    //         this.people.push(person);
    //     };
    //     Bucket.prototype.
    //     var cells = {};

    //     if (people.length < BUCKETIZE_THRESH) {
    //         return people.map(function(p) {
    //             return [p];
    //         });
    //     }
    //     for (var p in people) {
    //         cells[
    //     }
    // }

function clientSideBaseCluster(things, N) {
    if (!N) { console.error("need N"); }
    if (!means) {
        means = shuffleWithSeed(things, 0.5);
        means = _.first(means, N);
        means = means.map(function(thing) { return _.pick(thing, "x", "y");});
    }

    var clusters = means.map(function() { return [];});

    function getNearestMean(thing) {
        var best = Infinity;
        var bestMean = means[0];
        var bestIndex = -1;
        for (var mi = 0; mi < means.length; mi++) {
            var m = means[mi];
            var totalSquares = 0;
            var dx = thing.x - m.x;
            var dy = thing.y - m.y;
            totalSquares += dx*dx + dy+dy;
            if (totalSquares < best) {
                best = totalSquares;
                bestMean = m;
                bestIndex = mi;
            }
        }
        return bestIndex;
    }

    function assignToCluster(thing) {
        var bestIndex = getNearestMean(thing);
        if (bestIndex === -1) {
            console.log("bad bestIndex, check getNearestMean");
            return;
        }
        if (-1 !== clusters[bestIndex].indexOf(thing)) {
            return;
        }
        for (var i = 0; i < clusters.length; i++) {
            clusters[i] = _.without(clusters[i], thing);
        }
        clusters[bestIndex].push(thing);
    }

    function recenterCluster(i) {
        var cluster = clusters[i];
        if (!cluster.length) {
            return;
        }
        var totals = {
            x: 0,
            y: 0
        };
        for (var pi = 0; pi < cluster.length; pi++) {
            var thing = cluster[pi];
            totals.x += thing.x;
            totals.y += thing.y;
        }
        var avg = {
            x: totals.x / cluster.length,
            y: totals.y / cluster.length
        };
        means[i] = avg;
    }

    //function findClusterVariance(i) {
        //var cluster = clusters[i];
        //for (var pi = 0; pi < clusters.length; pi++) {
        //}
    //}

    function iterate() {
        _.each(things, assignToCluster);
        for (var i = 0; i < means.length; i++) {
            recenterCluster(i);
        }
    }

    _.times(9, iterate);
    /*
    var i = 0;
    return means.map(function(proj) {
        var representative = {
            pid: -1,
     //       variance: variances[i];
            data: {
                projection: proj,
                participants: clusters[i]
            }
        };
        i += 1;
        return representative;
    });
    */
    // [[1,2,5],[4]]
    return clusters.map(function(cluster) {
        return cluster.map(function(thing) {
            return thing.bid;
        }).sort(function(a, b) {
            // ascending
            return a - b;
        });
    });
}


    function getMetadataAnswers() {
        return polisGet(metadataAnswersPath, {
            conversation_id: conversation_id
        });
    }
    function getMetadataChoices() {
        return polisGet(metadataChoicesPath, {
            conversation_id: conversation_id
        });
    }

    function getBidToGid() {
        var bidToGid = {};
        for (var gid = 0; gid < clustersCache.length; gid++) {
            var cluster = clustersCache[gid];
            for (var i = 0; i < cluster.length; i++) {
                var bid = cluster[i];
                bidToGid[bid] = gid;
            }
        }
        return bidToGid;
    }

    // returns {
    //   pmqid : {
    //     pmaid : {
    //       choices : {
    //         gid : [answers]
    //       },
    //       counts: {
    //         gid: [number of ptpts in gid who chose that that pmaid for that pmqid]
    //       }
    //     }
    //   }
    // }
    function doFindRepresentativeMetadata(choices, p2b, b2g) {
        var groupedChoices = _.groupBy(choices, "pmqid");
        var questionsWithAnswersWithChoices = {};
        _.each(groupedChoices, function(choicesForQuestion, pmqid) {
            var allChoicesForAnswer = _.groupBy(choicesForQuestion, "pmaid");
            var allChoicesForAnswerGrouped = {};
            _.each(allChoicesForAnswer, function(choices, pmaid) {
                _.each(choices, function(c) {
                    c.bid = p2b[c.pid];
                    c.gid = b2g[c.bid];
                });
            });
            var counts = {};
            _.each(allChoicesForAnswer, function(choices, pmaid) {
                var groupedAnswers = _.groupBy(choices, "gid");
                allChoicesForAnswerGrouped[pmaid] = groupedAnswers;
                counts[pmaid] = {};
                _.each(groupedAnswers, function(answersForGroup, gid) {
                    counts[pmaid][gid] = answersForGroup.length;
                });
            });
            _.allChoicesForAnswerGrouped
            questionsWithAnswersWithChoices[pmqid] = {
                groups: allChoicesForAnswerGrouped,
                counts: counts
            };
        });

        console.dir(questionsWithAnswersWithChoices);


        // ... 


        return questionsWithAnswersWithChoices;
    }

    function findRepresentativeMetadata(bidsFromGroup, choicesForPmaidBid) {
        return $.when(
            // getMetadataAnswers(),
            getMetadataChoices(),
            getPidToBidMappingFromCache(),
            getXids(),
            clustersCachePromise).then(function(
                // answersResponse,
                choicesResponse,
                mappings,
                xids,
                foo) {
            // var answers = answersResponse[0];
            var choices = choicesResponse[0];
            // var b2p = mappings.b2p;
            var p2b = mappings.p2b;
            var b2g = getBidToGid();

            return doFindRepresentativeMetadata(choices, p2b, b2g);
        });
    }

    function getXids() {
        return polisGet(xidsPath, {
            conversation_id: conversation_id
        });
    }

    function getXidToPid() {
        return getXids().then(function(items) {
            var x2p = {};
            for (var i = 0; i < items.length; i++) {
                x2p[items[i].xid] = items[i].pid;
            }
            return x2p;
        });
    }
   

    // TODO account for "N/A", "null", etc
    // returns {
    //     info : [ {name: "city", cardinality: 2, type: "string"},...]
    //     rows : [ [data,...],...]
    //     xids : [xid for row 0, xid for row 1, ...]
    // }
    function parseMetadataFromCSV(rawCsvFile) {
       return getXidToPid().then(function(x2p) {
            var notNumberColumns = [];
            var notIntegerColumns = [];
            var valueSets = [];
            var rows = d3.csv.parseRows(rawCsvFile);
            var rowCount = rows.length;
            var colCount = rows[0].length;
            var xidsUnaccounted = {};
            var xidHash = {};

            // Check row lengths
            for (var r = 0; r < rowCount; r++) {
                if (rows[r].length !== colCount) {
                    alert("row length does not match length of first row. (for row number " + r + ")");
                    return;
                }
            }

            // Remove redundant columns (from a SQL join, for example)
            function columnsEqual(a, b) {
                for (var r = 0; r < rowCount; r++) {
                    var row = rows[r];
                    if (row[a] !== row[b]) {
                        return false;
                    }
                }
                return true;
            }
            var duplicateColumns = [];
            for (var c = 0; c < colCount-1; c++) {
                for (var d = c+1; d < colCount; d++) {
                    if (columnsEqual(c, d)) {
                        duplicateColumns.push({
                            name: rows[0][d],
                            col: d
                        });
                    }
                }
            }
            if (duplicateColumns.length) {
                alert('removing duplicate columns: ' + _.pluck(duplicateColumns, "name"));
            }
            // Remove duplicate columns
            for (var r = 0; r < rowCount; r++) {
                var row = rows[r];
                _.each(duplicateColumns, function(c) {
                    row.splice(c.col, 1);
                });
            }
            colCount = rows[0].length;


            // Replace the column names in the 0th row with objects with metadata.
            for (var c = 0; c < colCount; c++) {
                rows[0][c] = {
                    name: rows[0][c],
                    type: "integer", // may be disproven and become "float" or "string"
                    cardinality: 0
                };
            }

            _.each(x2p, function(pid, xid) {
                xidsUnaccounted[xid] = true;
                xidHash[xid] = true;
            });

            var xidsFoundPerColumn = [];
            for (var c = 0; c < colCount; c++) {
                xidsFoundPerColumn[c] = 0;
                valueSets[c] = {};
            }
            // determine xid column
            for (var r = 0; r < rowCount; r++) {
                var row = rows[r];
                if (r > 0) {
                    for (var c = 0; c < colCount; c++) {
                        var cell = row[c];

                        // Determine the columns where the xids are
                        if (xidHash[cell]) {
                            xidsFoundPerColumn[c] += 1;
                        }
                        if (xidsUnaccounted[cell]) {
                            // Mark the xid as seen
                            delete xidsUnaccounted[cell];
                        }
            
                    }
                }
            }

            if (_.size(xidsUnaccounted)) {
                alert("The attached data-source is missing data on participants with these xids: " + xidsUnaccounted.join(" "));
            }

            // Find the Xid Column
            var xidColumn = 0;

            function argMaxForIndexOrKey(items) {
                var max = -Infinity;
                var maxArg = null;
                _.each(items, function(val, arg) {
                    if (val > max) {
                        max = val;
                        maxArg = arg;
                    }
                });
                return {
                    arg: maxArg,
                    max: max,
                };
            }

            var result = argMaxForIndexOrKey(xidsFoundPerColumn);
            var xidColumn = result.arg;
            var maxXidCount = result.max;
            if (maxXidCount === 0) {
                alert("xid column missing, please be sure to include a column with xids");
                return;
            }

            // TODO check xidsUnaccounted within this column only.
            alert("the xid column appears to be called " + rows[0][xidColumn].name);
            
            // Remove extra rows (which have no corresponsing xids)
            rows = _.filter(rows, function(row) {
                var xid = row[xidColumn];
                return !_.isUndefined(x2p[xid]);
            });
            rowCount = rows.length;

            for (var r = 0; r < rowCount; r++) {
                var row = rows[r];
                if (r > 0) {
                    for (var c = 0; c < colCount; c++) {
                        var cell = row[c];
                        // find the cardinality
                        valueSets[c][cell] = true;

                        // determine if the columns can be parsed as numbers
                        if (notNumberColumns[c]) {
                            continue;
                        }
                        var n = parseFloat(cell);
                        var nInt = parseInt(cell);
                        if (isNaN(n)) {
                            notNumberColumns[c] = true;
                            notIntegerColumns[c] = true;
                        } else if (n !== nInt) {
                            notIntegerColumns[c] = true;
                        }
                    }
                }
            }

            // Assign Cardinality
            _.each(valueSets, function(values, c) {
                rows[0][c].cardinality = _.keys(values).length;
            });

            // Assing Types
            _.each(notIntegerColumns, function(isNotInt, c) {
                var isNumber = !notNumberColumns[c];
                if(isNotInt) {
                    if (isNumber) {
                        rows[0][c].type = "float";
                    } else {
                        rows[0][c].type = "string";
                    }
                }
            });

            var hasNumericalColumns = false;
            for (var c = 0; c < colCount; c++) {
                var isNumberColumn = !notNumberColumns[c];
                if (isNumberColumn) {
                    hasNumericalColumns = true;
                    break;
                }
            }
            if (hasNumericalColumns) {
                for (var r = 0; r < rowCount; r++) {
                    var row = rows[r];                            
                    if (r > 0) {
                        for (var c = 0; c < colCount; c++) {
                            if (!notNumberColumns[c]) {
                                row[c] = parseFloat(row[c]);
                                if (isNaN(row[c])) {
                                    alert("expected number for cell with value \"" + row[c] + "\" in column named \"" + rows[0][c].name + "\"");
                                }
                            }
                        }
                    }
                }
            }
            // Remove xid column
            var xids = [];
            for (var r = 0; r < rowCount; r++) {
                var row = rows[r];
                var xid = row.splice(xidColumn, 1)[0];
                xids.push(xid);
            }
            var infoRow = rows.shift();
            xids.shift(); // Remove the info row for the xid column 


            var pids = _.map(xids, function(xid) {
                return x2p[xid];
            });

            var result = {
                info: infoRow,
                rows: rows,
                xids: xids,
                pids: pids
            };
            console.dir(result);
            return result;
        }, function(err) {
            alert(err);
        });
    }

    function fetchLatestPca() {
        return fetchPca(pcaPath, lastServerTokenForPCA);
    }
    function fetchPcaPlaybackByTimestamp(timestamp) {
        return fetchPca(pcaPlaybackPath, timestamp);
    }


    function fetchPca(path, timestamp) {
        return polisGet(path, {
            lastVoteTimestamp: timestamp,
            conversation_id: conversation_id
        }).pipe( function(pcaData, textStatus, xhr) {
                if (304 === xhr.status) {
                    // not nodified
                    firstPcaCallPromise.resolve();
                    return $.Deferred().reject();
                }

                lastServerTokenForPCA = pcaData.lastVoteTimestamp;

                return updateBid().then(function() {

                    // Check for missing comps... TODO solve 
                    if (!pcaData.pca || !pcaData.pca.comps) {
                        console.error("missing comps");
                        return $.Deferred().reject();
                    }
                    var buckets = arraysToObjects(pcaData["base-clusters"]);
                    participantCount = sum(pcaData["base-clusters"].count);
                    repness = pcaData["repness"];
                    // TODO we should include the vectors for each comment (with the comments?)
                    ///commentVectors = pcaData.commentVectors;

                    // TODO this is not runnable, just a rough idea. (data isn't structured like this)
                    ///var people = pcaData.people;

                    eb.trigger(eb.participantCount, participantCount);
                    if (_.isNumber(pcaData.voteCount)) {
                        eb.trigger(eb.voteCount, pcaData.voteCount);
                    }
                    //var myself = _.findWhere(people, {pid: getPid()});
                    //people = _.without(people, myself);
                    //people.push(myself);

                    pcX = pcaData.pca.comps[0];
                    pcY = pcaData.pca.comps[1];
                    centerX = pcaData.pca.center[0] || 0;
                    centerY = pcaData.pca.center[1] || 0;

                    // in case of malformed PCs (seen on conversations with only one comment)
                    pcX = pcX || [];
                    pcY = pcY || [];

                    var votesBase = pcaData["votes-base"];
                    var indexToBid = pcaData["base-clusters"].id;

                    // TEMP hack for bug in data
                    if (!_.isUndefined(votesBase.tid)) {
                        var tid = votesBase.tid
                        votesBase[tid] = {};
                        votesBase[tid].A = votesBase.A;
                        votesBase[tid].D = votesBase.D;
                        delete votesBase.tid;
                        delete votesBase.A;
                        delete votesBase.D;
                    }

                    votesForTidBid = {};
                    var tids = _.map(_.keys(votesBase), Number);
                    _.each(tids, function(tid) {
                        // translate from the compact index format to bid->voteCount format
                        var aOrig = votesBase[tid].A;
                        var dOrig = votesBase[tid].D;
                        var A = {};
                        var D = {};
                        var len = aOrig.length;
                        for (var i = 0; i < len; i++) {
                            A[indexToBid[i]] = aOrig[i];
                            D[indexToBid[i]] = dOrig[i];
                        }
                        votesForTidBid[tid] = {
                            A: A,
                            D: D
                        };
                    });

                    votesForTidBidPromise.resolve(); // NOTE this may already be resolved.



                    var clusters = pcaData["group-clusters"];
                    clusters = _.map(clusters, function(c) {
                        // we just need the members
                        return c.members;
                    });

                    // mutate - move x and y into a proj sub-object, so the vis can animate x and y
                    _.each(buckets, function(b) {
                        b.proj = {
                            x: b.x,
                            y: b.y
                        };
                        delete b.x;
                        delete b.y;
                    });

                    // Convert to Bucket objects.
                    buckets = _.map(buckets, function(b) {
                        return new Bucket(b);
                    });

                    var temp = removeSelfFromBucketsAndClusters(buckets, clusters);
                    buckets = temp.buckets;
                    clustersCache = temp.clusters;

                    projectionPeopleCache = buckets;
                    clustersCachePromise.resolve();

                    buckets = prepProjection(buckets);
                    return null;
                });
            },
            function(xhr) {
                if (404 === xhr.status) {
                    firstPcaCallPromise.resolve();
                } else if (500 === xhr.status) {
                    // alert("failed to get pca data");
                }
            }).then(function() {
                firstPcaCallPromise.resolve();
            });
    }


    function removeItemFromArray(bid, cluster) {
        var index = cluster.indexOf(bid);
        if (index >= 0) {
            cluster = cluster.splice(index, 1);
        }
        return cluster;
    }

    function removeSelfFromBucketsAndClusters(buckets, clusters) {
        for (var b = 0; b < buckets.length; b++) {
            var bucket = buckets[b];
            if (bucket.bid === bid) {
                bucket.count -= 1;
            }
            if (bucket.count <= 0) {
                clusters = _.map(clusters, function(cluster) {
                    removeItemFromArray(bucket.bid, cluster);
                    return cluster;
                });
            }
        }
        return {
            buckets: buckets,
            clusters: clusters
        }
    }

    function arraysToObjects(objWithArraysAsProperties) {
        var objects = [];
        var len = -1;
        for (var k in objWithArraysAsProperties) {
            var nextLen = objWithArraysAsProperties[k].length;
            if (len !== -1 && len !== nextLen) {
                console.error("mismatched lengths");
            }
            len = nextLen;
        }
        for (var i = 0; i < len; i++) {
            var o = {};
            for (var key in objWithArraysAsProperties) {
                o[key] = objWithArraysAsProperties[key][i];
            }
            objects.push(o);
        }
        return objects;
    }

    function withProjectedSelf(people) {
        people = people || [];
        people = _.clone(people); // shallow copy

        people.unshift(bucketizeSelf(projectSelf(), 0));
        // remove empty buckets
        people = _.filter(people, function(bucket) {
            return bucket.count > 0;
        });
        return people;
    }

    function sendUpdatedVisData(people, clusters, participantCount) {
        personUpdateCallbacks.fire(people || [], clusters || [], participantCount);
    }

    function authenticated() {
        return !!tokenStore.get();
    }

    // todo make a separate file for stimulus stuff
    function stories() {
        return [conversation_id];
                //"509c9db2bc1e120000000001",
                //"509c9eddbc1e120000000002",
                //"509c9fd6bc1e120000000003",
                //"509ca042bc1e120000000004"];
    }

    // helper for copy-and-pasted mongo documents
    function ObjectId(s) {
        return s;
    }

    function getCommentsForProjection(params) {
        var ascending = params.sort > 0;
        var count = params.count;
        var projection = params.projection;

        function compare(a,b) {
            if (ascending) {
                return a.projection[projection] - b.projection[projection];
            } else {
                return b.projection[projection] - a.projection[projection];
            }
        }

        var comments;
        return polisGet(pcaPath, {
            lastServerToken: 0,
            conversation_id: conversation_id
        }).pipe( function(pcaData) {
            comments = pcaData.pca.principal_components;
            var keys = _.keys(comments);
            comments = keys.map(function(key) { return {id: key, projection: comments[key]};});
            comments.sort(compare);
            if (count >= 0) {
                comments = comments.slice(0, count);
            }
            return comments;
        }).pipe( function (commentIds) {
            return getComments(commentIds.map(function(comment) { return comment.id; }));
        }).pipe( function (results) {
            // they arrive out of order, so map results onto the array that has the right ordering.
            return comments.map(function(comment) {
                return _.findWhere(results, {tid: comment.id});
            });
        });
    }

    function sum(arrayOfNumbers) {
        var count = 0;
        var len = arrayOfNumbers.length;
        for (var i = 0; i < len; i++) {
            count += arrayOfNumbers[i];
        }
        return count;
    }

    function getFancyComments(options) {
        return $.when(getComments(options), votesForTidBidPromise).then(function(args /* , dont need second arg */) {

            var comments = args[0];
            // don't need args[1], just used as a signal

            // votesForTidBid should be defined since votesForTidBidPromise has resolved.
            return _.map(comments, function(x) {
                // Count the agrees and disagrees for each comment.
                var bidToVote = votesForTidBid[x.tid];
                if (bidToVote) {
                    x.A = sum(_.values(bidToVote.A));
                    x.D = sum(_.values(bidToVote.D));
                } else {
                    x.A = 0;
                    x.D = 0;
                }
                return _.clone(x);
            });
        });
    }

    function getComments(params) {
        params = $.extend({
            conversation_id: conversation_id,
            // not_pid: getPid() // don't want to see own coments
        }, params);
        return polisGet(commentsPath, params);
    }

    function getTidsForGroup(gid, max) {
        var dfd = $.Deferred();
        // delay since clustersCache might not be populated yet.
        $.when(votesForTidBidPromise, clustersCachePromise).done(function()  {

            var tidToR = _.indexBy(repness[gid], "tid");
            var tids = _.pluck(repness[gid], "tid");

            // // Grab stats and turn into list of triples for easier mogrification
            // var tidToStats = groupVoteStats(clustersCache[gid], votesForTidBid);

            // var triples = _.map(tidToStats, function(stats, tid) {
            //     tid = Number(tid);
            //     return [tid, stats.repness, stats.inAgreeProb];
            // });
            
            // // Create a tidToR mapping which is a restriction of the tidToStats to just the repness. This is
            // // what code other than getCommentsForGroup is expecting; if other stuff starts wanting the prob
            // // estimates, we can change the API
            // var tidToR = _.object(_.map(triples, function(t) {return [t[0], t[1]];}));

            // // filter out comments with insufficient repness or agreement probability
            // var filteredTriples = _.filter(triples, function(t) {
            //     return (t[1] > 1.2) & (t[2] > 0.6);
            // });
            // // If nothing is left, just take the single best comment
            // // XXX HACK
            // if (filteredTriples.length == 0) {
            //     triples = [_.max(triples, function(t) {return t[1]})];
            // } else {
            //     // otherwise sort and take max many, if specified
            //     triples = filteredTriples.sort(function(a, b) {return b[1] - a[1];});
            //     if (_.isNumber(max)) {
            //         triples = triples.slice(0, max);
            //     }
            // }
            // // extract tids
            // var tids = _.map(triples, function(t) {
            //     return t[0];
            // });
            // resolve deferred
            dfd.resolve({
                tidToR: tidToR,
                tids: tids
            });
        });
        return dfd.promise();
    }


    function getReactionsToComment(tid) {
        var dfd = $.Deferred();
        var buckets = votesForTidBid[tid];
        // var myVotes = votesByMe.filter(function() { return true; });

//         // Splice my votes in for self group.
//         buckets["self"] = {
//             bid: "self",
// //            ppl: [getPid()],
//             A: _.filter(myVotes, function(v) { return v.vote === polisTypes.reactions.pull; }),
//             D: _.filter(myVotes, function(v) { return v.vote === polisTypes.reactions.push; })
//         };
        // TODO reduce vote count for the bucket self is in.
        if (!buckets) {
            console.warn("no votes found for tid: " + tid);
            buckets = {
                A:[],
                D:[]
            };
        }
        return dfd.resolve(buckets);
    }

    function createConversation(title, body) {
        return polisPost(conversationsPath, {
            title: title,
            body: body
        });
    }

    function getConversations() {
        return polisGet(conversationsPath, {
        });
    }

    function getPid() {
        if (!_.isId(pid)) {
       //     alert("bad pid: " + pid);
        }
        return pid;
    }

    // function doJoinConversation(zinvite) {
    //     var params = {
    //         conversation_id: conversation_id
    //     };
    //     if (zinvite) {
    //         _.extend(params, {
    //             zinvite: zinvite
    //         });
    //     }
    //     return polisPost(participantsPath, params).pipe( function (response) {
    //         pid = response.pid;
    //         return response.pid;
    //     });
    // }

    function queryParticipantsByMetadata(pmaids) {
        return polisPost(queryParticipantsByMetadataPath, {
            pmaids: pmaids,
            conversation_id: conversation_id
        });
    }


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

    function projectSelf() {
        var x = 0;
        var y = 0;
        votesByMe.each(function(v) {
            var vote = v.get("vote");
            var tid = v.get("tid");
            x += vote * (pcX[tid] || 0);
            y += vote * (pcY[tid] || 0);
        });

        x -= centerX;
        y -= centerY;

        return {
            pid : getPid(),
            isBlueDot: true,
            proj: {
                x: x,
                y: y
            }
        };
    }
    function updateMyProjection() {
        console.log("updateMyProjection");
        var people = prepProjection(projectionPeopleCache);
        sendUpdatedVisData(people, clustersCache, participantCount);
    }

    function getPidToBidMappingFromCache() {

        if (lastServerTokenForBidToPid >= lastServerTokenForPCA && lastServerTokenForBidToPid > 0) {
            return $.Deferred().resolve({
                p2b: pidToBidCache,
                b2p: bidToPid,
                bid: bid,
            });
        } else {
            return getPidToBidMapping();
        }
    }

    function getPidToBidMapping() {
        return polisGet(bidToPidPath, {
            lastVoteTimestamp: lastServerTokenForBidToPid, // use the same
            conversation_id: conversation_id
        }).then(function(data, textStatus, xhr) {
            if (304 === xhr.status) {
                return {
                    p2b: pidToBidCache,
                    b2p: bidToPid,
                };
            }
            lastServerTokenForBidToPid = data.lastVoteTimestamp;
            bidToPid = data.bidToPid;

            var b2p = data.bidToPid;
            var p2b = {};
            for (var bid = 0; bid < b2p.length; bid++) {
                var memberPids = b2p[bid];
                for (var i = 0; i < memberPids.length; i++) {
                    var pid = memberPids[i];
                    p2b[pid] = bid;
                }
            }
            pidToBidCache = p2b;

            return {
                p2b: pidToBidCache,
                b2p: bidToPid
            };
        });
    }

    function updateBid() {
        if (demoMode()) {
            bid = 0;
            return $.Deferred().resolve(bid);
        }
        return polisGet(bidPath, {
            lastVoteTimestamp: lastServerTokenForBid, // use the same
            conversation_id: conversation_id
        }).then(function(data, textStatus, xhr) {
            if (304 === xhr.status) {
                // cached
                return bid;
            }
            bid = data.bid;
            lastServerTokenForBid = data.lastVoteTimestamp;
            return bid;
        });
    }

    // function reprojectForSubsetOfComments(projectionPeopleCache) {
    //     var tidSubsetForReprojection = allComments.chain().filter(function(c) {
    //         return !c.get("unchecked");
    //     }).map(function(c) { return c.get("tid");}).value();
    //     if (!tidSubsetForReprojection.length ||  // nothing is selected, just show the original projection.
    //         tidSubsetForReprojection.length === allComments.length // all comments are shown, so just show the original projection.
    //     ) {
    //         return projectionPeopleCache;
    //     }
    //     var tids = tidSubsetForReprojection;
    //     var subset = _.pick(votesForTidBid, tids);
    //     var comments = _.map(subset, function(o, tid) {
    //         var votesFromEachBid = _.clone(o.D); // start with disagrees, since each disagree is a +1, and we want the projection to be oriented the same way as the original projection
    //         var len = o.A.length;
    //         for (var i = 0; i < len; i++) {
    //             // since agrees are -1, we want to subtract for each.
    //             votesFromEachBid[i] -= o.A[i];
    //         }
    //         return {
    //             votes: votesFromEachBid,
    //             tid: Number(tid)
    //         };
    //     });
    //     var buckets = []; // index==bid, [voteForTidAt0, voteForTidAt1, ...]
    //     var len = comments[0].votes.length;
    //     var tids = _.map(_.pluck(comments, "tid"), function(tid) { return Number(tid);});
    //     var tidToIndex = {};
    //     _.each(comments, function(o) {
    //         // Pack the subsets of tids into a dense array.
    //         tidToIndex[o.tid] = tids.indexOf(o.tid);
    //     });
    //     for (var bid = 0; bid < len; bid++) {
    //         buckets[bid] = [];
    //         _.each(comments, function(o) {
    //             var index = tidToIndex[o.tid];
    //             buckets[bid][index] = o.votes[bid];
    //         });
    //     }

    //     var trainingSet = _.map(buckets, function(b) {
    //         return {
    //             input: b,
    //             output: b
    //         };
    //     });

    //     var nn = new brain.NeuralNetwork({
    //         hiddenLayers: [2]
    //     });


    //   nn.runInputLinear = function(input) {
    //     this.outputs[0] = input;  // set output state of input layer

    //     for (var layer = 1; layer <= this.outputLayer; layer++) {
    //       for (var node = 0; node < this.sizes[layer]; node++) {
    //         var weights = this.weights[layer][node];

    //         var sum = this.biases[layer][node];
    //         for (var k = 0; k < weights.length; k++) {
    //           sum += weights[k] * input[k];
    //         }
    //         this.outputs[layer][node] = 0.25 * sum + 0.5;
    //       }
    //       var output = input = this.outputs[layer];
    //     }
    //     return output;
    //   };

    //   nn.runLinear = function(input) {
    //     if (this.inputLookup) {
    //       input = lookup.toArray(this.inputLookup, input);
    //     }

    //     var linearOutput = this.runInputLinear(input);

    //     if (this.outputLookup) {
    //       output = lookup.toHash(this.outputLookup, output);
    //     }
    //     return linearOutput;
    //   };




    //     nn.train(trainingSet, {
    //         errorThresh: 0.004,
    //         learningRate: 0.4,
    //         iterations: 1001,
    //         log: true,
    //         logPeriod: 100
    //     });


    //     /// training done, now project each bucket

    //     // var runDataSigmoid = []
    //     // var runDataLinear = {};

    //     // _.each(buckets, function(b){
    //     //     var tid = b.tid;
    //     //     var votes = b.votes;
    //     //     var run = nn.run(votes);
    //     //     runDataSigmoid.push(nn.outputs[1].slice(0)) // this line... ask colin.
    //     // });

    //     var runDataLinear = _.map(buckets, function(o, bid){
    //         var votes = o;
    //         var runLinear = nn.runLinear(votes)
    //         return nn.outputs[1].slice(0);
    //     });

    //     console.log('The run was successful. Here are the values of the hidden layer for each run: ')
    //     // console.dir(runDataSigmoid)
    //     console.dir(runDataLinear);
    //     reprojected = _.map(projectionPeopleCache, function(o, bid) {
    //         o = _.clone(o);
    //         o.proj = {
    //             x: runDataLinear[bid][0],
    //             y: runDataLinear[bid][1]
    //         };
    //         return o;
    //     });

    //     return reprojected;
    // }

    function addPollingScheduledCallback(f) {
        pollingScheduledCallbacks.push(f);
    }

    function poll() {
      if (!shouldPoll) {
        return;
      }
      var pcaPromise = fetchLatestPca();
      pcaPromise.done(updateMyProjection);
      pcaPromise.done(function() {
        // TODO Trigger based on votes themselves incrementing, not waiting on the PCA.
        // TODO Look into socket.io for notifying that the lastVoteTimestamp has changed.
          _.each(pollingScheduledCallbacks, function(f) {
            f();
          });
      });
    }

    // doJoinConversation(zinvite).then(
    //     initReadyCallbacks.fire,
    //     function(err) {
    //         alert(err);
    //     }
    // );

    function startPolling() {
        setTimeout(poll, 0);
        setInterval(poll, 5000);
    }

    function prepProjection(buckets) {
        // buckets = reprojectForSubsetOfComments(buckets);
        buckets = withProjectedSelf(buckets);
        return buckets;
    }

    function getGroupInfo(gid) {
        if (gid === -1) {
            return {count: 0, votes: {A:[],D:[],gA:0,gD:0}};
        }
        var count = 0;
        if (clustersCache[gid]) {
            _.each(clustersCache[gid], function(bid, gid) {
                var bucket = _.findWhere(projectionPeopleCache, {bid: bid});
                if (!bucket) {
                    console.error('missing bucket for bid: ' + bid);
                } else {
                    count += bucket.count;
                }
            });
        }


        var votesForTidBidWhereVotesOutsideGroupAreZeroed = {};

        // YUK - Checking the state of a promise like this is crappy.
        // TODO refactor so we're pushing the data towards the views, instead
        // of having the views request data in their context method, which leads
        // to asking for things synchronously.
        if(votesForTidBidPromise.state() === "resolved" &&
            clustersCachePromise.state() === "resolved") {

            var group = clustersCache[gid];
            var inGroup = {};
            for (var i = 0; i < group.length; i++) {
                inGroup[group[i]] = true;
            }
            
            votesForTidBidWhereVotesOutsideGroupAreZeroed = {};

            _.each(votesForTidBid, function(bidToVote, tid) {
                var bid;
                var inGroupRef = inGroup; // closure lookup optimization
                var len;


                var gA = mapObj(bidToVote.A, function(vote, bid) {
                    return inGroupRef[bid] ? vote : 0;
                });

                var gD = mapObj(bidToVote.D, function(vote, bid) {
                    return inGroupRef[bid] ? vote : 0;
                });

                votesForTidBidWhereVotesOutsideGroupAreZeroed[tid] = {
                    gA: gA,
                    gD: gD
                };

                votesForTidBidWhereVotesOutsideGroupAreZeroed[tid].gA_total = sum(_.values(votesForTidBidWhereVotesOutsideGroupAreZeroed[tid].gA)),
                votesForTidBidWhereVotesOutsideGroupAreZeroed[tid].gD_total = sum(_.values(votesForTidBidWhereVotesOutsideGroupAreZeroed[tid].gD))
            });
        }

        return {
            count: count,
            repness: repness[gid],
            votes: votesForTidBidWhereVotesOutsideGroupAreZeroed
        };
    }
    
    // findRepresentativeMetadata();

    function stopPolling() {
        shouldPoll = false;
    }

    function jumpTo(lastVoteTimestamp) {
        stopPolling();
        // console.log(lastVoteTimestamp);

        var pcaPromise = fetchPcaPlaybackByTimestamp(lastVoteTimestamp);
        pcaPromise.done(updateMyProjection);
    }

    return {
        authenticated: authenticated,
        getNextComment: getNextComment,
        getCommentsForProjection: getCommentsForProjection,
        getTidsForGroup: getTidsForGroup,
        getGroupInfo: getGroupInfo,
        getFancyComments: getFancyComments,
        getReactionsToComment: getReactionsToComment,
        getPidToBidMapping: getPidToBidMappingFromCache,
        disagree: disagree,
        agree: agree,
        pass: pass,
        trash: trash,
        star: star,
        unstar: unstar,
        stories: stories,
        invite: invite,
        queryParticipantsByMetadata: queryParticipantsByMetadata,
        syncAllCommentsForCurrentStimulus: syncAllCommentsForCurrentStimulus,
        addInitReadyListener: initReadyCallbacks.add,
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        removePersonUpdateListener: personUpdateCallbacks.remove,
        addPersonUpdateListener: function() {
            personUpdateCallbacks.add.apply(personUpdateCallbacks, arguments);

            firstPcaCallPromise.then(function() {
                var buckets = prepProjection(projectionPeopleCache);
                if (buckets.length) {
                    sendUpdatedVisData(buckets, clustersCache, participantCount);
                }
            });
        },
        addCommentsAvailableListener: commentsAvailableCallbacks.add,
        //addModeChangeEventListener: addModeChangeEventListener,
        //getLatestEvents: getLatestEvents,

        createConversation: createConversation,
        getConversations: getConversations,

        findRepresentativeMetadata: findRepresentativeMetadata,
        parseMetadataFromCSV: parseMetadataFromCSV,

        updateMyProjection: updateMyProjection,

        startPolling: startPolling,
        // simple way to centralize polling actions, and ensure they happen near each-other (to save battery)
        addPollingScheduledCallback: addPollingScheduledCallback,

        jumpTo: jumpTo,
        submitComment: submitComment
    };
};
