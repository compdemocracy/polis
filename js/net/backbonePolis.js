// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var URLs = require("../util/url");

var urlPrefix = URLs.urlPrefix;

var api_version = "v3";

var originalAjax = Backbone.ajax;
Backbone.ajax = function(url, options) {
  // this block is from jQuery.ajax
  // If url is an object, simulate pre-1.5 signature
  if (typeof url === "object") {
    options = url;
    url = options.url; // this part is different than jQuery.ajax (it would set url to null)
  }

  var base_url = urlPrefix + "api/" + api_version + "/";

  //var base_url = "http://localhost:5000/" + api_version;
  url = base_url + url;

  var request = {
    //data
    contentType: "application/json",
    processData: false,
    dataType: "json",
    data: options.data,

    //authentication
    headers: {
      "Cache-Control": "max-age=0"
        //"Cache-Control": "no-cache"
        //"X-Parse-Application-Id": application_id,
        //"X-Parse-REST-API-Key": rest_api_key
    },
    // crossDomain: true,
    xhrFields: {
      withCredentials: true
    }
  };

  return originalAjax(url, $.extend(true, options, request));
};
