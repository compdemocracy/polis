var ServerClient = function(params) {

    var protocol = params.protocol;
    var domain = params.domain;
    var basePath = params.basePath;
    var syncEventsPath = "/v1/syncEvents";
//    var getEventsPath = "/v1/getEvents";

    var logger = params.logger;

    var serverIsAheadByMicros = 0; // BAD! TODO fetch from server as first action.
    var previousServerTimeMillis = 0; // start syncing from 0

    var userid = params.me;

    var comments = [];
         
    var commentIndex = 0;

    // function getNextStimulus() {}
    
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

    function push(commentID) {
        if (!isValidCommentID(commentID)) {
            logger.error('bad commentID: ' + commentID);
            return $.Deferred().reject().promise();
        }
        return polisAjax(syncEventsPath, { 
            events: [ {
                    me: userid,
                    type: "p_push",
                    to: commentID,
                } ]
        });
    }

//  function getEventsFromPolis() {
//      return polisAjax(getEventsPath, {
//          previousServerTimeMillis: previousServerTimeMillis,
//          me: userid,
//      }).pipe(function(data);
//  }

    function pull(commentID) {
        if (!isValidCommentID(commentID)) {
            logger.error('bad commentID' + commentID);
            return $.Deferred().reject().promise();
        }
        return polisAjax(syncEventsPath, { 
            events: [ {
                me: userid,
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
            previousServerTimeMillis: previousServerTimeMillis,
        });
    }

    function polisAjax(api, data) {
        data = $.extend({}, data, {
            types_to_return: ["p_comment"],
            previousServerTimeMillis: previousServerTimeMillis,
        });
        return $.ajax({
            url: protocol + "://" + domain + basePath + api,
            type: 'POST',
            data: JSON.stringify(data),
        }).then(
            function(data) {
                // take every opportunity to sync with server time.
                previousServerTimeMillis = data.serverTimeMillis;
                var evs = data.newEvents;
                if (evs) {
                    for (var i = 0; i < evs.length; i++) {
                        if (evs[i].type === "p_comment") {
                            comments.push(evs[i]);
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

    return {
        sync: sync, // TODO remove from this API
        getNextComment: getNextComment,
        push: push,
        pull: pull,
        reportAsShown: reportAsShown,
    }
};
