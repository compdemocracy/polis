const { beforeEach, afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const messages = require("../postMessageUtils");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let sent;

beforeEach(() => {
  sent = [];
  globalThis.window = {
    location: { pathname: "/conversation/7Public", search: "" },
    top: { postMessage: (...args) => sent.push(args) },
    preload: { conversation: { conversation_id: "7Public", topic: "Public topic" } }
  };
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

test("complete site/page query coordinates determine the parent frame identity", () => {
  window.location.search = "?site_id=public-site&page_id=public-page";
  assert.equal(messages.getPolisFrameId(), "public-site_public-page");
});

test("partial query coordinates fall back to the full route identity", () => {
  window.location.search = "?site_id=public-site";
  assert.equal(messages.getPolisFrameId(), "conversation_7Public");
});

test("resize delivery includes height and the matching parent frame identity", () => {
  messages.postResizeEvent(480);
  assert.deepEqual(sent, [[{ name: "resize", polisFrameId: "conversation_7Public", height: 480 }, "*"]]);
});

test("vote and comment delivery preserve distinct parent event names", () => {
  messages.postVoteEvent();
  messages.postCommentEvent();
  assert.deepEqual(sent, [
    [{ name: "vote", polisFrameId: "conversation_7Public" }, "*"],
    [{ name: "write", polisFrameId: "conversation_7Public" }, "*"]
  ]);
});

test("initialization passes the current conversation and status to the parent", () => {
  messages.postInitEvent("ready");
  assert.deepEqual(sent, [[{ name: "init", status: "ready", conversation: window.preload.conversation }, "*"]]);
});
