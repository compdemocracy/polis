// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var URLs = require("../util/url");
var $ = require("jquery");
var Backbone = require("backbone");
var PolisStorage = require("../util/polisStorage");

console.log("[BackbonePolis] Loading Backbone AJAX monkey patch");

var urlPrefix = URLs.urlPrefix;

var api_version = "v3";

var originalAjax = Backbone.ajax;
Backbone.ajax = function (url, options) {
  console.log("[BackbonePolis] Backbone.ajax called with url:", url, "options:", options);

  // this block is from jQuery.ajax
  // If url is an object, simulate pre-1.5 signature
  if (typeof url === "object") {
    options = url;
    url = options.url; // this part is different than jQuery.ajax (it would set url to null)
    console.log("[BackbonePolis] URL was object, extracted URL:", url);
  }

  var base_url = urlPrefix + "api/" + api_version + "/";
  console.log("[BackbonePolis] Base URL:", base_url);

  //var base_url = "http://localhost:5000/" + api_version;
  url = base_url + url;
  console.log("[BackbonePolis] Final URL:", url);

  // Get JWT token if available
  var jwtToken = PolisStorage.getJwtToken();
  console.log(
    "[BackbonePolis] JWT token for request:",
    jwtToken ? "present (length: " + jwtToken.length + ")" : "not available"
  );

  var headers = {
    "Cache-Control": "max-age=0"
    //"Cache-Control": "no-cache"
    //"X-Parse-Application-Id": application_id,
    //"X-Parse-REST-API-Key": rest_api_key
  };

  // Add JWT token to Authorization header if available
  if (jwtToken) {
    headers["Authorization"] = "Bearer " + jwtToken;
    console.log("[BackbonePolis] Added Authorization header");
  }

  var request = {
    //data
    contentType: "application/json",
    processData: false,
    dataType: "json",
    data: options.data,

    //authentication
    headers: headers,
    // crossDomain: true,
    xhrFields: {
      withCredentials: true
    }
  };

  console.log("[BackbonePolis] Making request with config:", request);
  var result = originalAjax(url, $.extend(true, options, request));
  console.log("[BackbonePolis] Request initiated, returning:", result);
  return result;
};
