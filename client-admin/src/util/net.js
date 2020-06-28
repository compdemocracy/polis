// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import URLs from "./url";
import _ from "lodash";

var urlPrefix = URLs.urlPrefix;
var basePath = "";

// var pid = "unknownpid";

function polisAjax(api, data, type) {
  if (!_.isString(api)) {
    throw "api param should be a string";
  }

  if (api && api.length && api[0] === "/") {
    api = api.slice(1);
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
      "Cache-Control": "max-age=0",
    },
    xhrFields: {
      withCredentials: true,
    },
    // crossDomain: true,
    dataType: "json",
  };
  if ("GET" === type) {
    promise = $.ajax(
      $.extend(config, {
        type: "GET",
        data: data,
      })
    );
  } else if ("POST" === type) {
    promise = $.ajax(
      $.extend(config, {
        type: "POST",
        data: JSON.stringify(data),
      })
    );
  }

  promise.fail(function (jqXHR, message, errorType) {
    // sendEvent("Error", api, jqXHR.status);

    // logger.error("SEND ERROR");
    console.dir("polisAjax promise failed: ", arguments);
    if (403 === jqXHR.status) {
      // eb.trigger(eb.authNeeded);
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

const PolisNet = {
  polisAjax: polisAjax,
  polisPost: polisPost,
  polisGet: polisGet,
};
export default PolisNet;
