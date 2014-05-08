var eb = require("../eventBus");
var metric = require("../util/metric");
var Utils = require("../util/utils")
var shuffleWithSeed = require("../util/shuffleWithSeed");
var brain = require("brain");




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

    var protocol = params.protocol || "https";
    var domain = params.domain;
    var basePath = params.basePath;

    var votesPath = "/v3/votes";
    var starsPath = "/v3/stars";
    var trashesPath = "/v3/trashes";
    var commentsPath = "/v3/comments";
    var feedbackPath = "/v2/feedback";

    var createAccountPath = "/v3/auth/new";
    var loginPath = "/v3/auth/login";
    var deregisterPath = "/v3/auth/deregister";
    var pcaPath = "/v3/math/pca";
    var bidToPidPath = "/v3/bidToPid";
    var bidPath = "/v3/bid";
    var selectionPath = "/v3/selection";

    var conversationsPath = "/v3/conversations";
    var participantsPath = "/v3/participants";

    var queryParticipantsByMetadataPath = "/v3/query_participants_by_metadata";

    var commentVelocitiesPath = "/v3/velocities";

    var logger = params.logger;

    var lastServerTokenForPCA = 0;
    var lastServerTokenForComments = 0;
    var lastServerTokenForBid = 0;
    var lastServerTokenForBidToPid = 0;

    var initReadyCallbacks = $.Callbacks();
    var authStateChangeCallbacks = $.Callbacks();
    var personUpdateCallbacks = $.Callbacks();
    var commentsAvailableCallbacks = $.Callbacks();

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
    var repness = {}; // gid -> tid -> representativeness (bigger is more representative)
    var votesForTidBid = {}; // tid -> bid -> {A: agree count, B: disagree count}
    var participantCount = 0;
    var bidToPid = [];
    var pidToBidCache = null;
    var bid;

    var pollingScheduledCallbacks = [];

    var tokenStore = params.tokenStore;
    var uidStore = params.uidStore;

    var needAuthCallbacks = $.Callbacks();

    var zid = params.zid;
    var zinvite = params.zinvite;
    var pid = params.pid;

    var means = null; // TODO move clustering into a separate file

    var BUCKETIZE_THRESH = 64;
    var BUCKETIZE_ROWS = 8;
    var BUCKETIZE_COLUMNS = 8;

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
            zid: zid
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

    function getNextComment() {
        var dfd = $.Deferred();

        var index;
        var numComments = getNumComments();
        if (numComments > 0) {
            // Pick a random comment
            index = _.shuffle(_.keys(commentsToVoteOn)).pop();
            dfd.resolve(commentsToVoteOn[index]);
        } else {
            // return the number of votes user has done.
            // This is useful to know if there are no
            // comments because the user is done voting,
            // or if there aren't any comments available yet.
            dfd.reject(votesByMe.size());
        }
        return dfd.promise();
    }

    function submitComment(model) {


        // CAUTION - possibly dead code, comments are submitted through backbone


        if (demoMode()) {
            return $.Deferred().resolve();
        }

        model = $.extend(model, {
            // server will find the pid
            zid: zid
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

    function react(params) {
        if (params.zid && params.zid !== zid) {
            if (params.vote !== polisTypes.reactions.see) {
                console.error("wrong stimulus");
            }
        }
        if (typeof params.tid === "undefined") {
            console.error("missing tid");
            console.error(params);
        }
        if (demoMode()) {
            return $.Deferred().resolve();
        }
        return polisPost(votesPath, $.extend({}, params, {
                // server will find the pid
                zid: zid
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
            zid: zid
        });
    }

    function doStarAction(params) {
        if (params.zid && params.zid !== zid) {
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
                zid: zid
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
            zid: zid
        });
    }

    function invite(xids) {
        return polisPost("/v3/users/invite", {
            single_use_tokens: true,
            zid: zid,
            xids: xids
        });
    }

    function polisPost(api, data) {
        setTimeout(function() {
            metric("post", api);
        });
        return polisAjax(api, data, "POST");
    }

    function polisGet(api, data) {
        var shouldUploadMetric = [commentsPath, pcaPath].indexOf(api) < 0;
        if (shouldUploadMetric) {
            setTimeout(function() {
                metric("get", api);
            });
        }
        return polisAjax(api, data, "GET");
    }

    function polisAjax(api, data, type) {
        if (!_.isString(api)) {
            throw "api param should be a string";
        }

        var url = protocol + "://"+ domain + basePath + api;

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

            metric("ajaxError", api, jqXHR.status);

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

   
 function computeRepness(bidsFromGroup, votesForTidBid) {
        var repness = {};

        var inCluster = {};
        _.each(bidsFromGroup, function(bid) {
            inCluster[bid] = true;
        });
        repness = {};
        _.each(votesForTidBid, function(bidToVote, tid) {
            tid = Number(tid);
            var inAgree = 1;
            var inDisagree = 1;
            var outAgree = 1;
            var outDisagree = 1;
            var len = bidToVote.A.length;
            if (bidToVote.D.length !== len) {
                console.error('mismatch');
            }
            for (var bid = 0; bid < len; bid++) {
                if (inCluster[bid]) {
                    inAgree += bidToVote.A[bid];
                    inDisagree += bidToVote.D[bid];
                } else {
                    outAgree += bidToVote.A[bid];
                    outDisagree += bidToVote.D[bid];
                }
            }
            // var totalVotes = inAgree + inDisagree + outAgree + outDisagree;
            var repnessValue = (inAgree / (inDisagree)) / (outAgree/(outDisagree));
            // since inAgree was padded, remove padding and multiply again.            
            // Agreement within the group is super important, so let's multiply it in there twice.
            repnessValue *= inAgree - 1;
            repness[tid] = repnessValue;
        });

        return repness;
    }

    function fetchPca() {
        return polisGet(pcaPath, {
            lastVoteTimestamp: lastServerTokenForPCA,
            zid: zid
        }).pipe( function(pcaData, textStatus, xhr) {
                if (304 === xhr.status) {
                    // not nodified
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

                    // TODO we should include the vectors for each comment (with the comments?)
                    ///commentVectors = pcaData.commentVectors;

                    // TODO this is not runnable, just a rough idea. (data isn't structured like this)
                    ///var people = pcaData.people;

                    participantCount = _.reduce(buckets, function(memo, b) { return memo + b.count;}, 0);

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

                    votesForTidBid = pcaData["votes-base"];
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

                    buckets = removeSelfFromBuckets(buckets);

                    projectionPeopleCache = buckets;
                    clustersCache = clusters;
                    clustersCachePromise.resolve();

                    buckets = prepProjection(buckets);
                    return null;
                });
            },
            function(err) {
                console.error("failed to get pca data");
            });
    }



    function removeSelfFromBuckets(buckets) {
        return _.map(buckets, function(b) {
            if (b.bid === bid) {
                b.count -= 1;
            }
            return b;
        });
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

    function sendUpdatedVisData(people, clusters) {
        personUpdateCallbacks.fire(people || [], clusters || []);
    }

    function authenticated() {
        return !!tokenStore.get();
    }

    // todo make a separate file for stimulus stuff
    function stories() {
        return [zid];
                //"509c9db2bc1e120000000001",
                //"509c9eddbc1e120000000002",
                //"509c9fd6bc1e120000000003",
                //"509ca042bc1e120000000004"];
    }

    function submitFeedback(data) {
        data = $.extend({}, data, {
            zid: zid,
            type: "feedback"
        });
        return polisPost(feedbackPath, {
            events: [data]
        });
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
            zid: zid
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
        return _.reduce(arrayOfNumbers, function(total, x) { return total+x; }, 0);
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
                    x.A = sum(bidToVote.A);
                    x.D = sum(bidToVote.D);
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
            zid: zid,
            // not_pid: getPid() // don't want to see own coments
        }, params);
        return polisGet(commentsPath, params);
    }

    function getTidsForGroup(gid, max) {
        var dfd = $.Deferred();
        // delay since clustersCache might not be populated yet.
        $.when(votesForTidBidPromise, clustersCachePromise).done(function()  {
            var tidToR = computeRepness(clustersCache[gid], votesForTidBid);
            var tids;
            if (_.isNumber(max)) {
                // keep the tids with the highest repness.
                var pairs = _.map(tidToR, function(repness, tid) {
                    tid = Number(tid);
                    return [repness, tid];
                });
                pairs = pairs.sort(function(a, b) {return b[0] - a[0];});
                pairs = pairs.slice(0, max);
                tids = _.map(pairs, function(p) {
                    return p[1];
                });
            } else {
                // keep all tids
                // (this impl is wasteful)
                tids = _.map(tidToR, function(repness, tid) {
                    return Number(tid);
                });
            }
            dfd.resolve({
                tidToR: tidToR,
                tids: tids
            });
        });
        return dfd.promise();
    }

    function getCommentsForGroup(gid, max) {
        var tidToR;
        return getTidsForGroup(gid, max).then(function(o) {
                tidToR = o.tidToR;
                delete o.tidToR;
                return getComments(o);
            }).then(function(comments) {
            comments = _.map(comments, function(c) {
                c.repness = tidToR[c.tid];
                return c;
            });
            comments = comments.sort(function(a, b) {
                return b.repness - a.repness;
            });
            return comments;
        });
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
    //         zid: zid
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
            zid: zid
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
    DD.prototype.g = DA.prototype.s = function(k,v) {
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
        sendUpdatedVisData(people, clustersCache);
    }

    function getPidToBidMappingFromCache() {

        if (lastServerTokenForBidToPid >= lastServerTokenForPCA) {
            return new Promise.resolve({
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
            zid: zid
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
            zid: zid
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
      var pcaPromise = fetchPca();
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

    return {
        authenticated: authenticated,
        getNextComment: getNextComment,
        getCommentsForProjection: getCommentsForProjection,
        getCommentsForGroup: getCommentsForGroup,
        getTidsForGroup: getTidsForGroup,
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

            var buckets = prepProjection(projectionPeopleCache);
            sendUpdatedVisData(buckets, clustersCache);
        },
        addCommentsAvailableListener: commentsAvailableCallbacks.add,
        //addModeChangeEventListener: addModeChangeEventListener,
        //getLatestEvents: getLatestEvents,

        createConversation: createConversation,
        getConversations: getConversations,

        updateMyProjection: updateMyProjection,

        startPolling: startPolling,
        // simple way to centralize polling actions, and ensure they happen near each-other (to save battery)
        addPollingScheduledCallback: addPollingScheduledCallback,

        submitFeedback: submitFeedback,
        submitComment: submitComment
    };
};
