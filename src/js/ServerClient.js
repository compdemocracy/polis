var ServerClient = function(params) {

    var polisTypes = {
        reactions: {
            push: 1,
            pull: -1,
            pass: 0,
            see: 'see'
        }
    };

    // stimulusId -> Lawnchair of comments
    var commentStores = {};
    function getCommentStore(optionalStimulusId) {
        var stim = optionalStimulusId || currentStimulusId;
        if (undefined === commentStores[stim]) {
            commentStores[stim] = new Lawnchair({
                name: 'v2_comments_' + stim
            }, function() {
                console.log('lawnchair for '+ stim +' ready'); // TODO make 'this' available to the module manager to prevent race conditions
            });
        }
        return commentStores[stim];
    }

    function clearDb() {
        for (var name in commentStores) {
            commentStores[name].nuke();
        }
    }

    var protocol = params.protocol;
    var domain = params.domain;
    var basePath = params.basePath;

    var reactionsPath = "/v2/reactions";
    var reactionsByMePath = "/v2/reactions/me";
    var txtPath = "/v2/txt";
    var feedbackPath = "/v2/feedback";
    var eventPath  = "/v2/ev";

    var createAccountPath = "/v2/auth/new";
    var loginPath = "/v2/auth/login";
    var deregisterPath = "/v2/auth/deregister";
    var pcaPath = "/v2/math/pca";

    var authenticatedCalls = [reactionsByMePath, reactionsPath, txtPath, deregisterPath];

    var logger = params.logger;

    var lastServerTokenForPCA = "";
    var lastServerTokenForComments = "";

    var authStateChangeCallbacks = $.Callbacks();
    var personUpdateCallbacks = $.Callbacks();
    var commentsAvailableCallbacks = $.Callbacks();

    var reactionsByMeStore = params.reactionsByMeStore;
    var usernameStore = params.usernameStore;
    var personIdStore = params.personIdStore;
    var tokenStore = params.tokenStore;
    var emailStore = params.emailStore;
    var authStores = [tokenStore, usernameStore, emailStore, personIdStore];
    function clearAuthStores() {
        authStores.forEach(function(x) {
            x.clear();
        });
    }

    var needAuthCallbacks = $.Callbacks();

    var currentStimulusId;

    var comments = [];
    var users = [];

    // TODO if we decide to do manifest the chain of comments in a discussion, then we might want discussionClients that spawn discussionClients..?
    // Err... I guess discussions can be circular.
    //function discussionClient(params)

    function makeEmptyComment() {
        return {
            s: currentStimulusId,
            _id: "",
            txt: "There are no more comments for this story."
        };
    }
    
    function isValidCommentId(commentId) {
        return isNumber(commentId);
    }

    function getAllReactionsForSelf(optionalStimulusId) {
        var dfd = $.Deferred();
        var stim = optionalStimulusId || currentStimulusId;
        var params = {
            s: stim
        };
        polisGet(reactionsByMePath, params).done( function(data) {
            var reactions = data.events;
            if (!reactions) {
                logger.log('no comments for stimulus');
                dfd.resolve(0);
                return;
            } 
            reactions.forEach(function(r) {
                markReaction(r.to, r.type, stim);
            });
            dfd.resolve();
        }, dfd.reject);
        return dfd.promise();
    }

    // TODO rename
    function syncAllCommentsForCurrentStimulus(optionalStimulusId) { // more like sync?
        var stim = optionalStimulusId || currentStimulusId;
        var dfd = $.Deferred();
        var params = {
            lastServerToken: lastServerTokenForComments,
            s: stim
            //?
        };
        polisGet(txtPath, params).then( function(data) {
                var evs = data && data.events;
                if (!evs) {
                    logger.log('no new comments for stimulus');
                    dfd.resolve(0);
                } else {
                    var IDs = _.pluck(evs, "_id");
                    var commentStore = getCommentStore(stim);
                    commentStore.keys(function(oldkeys) {
                        var newIDs = _.difference(IDs, oldkeys);
                        evs.forEach(function(ev) {
                            if (ev._id > lastServerTokenForComments) {
                                lastServerTokenForComments = ev._id;
                            }
                        });
                        var newComments = evs.filter(function(ev) {
                            return _.contains(newIDs, ev._id);
                        });
                        // Lawnchair wants the key to be "key".
                        // could it be modified to have options.keyname?  a9w8ehfdfzgh
                        newComments = newComments.map(function(ev) {
                            ev.key = ev._id;
                            return ev;
                        });
                        commentStore.batch(newComments);
                        getAllReactionsForSelf(stim).then( function() {
                            commentsAvailableCallbacks.fire();
                            dfd.resolve(newComments.length);
                        }, function() {
                            dfd.reject(0);
                        });
                    });
                }
        }, function(err) {
            logger.error('failed to fetch comments for ' + stim);
            logger.dir(err);
            dfd.reject(0);
        });
        return dfd.promise();
    }

    var getNextComment = function(optionalStimulusId) {
        var dfd = $.Deferred();
        var c;
        //c = getNextPriorityComment();
        //if (c) {
            //return dfd.resolve(c);
        //}

        getCommentStore(optionalStimulusId).all(function(comments) {
            for (var i = 0; i < comments.length; i++) {
                var comment = comments[i];
                if (undefined === comment.myReaction) {
                    delete comment.key; // a9w8ehfdfzgh
                    dfd.resolve(comment);
                    return;
                }
            }
            //dfd.resolve(makeEmptyComment()); // may already be resolved above
            dfd.reject(null); // may already be resolved above
        });
        return dfd.promise();
    };

    function submitEvent(data) {
        return polisPost(eventPath, {
            events: [data]
        });
    }

    function submitStimulus(data) {
        if (typeof data.txt !== 'string' || data.txt.length === 0) {
            logger.error("fill out the txt field!");
            return $.Deferred().reject().promise();
        }
        return polisPost(txtPath, {
            events: [data]
        });
    }

    function submitComment(txt, optionalSpecificSubStimulus) {
        if (typeof txt !== 'string' || txt.length === 0) {
            logger.error('bad comment');
            return $.Deferred().reject().promise();
        }
        var ev = {
            s: currentStimulusId,
            txt: txt
        };
        // This allows for comments against other comments.
        // We may not want to allow that, but want to make sure
        // we could support it.
        // We may even want to add the entire stimulus chain
        // as an array?
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return polisPost(txtPath, {
            events: [ev]
        });
    }

    function markReaction(commentId, reaction, optionalStimulusId) {
        var stim = optionalStimulusId || currentStimulusId;
        function mark(stim) {
            getCommentStore(stim).get(commentId, function(comment) {
                if (comment) {
                    comment.myReaction = reaction;
                    getCommentStore(stim).save(comment);
                }
            });
        }
        if (true) {
            // for demo, we have 6 comments which may be shown out of context
            for (var s in commentStores) {
                window.localStorage.setItem("v2.1_comments_" + commentId, 1);
                mark(s);
            }
        } else {
            // this is the normal operation, assuming we're in the right stimulus for that comment.
            mark(stim);
        }
    }

    function push(commentId) {
        markReaction(commentId, "push");
        return react({
            type: polisTypes.reactions.push,
            to: commentId
        });
    }

    function react(params) {
        if (params.s && params.s !== currentStimulusId) {
            if (params.type !== polisTypes.reactions.see) {
                console.error('wrong stimulus');
            }
        }
        return polisPost(reactionsPath, { 
            events: [ $.extend({}, params, {
                s: currentStimulusId
            }) ]
        });
    }

    function pull(commentId) {
        markReaction(commentId, "pull");
        return react({
            type: polisTypes.reactions.pull,
            to: commentId
        });
    }

    // optionalSpecificSubStimulus (aka commentId)
    function see(optionalSpecificSubStimulus) {
        var ev = {
            type: polisTypes.reactions.see
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return react(ev);
    }


    function pass(optionalSpecificSubStimulus) {
        var ev = {
            type: polisTypes.reactions.pass
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        if (ev.to) {
            markReaction(ev.to, "pass");
        }
        return react(ev);
    }

    function polisPost(api, data) {
        return polisAjax(api, data, "POST");
    }

    function polisGet(api, data) {
        return polisAjax(api, data, "GET");
    }

    function polisAjax(api, data, type) {
        var url = protocol ? (protocol + "://") : "" + domain + basePath + api;
        
        // Add the auth token if needed.
        if (_.contains(authenticatedCalls, api)) {
            var token = tokenStore.get();
            if (!token) {
                needAuthCallbacks.fire();
                console.error('auth needed');
                return $.Deferred().reject('auth needed');
            }
            data = $.extend({ token: token}, data);
        }
            
        var promise;
        if ("GET" === type) {
            promise = $.get(url, data);
        } else if ("POST" === type) {
            promise = $.post(url, JSON.stringify(data));
        }
        promise.fail( function(jqXHR, message, errorType) {
                logger.error('SEND ERROR');
                //logger.dir(data);
                //logger.dir(message);
                //logger.dir(errorType);
        });
        return promise;
    }

    function observeStimulus(newStimulusId) {
        currentStimulusId = newStimulusId;
        lastServerTokenForPCA = "";
        lastServerTokenForComments = "";
        return see();
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
            if (authData.u) {
                personIdStore.set(authData.u, temporary);
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
            if (authData.u) {
                personIdStore.set(authData.u, temporary);
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

    function authDeregister() {
        return polisPost(deregisterPath).always( function(authData) {
            clearAuthStores();
            clearDb();
            authStateChangeCallbacks.fire(assemble({
                state: "p_deregistered"
            }));
        });
    }

    function getPca() {
        return polisGet(pcaPath, {
            lastServerToken: lastServerTokenForPCA,
            s: currentStimulusId
        }).then( function(pcaData, textStatus, xhr) {
                if (304 === xhr.status) {
                    // not nodified
                    return;
                }

                lastServerTokenForPCA = pcaData.lastServerToken;

                // TODO we should include the vectors for each comment (with the comments?)
                ///commentVectors = pcaData.commentVectors;

                // TODO this is not runnable, just a rough idea. (data isn't structured like this)
                ///var people = pcaData.people;
                var people = parseTree(pcaData.pca.cluster_tree);
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
                personUpdateCallbacks.fire(people);
            },
            function(err) {
                console.error('failed to get pca data');
            });
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
            s: currentStimulusId,
            type: "feedback"
        });
        return polisPost(feedbackPath, {
            events: [data]
        });
    }


    function getNextPriorityComment() {

        var items = [
        { "s" : ObjectId("509c9fd6bc1e120000000003"), "txt" : "Your editorial suggests that the Israeli prime minister needs to table the military option and give negotiations more time because there is “no proof that Iran is at the point of producing a weapon.\" Unfortunately, you fail to provide any evidence that negotiations have any hope of succeeding. Even while the sanctions have dramatically decreased Iran’s ability to export oil, the Iranian regime has done a masterful job of dragging out the negotiations while not showing any signs of slowing down the enrichment process or any willingness to compromise. Furthermore, Iran continues to call explicitly for Israel’s destruction. If you are going to denounce the Israeli government over its willingness to use the military option, you will soon have to come up with a more practical alternative than giving the negotiations more time.", "u" : ObjectId("509ca5a2bc1e12000000000f"), "_id" : ObjectId("509caa00bc1e120000000040") },

        { "s" : ObjectId("509c9db2bc1e120000000001"), "txt" : "At last, some common sense on this issue. I have never understood all of the fear-mongering about a nuclear Iran. There seems to be a general assumption that the lunacy among Iran's rulers, combined with nuclear weapons, would lead to disaster all around, particularly for Israel. But the Iranians have shown themselves to be calculating, rational, opponents. Any use of nuclear weapons on their part would lead to the destruction of Iran in retaliation. The idea that they would ignore these consequences and pursue mutual destruction anyway is a weak one. On the other hand, a preemptive strike at Iran would drag the US into a prolonged war, both overt and covert. We played the waiting game with the Soviet Union for many years, and it proved to be the right choice. I hope the leaders of the US and Israel make the right choice this time as well.", "u" : ObjectId("509ca5a2bc1e12000000000f"), "_id" : ObjectId("509ca6ddbc1e120000000019") },

        { "s" : ObjectId("509c9fd6bc1e120000000003"), "txt" : "No, the sanctions haven't worked and there's no indication that they will work as long as there continues to be a strong international demand for Iran's crude. So, under the circumstances, I can't fault Israel for taking whatever actions it deems necessary. If Israel fails to act then I think that it's likely that Iran will obtain nuclear weapons. This will then prompt other countries in the region, including Saudi Arabia, to also want nuclear weapons - thus making the Middle East a more dangerous place.", "u" : ObjectId("509ca5a2bc1e12000000000f"), "_id" : ObjectId("509ca958bc1e12000000003d") },

        { "s" : ObjectId("509c9fd6bc1e120000000003"), "txt" : "What is most troubling about all this from an American's perspective is that our leaders feel so compelled to repeat that our bond with Israel is \"unbreakable.\" It's as though some invisible handshake of history has determined that the United States' and Israel's interests will forever remain one in the same. There is no argument as anti-realist as this. Israel's outlook under Netanyahu mirror the infantile \"clash of civilizations\" approach of the Bush administration, which were disastrous for U.S. interests and credibility. Our new, thoughtful president understands this, and he is attempting mold a foreign policy agenda in which nuance, cross-cultural dialogue and diplomacy are of first resort. It's the right way to go for out country's sake, and if Israel would like to play an allied role, it can be very useful. But if Israel would rather play out its pre-Cold War delusions, then our \"sacred bond\" can and should be broken.", "u" : ObjectId("509ca5a2bc1e12000000000f"), "_id" : ObjectId("509ca8d9bc1e120000000031") },

        { "s" : ObjectId("509ca042bc1e120000000004"), "txt" : "Iran would not be ANY sort of threat to us if we hadn't overthrown their ELECTED government in 1953. We overthrew a sovereign nation that was never a threat to us and instituted a pro-US dictator called the Shah. The shah committed thousands of human rights abuses. When the Iranians took control of the embassy, the Iranian hostage crisis, the students who instigated it had three simple demands. 1. Return the shah to Iran for trial (and probably execution), 2. remove the US military presence from the Arab Peninsula, and 3. apologize to Iran. All reasonable. What does Romney think that we would do if another nation were to impose \"crippling sanctions\" on us?", "u" : ObjectId("509c9ae5d9a8f382ff00000b"), "_id" : ObjectId("50a13f407efb5d0500000060") },

        { "s" : ObjectId("509ca042bc1e120000000004"), "txt" : "Israel cannot risk another Holocaust; it deserves to be particularly sensative to existential threats. It's both rational and emotional.", "u" : ObjectId("509c9ae5d9a8f382ff00000b"), "_id" : ObjectId("50a140f27efb5d0500000081") }
        ];
        for (var i = 0; i < items.length; i++) {
            if (window.localStorage.getItem("v2.1_comments_" + items[i]._id)) {
                continue;
            } else {
                return items[i];
            }
        }
        return null;
    }

    // helper for copy-and-pasted mongo documents
    function ObjectId(s) {
        return s;
    }

    function parseTree(treeObject) {
        var tree = Arboreal.parse(treeObject, 'children');

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

    // Setup mock PCA data
    (function() {
        var dataFromPca= parseTree(survey200);
        console.log(dataFromPca.length);

        var alreadyInserted = []; // for mutation demo

        // Add people to the PcaVis
        
/*
        setInterval(function(){
          if  (dataFromPca.length === 0) {
            return;
          }
          var temp = dataFromPca.shift();
          personUpdateCallbacks.fire(temp);
          alreadyInserted.push(temp); // for mutation demo
        }, 10);
*/
        
        setTimeout(getPca,0);
        setInterval(function() {
            getPca();
        }, 5000);

        // for mutation demo
/*
        setInterval(function() {
            for (var i = 0; i < alreadyInserted.length; i++) {
            var mutateThis = alreadyInserted[i];
            if (isPersonNode(mutateThis)) {
                mutateThis.data.projection[0] = mutateThis.data.projection[0] + 1.1;//*(Math.random()-0.5);
                mutateThis.data.projection[1] = mutateThis.data.projection[1] + 1.1;//*(Math.random()-0.5);
                personUpdateCallbacks.fire(mutateThis);
            }
            }
        }, 1000);
*/
    }()); // end setup mock PCA data

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
            s: currentStimulusId
        }).pipe( function(pcaData) {
            comments = pcaData.principal_components;
            var keys = _.keys(comments);
            comments = keys.map(function(key) { return {id: key, projection: comments[key]};});
            comments.sort(compare);
            if (count >= 0) {
                comments = comments.slice(0, count);
            }
            return comments;
        }).pipe( function (commentIds) {
            return getTxt(commentIds.map(function(comment) { return comment.id; }));
        }).pipe( function (results) {
            // they arrive out of order, so map results onto the array that has the right ordering.
            return comments.map(function(comment) {
                return _.findWhere(results.events, {_id: comment.id});
            });
        });
    }

    function getTxt(ids) {
        return polisGet(txtPath, {
            ids: ids.join(',')
        });
    }

    return {
        authenticated: authenticated,
        authNew: authNew,
        authLogin: authLogin,
        authDeregister: authDeregister,
        getNextComment: getNextComment,
        getCommentsForProjection: getCommentsForProjection,
        observeStimulus: observeStimulus, // with no args
        push: push,
        pull: pull,
        pass: pass,
        see: see,
        stories: stories,
        syncAllCommentsForCurrentStimulus: syncAllCommentsForCurrentStimulus,
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        addPersonUpdateListener: personUpdateCallbacks.add,
        addCommentsAvailableListener: commentsAvailableCallbacks.add,
        //addModeChangeEventListener: addModeChangeEventListener,
        //getLatestEvents: getLatestEvents,
        submitEvent: submitEvent,
        submitStimulus: submitStimulus,
        submitFeedback: submitFeedback,
        submitComment: submitComment
    };
};
