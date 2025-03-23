// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


var _ = require("lodash");
var Net = require("./net");

var polisPost = Net.polisPost;

var metrics = [];


var ENABLED = false;


function upload() {
  if (!metrics.length) {
    return;
  }
  polisPost("api/v3/metrics", {
    types: _.map(metrics, "type"),
    times: _.map(metrics, "time"),
    durs: _.map(metrics, "dur"),
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


  COMMENT_SUBMIT_CLICK: 2010,
  COMMENT_SUBMIT_INIT: 2020,

  VOTE_SUBMIT_CLICK: 2110,
  VOTE_SUBMIT_INIT: 2120,
};
