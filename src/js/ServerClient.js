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
    var txtPath = "/v2/txt";

    var createAccountPath = "/v2/auth/new";
    var loginPath = "/v2/auth/login";
    var deregisterPath = "/v2/auth/deregister";

    var authenticatedCalls = [reactionsPath, txtPath, deregisterPath];

    var logger = params.logger;

    var authStateChangeCallbacks = $.Callbacks();

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

    var getNextComment = (function() {

        var lastServerToken;
        var commentIndex = 0;

        return function () {
            var dfd = $.Deferred();

            function onOk() {
                dfd.resolve(comments[commentIndex]);
                commentIndex++;
            }


            var params = {
                //tags: [ {$not: "stimulus"} ], 
                s: currentStimulusId
            };
            if (lastServerToken) {
                params.lastServerToken = lastServerToken;
            }
            polisGet(txtPath, params).done( function(data) {
                var evs = data.events;
                if (evs) {
                    for (var i = 0; i < evs.length; i++) {
                        comments.push(evs[i]);
                        // keep the max id as the last token
                        if (evs[i]._id >lastServerToken) {
                            lastServerToken = evs[i]._id;
                        }
                    }
                }
                lastServerToken = data.lastServerToken;
                onOk();
            }).fail( function() {
                dfd.reject();
            });

            if (commentIndex >= comments.length) {
                // wait for the ajax, TODO fix this?
            } else {
                onOk();
            }
            return dfd.promise();
        };
    }());

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
                logger.error('send ERROR');
                logger.dir(data);
                logger.dir(message);
                logger.dir(errorType);
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
            authStateChangeCallbacks.fire("p_registered");
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
            authStateChangeCallbacks.fire("p_registered");
        });//.then(logger.log, logger.error);
    }

    function authDeregister() {
        return polisPost(deregisterPath).always( function(authData) {
            clearAuthStores();
            authStateChangeCallbacks.fire("p_deregistered");
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
        addAuthStatChangeListener: authStateChangeCallbacks.add,
        addAuthNeededListener: needAuthCallbacks.add, // needed?
        submitComment: submitComment
    };
};
