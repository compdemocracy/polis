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

    var protocol = params.protocol || "http";
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

    var logger = params.logger;

    var lastServerTokenForPCA = (new Date(0)).getTime();
    var lastServerTokenForComments = (new Date(0)).getTime();

    var authStateChangeCallbacks = $.Callbacks();
    var personUpdateCallbacks = $.Callbacks();
    var commentsAvailableCallbacks = $.Callbacks();

    var projectionPeopleCache;
    var clustersCache;

    var participantCount = 0;
    var userInfoCache = [];

    var usernameStore = params.usernameStore;
    var tokenStore = params.tokenStore;
    var emailStore = params.emailStore;
    var pidStore = params.pidStore;
    var uidStore = params.uidStore;
    var authStores = [tokenStore, usernameStore, emailStore, uidStore, pidStore];
    function clearAuthStores() {
        authStores.forEach(function(x) {
            x.clear();
        });
    }

    var needAuthCallbacks = $.Callbacks();

    var currentStimulusId;

    var means = null; // TODO move clustering into a separate file

    // TODO if we decide to do manifest the chain of comments in a discussion, then we might want discussionClients that spawn discussionClients..?
    // Err... I guess discussions can be circular.
    //function discussionClient(params)

    // TODO rename
    function syncAllCommentsForCurrentStimulus(optionalStimulusId) { // more like sync?
        var stim = Number(optionalStimulusId) || currentStimulusId;
        var dfd = $.Deferred();
        var params = {
            lastServerToken: (new Date(0)).getTime(),
            not_pid: getPid(), // don't want to see own coments
            not_voted_by_pid: getPid(),
            zid: stim
            //?
        };
        polisGet(commentsPath, params).then( function(comments) {
            if (!comments) {
                logger.log("no new comments for stimulus");
                dfd.resolve(0);
            } else {
                var IDs = _.pluck(comments, "tid");
                var oldkeys = _.keys(commentsToVoteOn).map(
                    function(tid) {
                        return parseInt(tid, 10);
                    }
                );
                var newIDs = _.difference(IDs, oldkeys);
                comments.forEach(function(ev) {
                    var d = new Date(ev.created);
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
                    dfd.reject(0);
                }
            }
        }, function(err) {
            logger.error("failed to fetch comments for " + stim);
            logger.dir(err);
            dfd.reject(0);
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
            pid: getPid(),
            zid: currentStimulusId
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
        if (params.zid && params.zid !== currentStimulusId) {
            if (params.vote !== polisTypes.reactions.see) {
                console.error("wrong stimulus");
            }
        }
        if (typeof params.tid === "undefined") {
            console.error("missing tid");
            console.error(params);
        }

        return polisPost(votesPath, $.extend({}, params, {
                pid: getPid(),
                zid: currentStimulusId
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
            pid: getPid(),
            tid: tid,
            trashed: 1,
            zid: currentStimulusId
        });
    }

    function doStarAction(params) {
        if (params.zid && params.zid !== currentStimulusId) {
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
                pid: getPid(),
                zid: currentStimulusId
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
            crossDomain: true,
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

    function observeStimulus(newStimulusId, zinvite) {
        currentStimulusId = Number(newStimulusId);
        lastServerTokenForPCA = (new Date(0)).getTime();
        lastServerTokenForComments = (new Date(0)).getTime();
        return joinConversation(zinvite);
    }

    function authNew(params) {
        if (!params.anon) {
            if (!params.password) { return $.Deferred().reject("need password"); }
            if (!params.username && !params.email) { return $.Deferred().reject("need username or email"); }
        }
        return polisPost(createAccountPath, params).done( function(authData) {

            clearAuthStores();
            var temporary = !params.rememberMe;
            tokenStore.set(authData.token, temporary);
            if (params.username) {
                usernameStore.set(params.username, temporary);
            }
            if (authData.uid) {
                uidStore.set(authData.uid, temporary);
            }
            if (params.email) {
                emailStore.set(params.email, temporary);
            }
            authStateChangeCallbacks.fire(assemble({
                email: params.email,
                person_id: params.u,
                username: params.username,
                state: "p_registered"
            }));
        });//.then(logger.log, logger.error);
    }

    function authLogin(params) {
        if (!params.password) { return $.Deferred().reject("need password"); }
        if (!params.username && !params.email) { return $.Deferred().reject("need username or email"); }
        return polisPost(loginPath, params).done( function(authData) {
            clearAuthStores();
            var temporary = !params.rememberMe;
            tokenStore.set(authData.token, temporary);
            if (params.username) {
                usernameStore.set(params.username, temporary);
            }
            if (authData.uid) {
                uidStore.set(authData.uid, temporary);
            }
            if (params.email) {
                emailStore.set(params.email, temporary);
            }
            authStateChangeCallbacks.fire(assemble({
                email: params.email,
                person_id: params.uid,
                username: params.username,
                state: "p_registered"
            }));
        });//.then(logger.log, logger.error);
    }

    function authDeregisterClientOnly() {
        clearAuthStores();
    }

    function authDeregister() {
        return polisPost(deregisterPath).always( function() {
            clearAuthStores();
            authStateChangeCallbacks.fire(assemble({
                state: "p_deregistered"
            }));
        });
    }

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
        // [[1,5,2],[4]]
        return clusters.map(function(cluster) {
            return cluster.map(function(person) {
                return person.pid;
            });
        });
    }

    function getPca() {
        return polisGet(pcaPath, {
            lastVoteTimestamp: lastServerTokenForPCA,
            zid: currentStimulusId
        }).pipe( function(pcaData, textStatus, xhr) {
                if (304 === xhr.status) {
                    // not nodified
                    return;
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
                var clusters = clientSideBaseCluster(people, 3);
                //people.push(myself);
                if (!people) {
                    return;
                }

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
        return [currentStimulusId];
                //"509c9db2bc1e120000000001",
                //"509c9eddbc1e120000000002",
                //"509c9fd6bc1e120000000003",
                //"509ca042bc1e120000000004"];
    }

    function submitFeedback(data) {
        data = $.extend({}, data, {
            zid: currentStimulusId,
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
            zid: currentStimulusId
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
            zid: currentStimulusId
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
            zid: currentStimulusId
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

    function getComments(ids) {
        return polisGet(commentsPath, {
            not_pid: getPid(), // don't want to see own coments
            ids: ids.join(",")
        });
    }

    function getCommentsForSelection(listOfUserIds) {
        return polisGet(selectionPath, {
            zid: currentStimulusId,
            users: listOfUserIds.join(",")
        });
    }

    function getReactionsToComment(commentId) {
        return polisGet(votesPath, {
            zid: currentStimulusId,
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
        return pidStore.get(currentStimulusId);
    }

    function joinConversation(zinvite) {
        var params = {
            zid: currentStimulusId
        };
        if (zinvite) {
            _.extend(params, {
                zinvite: zinvite
            });
        }
        return polisPost(participantsPath, params).pipe( function (response) {
            pidStore.set(currentStimulusId, response.pid);
            return response.pid;
        });
    }

    function queryParticipantsByMetadata(pmaids) {
        return polisPost(queryParticipantsByMetadataPath, {
            pmaids: pmaids,
            zid: currentStimulusId
        });
    }

    setTimeout(getPca,0);
    setInterval(function() {
        getPca().then(
            fetchUserInfoIfNeeded,
            fetchUserInfoIfNeeded);
    }, 5000);

    return {
        authenticated: authenticated,
        authNew: authNew,
        authLogin: authLogin,
        authDeregister: authDeregister,
        authDeregisterClientOnly: authDeregisterClientOnly,
        getNextComment: getNextComment,
        getCommentsForProjection: getCommentsForProjection,
        getCommentsForSelection: getCommentsForSelection,
        getReactionsToComment: getReactionsToComment,
        getUserInfoByPid: getUserInfoByPid,
        getUserInfoByPidSync: getUserInfoByPidSync,
        observeStimulus: observeStimulus, // with no args
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

        joinConversation: joinConversation,

        submitFeedback: submitFeedback,
        submitComment: submitComment
    };
};
});
