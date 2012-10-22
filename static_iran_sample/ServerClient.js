var ServerClient = function(params) {

    var protocol = params.protocol;
    var domain = params.domain;
    var basePath = params.basePath;
    var syncEventsPath = "/v1/syncEvents";
//    var getEventsPath = "/v1/getEvents";

    var logger = params.logger;

    var serverIsAheadByMicros = 0; // BAD! TODO fetch from server as first action.
    var previousServerToken = 0; // start syncing from 0

    var userid = params.me;
    var currentStimulusId;

    var comments = [];
    var users = [];
         
    var commentIndex = 0;

    // function getNextStimulus() {}

    // key on id field
    // TODO remove - We shouldn't need this, just for verification
    var dedupMap = {};
    
    function isValidCommentID(commentID) {
        return isNumber(commentID);
    }

    function getNextComment() {
        var dfd = $.Deferred();
        polisAjax(syncEventsPath, { 
            events: [ {
                    type: "p_push",
                } ]
        }).then(function() {
                if (commentIndex >= comments.length) {
                    dfd.reject();
                }
            });
        if (commentIndex >= comments.length) {
            // wait for the ajax, TODO fix this?
        } else {
            dfd.resolve(comments[commentIndex]);
            commentIndex += 1;
        }
        return dfd.promise();
    }

    function submitComment(text) {
        if (typeof text !== 'string' || text.length === 0) {
            logger.error('bad comment');
            return $.Deferred().reject().promise();
        }
        return polisAjax(syncEventsPath, { 
            events: [ {
                    userID: userid,
                    type: "p_comment",
                    text: text,
                } ]
        });
    }
    function push(commentID) {
        if (!isValidCommentID(commentID)) {
            logger.error('bad commentID: ' + commentID);
            return $.Deferred().reject().promise();
        }
        return polisAjax(syncEventsPath, { 
            events: [ {
                    userID: userid,
                    type: "p_push",
                    to: commentID,
                } ]
        });
    }

//  function getEventsFromPolis() {
//      return polisAjax(getEventsPath, {
//          previousServerToken: previousServerToken,
//          userID: userid,
//      }).pipe(function(data);
//  }

    function pull(commentID) {
        if (!isValidCommentID(commentID)) {
            logger.error('bad commentID' + commentID);
            return $.Deferred().reject().promise();
        }
        return polisAjax(syncEventsPath, { 
            events: [ {
                userID: userid,
                type: "p_pull",
                to: commentID,
            } ],
        });
    }

    function reportAsShown(commentID) {
        var dfd = $.Deferred();
        logger.log("ServerClient SHOWN: " + commentID);
        setTimeout(dfd.resolve, 1000);
        return dfd.promise();
    }

    function addToJournal(item) {
    }

    function sync() {
        return polisAjax(syncEventsPath, {
            types_to_return: ["p_comment"],
            previousServerToken: previousServerToken,
        });
    }

    function polisAjax(api, data) {
        if (!currentStimulusId) {
            logger.error('stimulusId should probably be set');
            return $.Deferred().reject().promise();
        }
        data = $.extend({}, data, {
            types_to_return: ["p_comment"],
            previousServerToken: previousServerToken,
            s: currentStimulusId,
        });
        return $.ajax({
            url: protocol + "://" + domain + basePath + api,
            type: 'POST',
            data: JSON.stringify(data),
        }).then(
            function(data) {
                // take every opportunity to sync with server time.
                previousServerToken = data.serverTimeMillis;
                var evs = data.newEvents;
                if (evs) {
                    for (var i = 0; i < evs.length; i++) {
                        if (dedupMap[evs[i].id]) {
                            logger.warn('duplicate found for', evs[i]);
                            continue;
                        }
                        if (evs[i].type === "p_comment") {
                            comments.push(evs[i]);
                            dedupMap[evs[i].id] = 1;
                        } else if (evs[i].type === "p_newuser") {
                            users.push(evs[i]);
                        } else {
                            // we may want other types later.
                        }
                    }
                }
                logger.log('send OK', data);
            },
            function(jqXHR, message, errorType) {
                logger.error('send ERROR', data);
                logger.dir(data);
                logger.dir(message);
                logger.dir(errorType);
            }
        );
    }

    function observeStimulus(stimulusId) {
        if (typeof stimulusId !== 'string' || stimulusId.length === 0) {
            logger.error('bad id');
            return $.Deferred().reject().promise();
        }
        currentStimulusId = stimulusId;
        return polisAjax(syncEventsPath, { 
            events: [ {
                    userID: userid,
                    type: "p_observe_stimulus",
                    // NOTE currentStimulusId is added by polisAjax
                } ]
        });
    }

    function getListOfUsersForThisTopic() {
        return polisAjax(syncEventsPath, { 
            events: [ {
                    type: "p_newuser",
                    s: currentStimulusId,
                } ]
        }).pipe(function() {
            return users;
        }, function(err) {
            console.error('error fetching users ');
            console.dir(err);
            return users;
        });
    }

    return {
        sync: sync, // TODO remove from this API
        getNextComment: getNextComment,
        observeStimulus: observeStimulus,
        push: push,
        pull: pull,
        reportAsShown: reportAsShown,
        submitComment: submitComment,
        getListOfUsersForThisTopic: getListOfUsersForThisTopic,
    }
};
