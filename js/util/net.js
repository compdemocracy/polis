var eb = require("../eventbus");
var URLs = require("../util/url");
var Utils = require("../util/utils");

var urlPrefix = URLs.urlPrefix;
var basePath = "";

var pid = "unknownpid";

function polisAjax(api, data, type) {
    if (!_.isString(api)) {
        throw "api param should be a string";
    }

    var url = urlPrefix + basePath + api;

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

    promise.then(function() {
        var latestPid = Utils.getCookie("pid");
        if (pid !== latestPid) {
            pid = latestPid;
            eb.trigger(eb.pidChange, latestPid);
        }
    });

    promise.fail( function(jqXHR, message, errorType) {

        // sendEvent("Error", api, jqXHR.status);

        // logger.error("SEND ERROR");
        console.dir(arguments);
        if (403 === jqXHR.status) {
            eb.trigger(eb.authNeeded);
        }
            //logger.dir(data);
            //logger.dir(message);
            //logger.dir(errorType);
    });
    return promise;
}

function polisPost(api, data) {
    return polisAjax(api, data, "POST");
}

function polisGet(api, data) {
    return polisAjax(api, data, "GET");
}

module.exports = {
    polisAjax: polisAjax,
    polisPost: polisPost,
    polisGet: polisGet,
};
