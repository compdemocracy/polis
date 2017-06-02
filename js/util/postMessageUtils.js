// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


var Utils = require("./utils");

function getPolisFrameId() {
  if (window.location.search) {
    var params = Utils.parseQueryParams(window.location.search);
    if (params.site_id && params.page_id) {
      return [params.site_id, params.page_id].join("_");
    }
  }
  var parts = window.location.pathname.split("/");
  if (parts && parts.length > 1) {
    // first element is emptystring, since path starts with a "/""
    parts = parts.slice(1);
  } else {
    return "error2384";
  }
  return parts.join("_");
}

function postResizeEvent(newHeight) {
  console.log('postResizeEvent', newHeight);
  window.top.postMessage({
    name: "resize",
    polisFrameId: getPolisFrameId(),
    height: newHeight,
  }, "*");
}

function postVoteEvent() {
  window.top.postMessage({
    name: "vote",
    polisFrameId: getPolisFrameId(),
  }, "*");
}

function postCommentEvent() {
  window.top.postMessage({
    name: "write",
    polisFrameId: getPolisFrameId(),
  }, "*");
}

module.exports = {

  postResizeEvent: postResizeEvent,
  postVoteEvent: postVoteEvent,
  postCommentEvent: postCommentEvent,

  getPolisFrameId: getPolisFrameId,

};
