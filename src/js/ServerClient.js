var ServerClient = function(params) {

    var polisTypes = {
        reactions: {
            push: 1,
            pull: -1,
            pass: 0,
            see: 'see'
        }
    };

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
    var commentsStore = params.commentsStore;
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

    function getAllCommentsForCurrentStimulus() {
        return polisGet(txtPath, params).then( function(data) {
                var evs = data.events;
                if (evs) {
                    var old = JSON.parse(commentsStore.get());
                    old[currentStimulusId] = data.evs;
                    commentsStore.set(JSON.stringify(old));
                } else {
                    logger.error('no comments for stimulus');
                }
            }, function(err) {
                logger.error('failed to fetch comments for ' + currentStimulusId);
                logger.dir(err);
            });
    }

    var getNextComment = function() {

        var dfd = $.Deferred();
        var reactions = JSON.parse(reactionsByMeStore.get());
        reactions = reactions[currentStimulusId]; 
        
        function hasReactedTo(commentId) {
            return reactions.filter(function(comment) {
                return (comment.type === 0 || comment.type === 1 || comment.type === -1);
            }).length > 0;
        }

        var comments = commentsStore.get();
        comments = comments[currentStimulusId];
        
        for (var i = 0; i < comments.length; i++) {
            if (!hasReactedTo(comments[i])) {
                dfd.resolve(comments[i]);
            }
        }
        dfd.resolve({
            s: currentStimulusId,
            _id: "",
            txt: "There are no more comments for this story."
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

    function push(commentId) {
        return polisPost(reactionsPath, { 
            events: [ {
                s: currentStimulusId,
                type: polisTypes.reactions.push,
                to: commentId
            } ]
        });
    }

    function pull(commentId) {
        return polisPost(reactionsPath, { 
            events: [ {
                s: currentStimulusId,
                type: polisTypes.reactions.pull,
                to: commentId
            } ]
        });
    }

    // optionalSpecificSubStimulus (aka commentId)
    function see(optionalSpecificSubStimulus) {
        var ev = {
            s: currentStimulusId,
            type: polisTypes.reactions.see
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return polisPost(reactionsPath, { 
            events: [ ev ]
        });
    }


    function pass(optionalSpecificSubStimulus) {
        var ev = {
            s: currentStimulusId,
            type: polisTypes.reactions.pass
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return polisPost(reactionsPath, { 
            events: [ ev ]
        });
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
    getAllCommentsForCurrentStimulus: getAllCommentsForCurrentStimulus,
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        submitStimulus: submitStimulus,
        submitComment: submitComment
    };
};
