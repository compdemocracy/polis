const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the actual public embed asset after its build-time hostname substitution.
const hostname = "embed.example.invalid";
const source = fs
  .readFileSync(path.join(__dirname, "../embed.js"), "utf8")
  .replaceAll("<%= embedServiceHostname %>", hostname);

function element(attributes = {}) {
  return {
    attributes: { ...attributes },
    children: [],
    style: {},
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
    }
  };
}
function page(attributes = { "data-conversation_id": "7Public" }, options = {}) {
  const parents = [element(attributes)];
  const handlers = [];
  const alerts = [];
  const location = {
    protocol: "https:",
    search: options.search || "",
    hash: options.hash || "",
    toString() {
      return "https://publisher.example.invalid/public-page";
    }
  };
  const document = {
    referrer: "https://referrer.example.invalid/start",
    createElement(tag) {
      assert.equal(tag, "iframe");
      return element();
    },
    getElementsByClassName(name) {
      assert.equal(name, "polis");
      return parents;
    },
    getElementById(id) {
      return parents.flatMap((p) => p.children).find((f) => f.id === id) || null;
    }
  };
  const window = {
    location,
    innerWidth: 720,
    addEventListener(name, handler) {
      assert.equal(name, "message");
      handlers.push(handler);
    }
  };
  const context = vm.createContext({
    window,
    document,
    alert: (message) => alerts.push(message),
    console: { log() {} }
  });
  const run = () => vm.runInContext(source, context, { filename: "public-embed.js", timeout: 1000 });
  run();
  return {
    parents,
    handlers,
    alerts,
    window,
    document,
    run,
    get frame() {
      return parents[0].children[0];
    },
    message(data, origin = `https://${hostname}`) {
      handlers.forEach((h) => h({ data, origin }));
    }
  };
}

test("conversation embed binds its frame identity and public parent/referrer URLs", () => {
  const p = page();
  const url = new URL(p.frame.src);
  assert.equal(url.origin, `https://${hostname}`);
  assert.equal(url.pathname, "/7Public");
  assert.equal(url.searchParams.get("parent_url"), "https://publisher.example.invalid/public-page");
  assert.equal(url.searchParams.get("referrer"), "https://referrer.example.invalid/start");
  assert.equal(p.frame.id, "polis_7Public");
  assert.equal(p.frame.attributes["data-testid"], "polis-iframe");
  assert.equal(p.frame.width, "100%");
  assert.equal(p.frame.style.maxWidth, "720px");
});

test("site/page embedding constructs matching URL and frame coordinates", () => {
  const p = page({ "data-site_id": "public-site", "data-page_id": "public-page" });
  assert.equal(new URL(p.frame.src).pathname, "/public-site/public-page");
  assert.equal(p.frame.id, "polis_public-site_public-page");
});

test("missing conversation and site identity creates no iframe", () => {
  const p = page({});
  assert.equal(p.parents[0].children.length, 0);
  assert.deepEqual(p.alerts, ["Error: need data-conversation_id or data-site_id"]);
});

test("site identity without a page refuses partial embedding", () => {
  const p = page({ "data-site_id": "public-site" });
  assert.equal(p.parents[0].children.length, 0);
  assert.deepEqual(p.alerts, ["Error: need data-page_id when using data-site_id"]);
});

test("configuration values are URL encoded and explicit zero/false strings are retained", () => {
  const p = page({
    "data-conversation_id": "7Public",
    "data-topic": "A&B = public?",
    "data-ui_lang": "fr",
    "data-subscribe_type": "0",
    "data-auth_needed_to_vote": "false"
  });
  const query = new URL(p.frame.src).searchParams;
  assert.equal(query.get("topic"), "A&B = public?");
  assert.equal(query.get("ui_lang"), "fr");
  assert.equal(query.get("subscribe_type"), "0");
  assert.equal(query.get("auth_needed_to_vote"), "false");
});

test("hash external identity takes precedence over the query identity", () => {
  const p = page(undefined, { hash: "#xid=hash%20identity", search: "?xid=query%20identity" });
  assert.equal(new URL(p.frame.src).searchParams.get("xid"), "hash identity");
});

test("explicit external identity takes precedence over URL identity", () => {
  const p = page({ "data-conversation_id": "7Public", "data-xid": "element identity" }, { hash: "#xid=hash" });
  assert.equal(new URL(p.frame.src).searchParams.get("xid"), "element identity");
});

test("demo mode changes the conversation path and configured presentation is preserved", () => {
  const p = page({
    "data-conversation_id": "7Public",
    "data-demo": "true",
    "data-height": "480",
    "data-border": "none",
    "data-padding": "0",
    "data-border_radius": "0"
  });
  assert.equal(new URL(p.frame.src).pathname, "/demo/7Public");
  assert.equal(p.frame.height, "480");
  assert.equal(p.frame.style.border, "none");
  assert.equal(p.frame.style.padding, "0");
  assert.equal(p.frame.style.borderRadius, "0");
});

test("loading the asset twice preserves populated frames and registers only one listener", () => {
  const p = page();
  const first = p.frame;
  p.parents.push(element({ "data-conversation_id": "8Other" }));
  p.run();
  assert.equal(p.parents[0].children.length, 1);
  assert.equal(p.frame, first);
  assert.equal(p.parents[1].children.length, 1);
  assert.equal(p.parents[1].children[0].id, "polis_8Other");
  assert.equal(p.handlers.length, 1);
});

test("resize messages expand a frame but cannot shrink its last observed height", () => {
  const p = page();
  p.message({ name: "resize", polisFrameId: "7Public", height: 1000 });
  p.message({ name: "resize", polisFrameId: "7Public", height: 500 });
  assert.equal(p.frame.attributes.height, "1000");
  p.message({ name: "resize", polisFrameId: "7Public", height: 1100 });
  assert.equal(p.frame.attributes.height, "1100");
});

test("a resize callback can explicitly handle the event and suppress default resizing", () => {
  const p = page();
  const seen = [];
  p.window.polis.on.resize.push((event) => {
    seen.push(event);
    return true;
  });
  p.message({ name: "resize", polisFrameId: "7Public", height: 1000 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].iframe, p.frame);
  assert.equal(seen[0].data.height, 1000);
  assert.equal(p.frame.attributes.height, undefined);
});

test("unrelated origins cannot invoke callbacks or resize the frame", () => {
  const p = page();
  const seen = [];
  p.window.polis.on.resize.push((event) => seen.push(event));
  p.message({ name: "resize", polisFrameId: "7Public", height: 1000 }, "https://unrelated.invalid");
  assert.equal(seen.length, 0);
  assert.equal(p.frame.attributes.height, undefined);
});

test("trusted vote and write messages dispatch to their own callback lists with the matching frame", () => {
  const p = page();
  const seen = [];
  p.window.polis.on.vote.push((event) => seen.push(["vote", event.iframe]));
  p.window.polis.on.write.push((event) => seen.push(["write", event.iframe]));
  p.message({ name: "vote", polisFrameId: "7Public" });
  p.message({ name: "write", polisFrameId: "7Public" });
  assert.deepEqual(seen, [
    ["vote", p.frame],
    ["write", p.frame]
  ]);
});
