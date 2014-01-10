define([
    "util/shuffleWithSeed"
], function(
    shuffleWithSeed
) {

return function(params) {

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
    var votesByMePath = "/v3/votes/me";
    var commentsPath = "/v3/comments";
    var feedbackPath = "/v2/feedback";

    var createAccountPath = "/v3/auth/new";
    var loginPath = "/v3/auth/login";
    var deregisterPath = "/v3/auth/deregister";
    var pcaPath = "/v3/math/pca";
    var selectionPath = "/v3/selection";

    var conversationsPath = "/v3/conversations";
    var participantsPath = "/v3/participants";

    var queryParticipantsByMetadataPath = "/v3/query_participants_by_metadata";

    var commentVelocitiesPath = "/v3/velocities";

    var logger = params.logger;

    var lastServerTokenForPCA = 0;
    var lastServerTokenForComments = 0;
    var lastServerTokenForVotes = 0;

    var initReadyCallbacks = $.Callbacks();
    var authStateChangeCallbacks = $.Callbacks();
    var personUpdateCallbacks = $.Callbacks();
    var commentsAvailableCallbacks = $.Callbacks();

    var projectionPeopleCache;
    var clustersCache;

    var participantCount = 0;
    var userInfoCache = [];

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

    // TODO if we decide to do manifest the chain of comments in a discussion, then we might want discussionClients that spawn discussionClients..?
    // Err... I guess discussions can be circular.
    //function discussionClient(params)

    // TODO rename
    function syncAllCommentsForCurrentStimulus(optionalStimulusId) { // more like sync?
        var dfd = $.Deferred();
        var params = {
            lastServerToken: (new Date(0)).getTime(),
            not_pid: getPid(), // don't want to see own coments
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
                    commentsToVoteOn[newComments[i].tid] = newComments[i];
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
            dfd.reject(null);
        }
        return dfd.promise();
    }

    function submitComment(model) {
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

    // optionalSpecificSubStimulus (aka commentId)
    function see(optionalSpecificSubStimulus) {
        var ev = {
            vote: polisTypes.reactions.see
        };
        if (optionalSpecificSubStimulus) {
            ev.tid = optionalSpecificSubStimulus;
        }
        return react(ev);
    }


    // optionalSpecificSubStimulus (aka commentId)
    function pass(optionalSpecificSubStimulus) {
        var ev = {
            vote: polisTypes.reactions.pass
        };
        if (optionalSpecificSubStimulus) {
            ev.tid = optionalSpecificSubStimulus;
        }
        if (ev.tid) {
            clearComment(ev.tid);
        }
        return react(ev);
    }

    function trash(tid) {
        clearComment(tid, "trash");
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

    function Bucket(people) {
        this.ppl = _.isArray(people) ? people : [];
        this.data = {};
        this.data.projection = [];
    }
    function average(items, getter) {
        var avg = 0;
        for (var i = 0; i < items.length; i++) {
            avg += getter(items[i]);
        }
        return avg / items.length;
    }
    function getX(person) {
        return person.data.projection[0];
    }

    function getY(person) {
        return person.data.projection[1];
    }
    Bucket.prototype.update = function() {
        this.data.projection[0] = average(this.ppl, getX);
        this.data.projection[1] = average(this.ppl, getY);
    };

    function bucketize(people) {

        return people.map(function(p) {
            var b = new Bucket();
            b.ppl.push(p);
            b.update();
            return b;
        });
    }
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

    function clientSideBaseCluster(people, N) {
        if (!N) { alert("need N"); }
        if (!means) {
            means = shuffleWithSeed(people, 0.5);
            means = _.first(means, N);
            means = means.map(function(person) { return _.clone(person.data.projection);});
        }

        var clusters = means.map(function() { return [];});

        function getNearestMean(person) {
            var best = Infinity;
            var bestMean = means[0];
            var bestIndex = -1;
            for (var mi = 0; mi < means.length; mi++) {
                var m = means[mi];
                var totalSquares = 0;
                var temp;
                for (var i = 0; i < person.data.projection.length; i++) {
                    temp = person.data.projection[i] - m[i];
                    totalSquares += temp*temp;
                }
                if (totalSquares < best) {
                    best = totalSquares;
                    bestMean = m;
                    bestIndex = mi;
                }
            }
            return bestIndex;
        }

        function assignToCluster(person) {
            var bestIndex = getNearestMean(person);
            if (bestIndex === -1) {
                console.log("bad bestIndex, check getNearestMean");
                return;
            }
            if (-1 !== clusters[bestIndex].indexOf(person)) {
                return;
            }
            clusters = _.without(clusters, person);
            clusters[bestIndex].push(person);
        }

        function recenterCluster(i) {
            var cluster = clusters[i];
            if (cluster.length === 0) {
                return;
            }
            var person0 = cluster[0];
            var dims = person0.data.projection.length;
            var totals = Array.apply(null, new Array(dims)).map(Number.prototype.valueOf,0); // array of 0s
            for (var pi = 0; pi < cluster.length; pi++) {
                var person = cluster[pi];
                for (var d = 0; d < dims; d++) {
                    totals[d] += person.data.projection[d];
                }
            }
            var avg = totals.map(function(x) { return x / cluster.length;});
            means[i] = avg;
        }

        //function findClusterVariance(i) {
            //var cluster = clusters[i];
            //for (var pi = 0; pi < clusters.length; pi++) {
            //}
        //}

        function iterate() {
            _.each(people, assignToCluster);
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
            return cluster.map(function(person) {
                return person.pid;
            }).sort(function(a, b) {
                // ascending
                return a - b;
            });
        });
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

                // TODO we should include the vectors for each comment (with the comments?)
                ///commentVectors = pcaData.commentVectors;

                // TODO this is not runnable, just a rough idea. (data isn't structured like this)
                ///var people = pcaData.people;
                var people = parseFormat2(pcaData);
                participantCount = people.length;
                //var myself = _.findWhere(people, {pid: getPid()});
                //people = _.without(people, myself);
                //people.push(myself);
                if (!people) {
                    return $.Deferred().reject();
                }
                people = bucketize(people);
                var clusters = clientSideBaseCluster(people, 3);

                //var pcaComponents = parseTree(pcaData.pca_components);

                //for (var i = 0; i < people.length; i++) {
                    //var person = people[i];

                    /*
                    if (isPersonNode(person)) {
                        if (Math.random() < 0.05) {
                            person.data.projection[0] += 0.01*(Math.random()-0.5);
                            person.data.projection[1] += 0.01*(Math.random()-0.5);
                        }
                    }
                    */

                    //personUpdateCallbacks.fire(person);
                //}
                projectionPeopleCache = people;
                clustersCache = clusters;
                sendUpdatedVisData(people, clusters);
                return $.Deferred().resolve();
            },
            function(err) {
                console.error("failed to get pca data");
            });
    }

    function sendUpdatedVisData(people, clusters) {
        personUpdateCallbacks.fire(people, clusters);
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

    function parseFormat2(obj) {
        // Normalize to [-1,1]
        function normalize(projectionDimension) {
            return projectionDimension / 20;
        }

        if (obj.pca && obj.pca.cluster_tree) {
            console.warn("got old PCA format");
            return;
        }

        var nodes = [];
        for (var i = 0; i < obj.pca.projs.pc1.length; i++) {
            nodes.push({
                pid: Number(obj.pca.projs.ptpt_id[i]), // this can be removed/changed to ptpt_id once we are on an integer id system
                data: {
                    projection: [
                        obj.pca.projs.pc1[i],
                        obj.pca.projs.pc2[i]
                    ].map(normalize)
                }
            });
        }
        return nodes;
    }
    function parseTree(treeObject) {
        var tree = Arboreal.parse(treeObject, "children");

        // Normalize to [-1,1]
        function normalize(projectionDimension) {
            return projectionDimension / 6;
        }
        tree.traverseDown(function(n) {
            if (n.data.projection) {
                n.data.projection = n.data.projection.map(normalize);
            }
        });

        return tree.toArray();
    }

    function getAllUserInfo() {
        return polisGet(participantsPath, {
            zid: zid
        });
    }

    function fetchUserInfoIfNeeded() {
        if (participantCount > userInfoCache.length) {
            updateUserInfoCache();
        }
    }

    function updateUserInfoCache() {
        getAllUserInfo().done(function(data) {
            userInfoCache = data;
        });
    }

    function getUserInfoByPidSync(pid) {
        return userInfoCache[pid];
    }

    function getUserInfoByPid(pid) {
        return polisGet(participantsPath, {
            pid: pid,
            zid: zid
        });
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

    function getComments(params) {
        params = $.extend({
            zid: zid,
            not_pid: getPid() // don't want to see own coments
        }, params);
        return polisGet(commentsPath, params);
    }

    function getCommentsForSelection(listOfUserIds) {
        var params =  {
            zid: zid
        };
        if (listOfUserIds && listOfUserIds.length) {
            params.users = listOfUserIds.join(",");
        }
        return polisGet(selectionPath, params);
    }

    function getReactionsToComment(commentId) {
        return polisGet(votesPath, {
            zid: zid,
            tid: commentId
        });
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
            alert("bad pid: " + pid);
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


    // Doesn't scale obviously
    // DD<pid, Array<index:tid, values:vote>>
    var arrayPidToArrayTidToVote = new DA(emptyArray);

    function getLatestVotes() {
        return polisGet(votesPath, {
            lastVoteTimestamp: lastServerTokenForVotes,
            zid: zid
        }).done(function(data) {
            // assuming ordered by created, so clobbering old vote values
            for (var i = 0; i < data.length; i++) {
                var v = data[i];
                arrayPidToArrayTidToVote.g(v.pid)[v.tid] = v.vote;
                lastServerTokenForVotes = Math.max(v.created, lastServerTokenForVotes);
            }
        });
    }

    function getTotalVotesByPidSync(pid) {
        return arrayPidToArrayTidToVote.g(pid).length;
    }

    function poll() {
      var pcaPromise = fetchPca();
      pcaPromise.done(getLatestVotes);
      pcaPromise.done(fetchUserInfoIfNeeded, fetchUserInfoIfNeeded);
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

    return {
        authenticated: authenticated,
        getNextComment: getNextComment,
        getCommentsForProjection: getCommentsForProjection,
        getCommentsForSelection: getCommentsForSelection,
        getReactionsToComment: getReactionsToComment,
        getUserInfoByPid: getUserInfoByPid,
        getUserInfoByPidSync: getUserInfoByPidSync,
        getTotalVotesByPidSync: getTotalVotesByPidSync,
        disagree: disagree,
        agree: agree,
        pass: pass,
        trash: trash,
        star: star,
        unstar: unstar,
        //see: see,
        stories: stories,
        queryParticipantsByMetadata: queryParticipantsByMetadata,
        syncAllCommentsForCurrentStimulus: syncAllCommentsForCurrentStimulus,
        addInitReadyListener: initReadyCallbacks.add,
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        removePersonUpdateListener: personUpdateCallbacks.remove,
        addPersonUpdateListener: function() {
            personUpdateCallbacks.add.apply(personUpdateCallbacks, arguments);
            if (projectionPeopleCache && clustersCache) {
                sendUpdatedVisData(projectionPeopleCache, clustersCache);
            }
        },
        addCommentsAvailableListener: commentsAvailableCallbacks.add,
        //addModeChangeEventListener: addModeChangeEventListener,
        //getLatestEvents: getLatestEvents,

        createConversation: createConversation,
        getConversations: getConversations,

        startPolling: startPolling,

        submitFeedback: submitFeedback,
        submitComment: submitComment
    };
};
});
