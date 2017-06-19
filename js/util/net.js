// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventbus");
var URLs = require("../util/url");
var Utils = require("../util/utils");

var urlPrefix = URLs.urlPrefix;
var basePath = "";

var pid = "unknownpid";

function polisAjax(api, data, type, headers) {
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

  if (typeof window.preload.xid !== "undefined") {
    data.xid = window.preload.xid;
  }
  if (typeof window.preload.x_name !== "undefined") {
    data.x_name = window.preload.x_name;
  }
  if (typeof window.preload.x_profile_image_url !== "undefined") {
    data.x_profile_image_url = window.preload.x_profile_image_url;
  }

  var h = Object.assign({
    //"Cache-Control": "no-cache"  // no-cache
    "Cache-Control": "max-age=0"
  }, headers);


  var promise;
  var config = {
    url: url,
    contentType: "application/json; charset=utf-8",
    headers: h,
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

  promise.fail(function(jqXHR, message, errorType) {

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

function polisPost(api, data, headers) {
  return polisAjax(api, data, "POST", headers);
}

function polisGet(api, data, headers) {
  return polisAjax(api, data, "GET", headers);
}

module.exports = {
  polisAjax: polisAjax,
  polisPost: polisPost,
  polisGet: polisGet,
};
