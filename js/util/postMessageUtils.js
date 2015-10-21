
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

module.exports = {

  postResizeEvent: postResizeEvent,
  postVoteEvent: postVoteEvent,

  getPolisFrameId: getPolisFrameId,

};
