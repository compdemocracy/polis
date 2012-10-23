var ServerClient = function(params) {

    var polisTypes = {
        reactions: {
            push: 1,
            pull: -1,
            pass: 0,
            see: 'see',
        },
    };

    var protocol = params.protocol;
    var domain = params.domain;
    var basePath = params.basePath;

    var reactionsPath = "/v2/reactions";
    var txtPath = "/v2/txt";

    var logger = params.logger;

    var userid = params.me;
    var currentStimulusId;

    var comments = [];
    var users = [];

    // TODO if we decide to do manifest the chain of comments in a discussion, then we might want discussionClients that spawn discussionClients..?
    // Err... I guess discussions can be circular.
    //function discussionClient(params) {  
    
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
                s: currentStimulusId,
                //tags: [ {$not: "stimulus"} ], 
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
        }
    }());

    function submitComment(txt, optionalSpecificSubStimulus) {
        if (typeof txt !== 'string' || txt.length === 0) {
            logger.error('bad comment');
            return $.Deferred().reject().promise();
        }
        var ev = {
            u : userid,
            s: currentStimulusId,
            txt: txt,
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
            events: [ev],
        });
    }

    function push(commentId) {
        return polisPost(reactionsPath, { 
            events: [ {
                u: userid,
                s: currentStimulusId,
                type: polisTypes.push,
                to: commentId,
            } ],
        });
    }

    function pull(commentId) {
        return polisPost(reactionsPath, { 
            events: [ {
                u: userid,
                s: currentStimulusId,
                type: polisTypes.pull,
                to: commentId,
            } ],
        });
    }

    // optionalSpecificSubStimulus (aka commentId)
    function see(optionalSpecificSubStimulus) {
        var ev = {
            u: userid,
            s: currentStimulusId,
            type: polisTypes.see,
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return polisPost(reactionsPath, { 
            events: [ ev ],
        });
    }


    function pass(optionalSpecificSubStimulus) {
        var ev = {
            u: userid,
            s: currentStimulusId,
            type: polisTypes.pass,
        }; 
        if (optionalSpecificSubStimulus) {
            ev.to = optionalSpecificSubStimulus;
        }
        return polisPost(reactionsPath, { 
            events: [ ev ],
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
        
        var promise;
        if ("GET" === type) {
            promise = $.get(url, data);
        } else if ("POST" === type) {
            promise = $.post(url, JSON.stringify(data));
        }
        
        promise.fail( function(jqXHR, message, errorType) {
                logger.error('send ERROR', data);
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

    function authenticate(username, password) {
        //userid = "5084f8ae2985e5b6317ead7e";
        console.warn('authenticate not implemented');
        return $.Deferred().resolve();
    }

    function authAnonNew() {
        return polisGet("v2/auth/newAnon").done( function(authData) {
            userid = authData.u;
        });
    }

    return {
        authAnonNew: authAnonNew,
        getNextComment: getNextComment,
        observeStimulus: observeStimulus, // with no args
        push: push,
        pull: pull,
        pass: pass,
        see: see,
        submitComment: submitComment,
        authenticate: authenticate,
    }
};
