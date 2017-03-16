// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


var _ = require("underscore");
var Net = require("./net");

var polisPost = Net.polisPost;

var metrics = [];


var ENABLED = false;


function upload() {
  if (!metrics.length) {
    return;
  }
  polisPost("api/v3/metrics", {
    types: _.pluck(metrics, "type"),
    times: _.pluck(metrics, "time"),
    durs: _.pluck(metrics, "dur"),
    clientTimestamp: Date.now(),
  }).then(function() {
    metrics = [];
  }, function(err) {
    console.error("failed to upload error metrics :(");
  });
}


function add(type) {
  if (!type) {
    console.error("undefined metric type");
    type = 0;
  }
  metrics.push({type: type, time: Date.now(), dur: 0});
}

// For use as promise callbacks
function addp(type) {
  return function() {
    add(type);
  };
}

function addAndSend(type) {
  if (ENABLED) {
    add(type);
    upload();
  }
}

if (ENABLED) {
  setInterval(upload, 10*1000);
}

module.exports = {
  add: add,
  addp: addp,
  addAndSend: addAndSend,
  // TODO add timers


  FB_CONNECT_INIT: 3010,

  FB_GETAUTHRESPONSE_TRUE: 3013,
  FB_GETAUTHRESPONSE_FALSE: 3014,

  FB_LOGIN_PROMPT_INIT: 3020,
  FB_LOGIN_PROMPT_OK: 3021,
  FB_LOGIN_PROMPT_ERR: 3022,

  FB_GETLOGINSTATUS_INIT: 3030,
  FB_GETLOGINSTATUS_CONNECTED: 3033,
  FB_GETLOGINSTATUS_NOTCONNECTED: 3034,

  FB_AUTH_INIT: 3040,
  FB_AUTH_OK: 3041,
  FB_AUTH_ERR: 3042,

  COMMENT_SUBMIT_CLICK: 2010,
  COMMENT_SUBMIT_INIT: 2020,
  COMMENT_SUBMIT_SOCIAL_NEEDED: 2025,
  COMMENT_SUBMIT_FB_INIT: 2030,
  COMMENT_SUBMIT_FB_OK: 2031,
  COMMENT_SUBMIT_FB_ERR: 2032,
  COMMENT_SUBMIT_TW_INIT: 2040,
  COMMENT_SUBMIT_TW_OK: 2041,

  VOTE_SUBMIT_CLICK: 2110,
  VOTE_SUBMIT_INIT: 2120,
  VOTE_SUBMIT_SOCIAL_NEEDED: 2125,
  VOTE_SUBMIT_FB_INIT: 2130,
  VOTE_SUBMIT_FB_OK: 2131,
  VOTE_SUBMIT_FB_ERR: 2132,
  VOTE_SUBMIT_TW_INIT: 2140,
  VOTE_SUBMIT_TW_OK: 2141,
};
