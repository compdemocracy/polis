// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var eb = require("../eventBus");
var URLs = require("../util/url");
var PolisStorage = require("../util/polisStorage");
var $ = require("jquery");
var _ = require("lodash");

var urlPrefix = URLs.urlPrefix;
var basePath = "";

function polisAjax(api, data, type, headers) {
  if (!_.isString(api)) {
    throw "api param should be a string";
  }

  var url = urlPrefix + basePath + api;

  if (typeof window.preload.xid !== "undefined") {
    data.xid = window.preload.xid;
  }
  if (typeof window.preload.x_name !== "undefined") {
    data.x_name = window.preload.x_name;
  }
  if (typeof window.preload.x_profile_image_url !== "undefined") {
    data.x_profile_image_url = window.preload.x_profile_image_url;
  }

  var h = _.extend(
    {
      //"Cache-Control": "no-cache"  // no-cache
      "Cache-Control": "max-age=0"
    },
    headers
  );

  // Add JWT token to headers if available
  var jwtToken = PolisStorage.getJwtToken();
  if (jwtToken) {
    h["Authorization"] = "Bearer " + jwtToken;
  }

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
    promise = $.ajax(
      $.extend(config, {
        type: "GET",
        data: data
      })
    );
  } else if ("POST" === type) {
    promise = $.ajax(
      $.extend(config, {
        type: "POST",
        data: JSON.stringify(data)
      })
    );
  } else if ("PUT" === type) {
    promise = $.ajax(
      $.extend(config, {
        type: "PUT",
        data: JSON.stringify(data)
      })
    );
  }

  // Handle JWT tokens in response
  promise.then(function (data) {
    // Check if response contains a JWT token in auth field
    if (data && data.auth && data.auth.token) {
      PolisStorage.setJwtToken(data.auth.token);
    }
  });

  promise.fail(function (jqXHR) {
    if (403 === jqXHR.status) {
      eb.trigger(eb.authNeeded);
    } else if (401 === jqXHR.status) {
      // JWT token might be expired or invalid
      PolisStorage.clearJwtToken();
      eb.trigger(eb.authNeeded);
    }
  });
  return promise;
}

function polisPost(api, data, headers) {
  return polisAjax(api, data, "POST", headers);
}

function polisPut(api, data, headers) {
  return polisAjax(api, data, "PUT", headers);
}

function polisGet(api, data, headers) {
  return polisAjax(api, data, "GET", headers);
}

module.exports = {
  polisAjax: polisAjax,
  polisPost: polisPost,
  polisPut: polisPut,
  polisGet: polisGet
};
