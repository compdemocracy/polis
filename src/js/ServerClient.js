var ServerClient = function(params) {

    var polisTypes = {
        reactions: {
            push: 1,
            pull: -1,
            pass: 0,
            see: 'see'
        }
    };

    var commentsStore = new Lawnchair({name: 'v2_comments'}, function() {
        console.log('lawnchair ready'); // TODO make 'this' available to the module manager to prevent race conditions
    });

    var protocol = params.protocol;
    var domain = params.domain;
    var basePath = params.basePath;

    var reactionsPath = "/v2/reactions";
    var reactionsByMePath = "/v2/reactions/me";
    var txtPath = "/v2/txt";

    var createAccountPath = "/v2/auth/new";
    var loginPath = "/v2/auth/login";
    var deregisterPath = "/v2/auth/deregister";

    var authenticatedCalls = [reactionsByMePath, reactionsPath, txtPath, deregisterPath];

    var logger = params.logger;

    var authStateChangeCallbacks = $.Callbacks();

    var reactionsByMeStore = params.reactionsByMeStore;
    //var commentsStore = params.commentsStore;
    var usernameStore = params.usernameStore;
    var tokenStore = params.tokenStore;
    var emailStore = params.emailStore;
    var authStores = [tokenStore, usernameStore, emailStore];
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

    function getAllReactionsForSelf() {
        var params = {
            s: currentStimulusId
        };
        return polisGet(reactionsByMePath, params).done( function(data) {
            // BAD! use a real DB
            var oldStore = JSON.parse(reactionsStore.get());
            oldStore[currentStimulusId] = data.evs;
            reactionsStore.set(JSON.stringify(oldStore));
            console.dir(oldStore);
        });
    }

    function syncAllCommentsForCurrentStimulus() { // more like sync?
        var dfd = $.Deferred();
        var params = {
            s: currentStimulusId
            //?
        };
        polisGet(txtPath, params).then( function(data) {
                var evs = data.events;
                if (!evs) {
                    logger.log('no comments for stimulus');
                    dfd.resolve([]);
                } else {
                    var id_to_ev = {};
                    evs.forEach(function(ev) {
                        id_to_ev[ev._id] = ev;
                    });
                    var IDs = _.keys(id_to_ev);
                    commentsStore.keys(function(keys) {
                        var newIDs = _.difference(IDs, keys);
                        var newComments = evs.filter(function(ev) {
                            _.contains(newIDs, ev._id);
                        });
                        // Lawnchair wants the key to be "key".
                        // could it be modified to have options.keyname?  a9w8ehfdfzgh
                        newComments = newComments.map(function(ev) {
                            ev.key = ev._id;
                        });
                        commentsStore.batch(newComments);
                        dfd.resolve(newComments);
                    });
                }
        }, function(err) {
            logger.error('failed to fetch comments for ' + currentStimulusId);
            logger.dir(err);
            dfd.reject([]);
        });
    }

    var getNextComment = function() {
        var dfd = $.Deferred();
        var reactions = JSON.parse(reactionsByMeStore.get());
        commentsStore.all(function(comments) {
            for (var i = 0; i < comments.length; i++) {
                var comment = comments[i];
                if (undefined === comment.myReaction) {
                    delete comment.key; // a9w8ehfdfzgh
                    dfd.resolve(comment);
                }
            }
            dfd.resolve(makeEmptyComment());
        });
        return dfd.promise();
    };

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

    function markReaction(commentId, reaction) {
        commentsStore.get(commentId, function(comment) {
            comment.myReaction = reaction;
            commentStore.save(comment);
        });
    }

    function push(commentId) {
        markReaction(commentId, "push");
        return react({
            type: polisTypes.reactions.push,
            to: commentId
        });
    }

    function react(parmams) {
        return polisPost(reactionsPath, { 
            events: [ $.extend(params, {
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
        return see();
    }

    function authNew(params) {
        if (!params.password) { return $.Deferred().reject("need password"); }
        if (!params.username && !params.email) { return $.Deferred().reject("need username or email"); }
        return polisPost(createAccountPath, params).done( function(authData) {

            clearAuthStores();
            var temporary = !params.rememberMe;
            tokenStore.set(authData.token, temporary);
            if (params.username) {
                usernameStore.set(params.username, temporary);
            }
            if (params.email) {
                emailStore.set(params.email, temporary);
            }
            authStateChangeCallbacks.fire(assemble({
                email: params.email,
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
            if (params.email) {
                emailStore.set(params.email, temporary);
            }
            authStateChangeCallbacks.fire(assemble({
                email: params.email,
                username: params.username,
                state: "p_registered"
            }));
        });//.then(logger.log, logger.error);
    }

    function authDeregister() {
        return polisPost(deregisterPath).always( function(authData) {
            clearAuthStores();
            authStateChangeCallbacks.fire(assemble({
                state: "p_deregistered"
            }));
        });//.then(logger.log, logger.error);
    }

    return {
        authNew: authNew,
        authLogin: authLogin,
        authDeregister: authDeregister,
        getNextComment: getNextComment,
        observeStimulus: observeStimulus, // with no args
        push: push,
        pull: pull,
        pass: pass,
        see: see,
        syncAllCommentsForCurrentStimulus: syncAllCommentsForCurrentStimulus,
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        submitStimulus: submitStimulus,
        submitComment: submitComment
    };
};
