const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(hostname = "localhost", port = "") {
  const filename = path.join(__dirname, "../conversation.js");
  const document = { location: { hostname, port } };
  const module = { exports: {} };
  const context = vm.createContext({
    document,
    module,
    require(name) {
      assert.equal(name, "../model");
      // Capture actual function bodies passed to the model constructor boundary.
      // This is not a Backbone implementation: no instances, inherited methods,
      // defaults evaluation, parse, validation or transport behavior are emulated.
      return { extend: (definition) => definition };
    }
  });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename, timeout: 1000 });
  return { definition: module.exports, document };
}

function receiver(definition, conversationId) {
  return { conversation_id: conversationId, url_name: definition.defaults.url_name };
}

test("conversation transport URL uses the receiver's current collection root without appending an id", () => {
  const { definition } = fixture();
  const current = { urlRoot: "conversations", conversation_id: "7Public" };
  assert.equal(definition.url.call(current), "conversations");
  current.urlRoot = "public-conversations";
  assert.equal(definition.url.call(current), "public-conversations");
});

test("conversation route follows the receiver's current identity", () => {
  const { definition } = fixture();
  const current = receiver(definition, "7Public");
  assert.equal(definition.defaults.url_name.call(current), "/7Public");
  current.conversation_id = "8Other";
  assert.equal(definition.defaults.url_name.call(current), "/8Other");
});

test("moderation route excludes the obsolete moderator invitation segment", () => {
  const { definition } = fixture();
  const current = { conversation_id: "7Public", minvite: "public-invite" };
  assert.equal(definition.defaults.url_moderate.call(current), "/m/7Public");
});

test("forced visualization route retains its explicit visualization query", () => {
  const { definition } = fixture();
  assert.equal(definition.defaults.url_force_vis.call({ conversation_id: "7Public" }), "/7Public/?vis_type=1");
});

test("local share URL includes the configured port and retains its existing scheme-less shape", () => {
  const { definition } = fixture("localhost", "5000");
  assert.equal(
    definition.defaults.url_name_with_hostname.call(receiver(definition, "7Public")),
    "localhost:5000/7Public"
  );
});

test("public Polis share URL includes HTTPS and preserves an explicit port", () => {
  const { definition } = fixture("pol.is", "8443");
  assert.equal(
    definition.defaults.url_name_with_hostname.call(receiver(definition, "7Public")),
    "https://pol.is:8443/7Public"
  );
});

test("share URL reads the current document location each time and omits an absent port delimiter", () => {
  const { definition, document } = fixture("localhost", "5000");
  const current = receiver(definition, "7Public");
  assert.equal(definition.defaults.url_name_with_hostname.call(current), "localhost:5000/7Public");
  document.location.hostname = "public.example.invalid";
  document.location.port = "";
  assert.equal(definition.defaults.url_name_with_hostname.call(current), "public.example.invalid/7Public");
});

test("canonical public share URL ignores local hostname/port and delegates the route with its receiver", () => {
  const { definition } = fixture("localhost", "5000");
  const current = {
    conversation_id: "7Public",
    url_name() {
      assert.equal(this, current);
      return "/7Public?public_view=1";
    }
  };
  assert.equal(
    definition.defaults.url_name_with_production_hostname.call(current),
    "https://pol.is/7Public?public_view=1"
  );
});

test("URL helpers do not share conversation identity between independent receivers", () => {
  const { definition } = fixture("pol.is");
  const first = receiver(definition, "7Public"),
    second = receiver(definition, "8Other");
  assert.equal(definition.defaults.url_name_with_hostname.call(second), "https://pol.is/8Other");
  assert.equal(definition.defaults.url_name_with_production_hostname.call(first), "https://pol.is/7Public");
  assert.equal(definition.defaults.url_moderate.call(second), "/m/8Other");
  assert.equal(definition.defaults.url_force_vis.call(first), "/7Public/?vis_type=1");
  assert.equal(first.conversation_id, "7Public");
  assert.equal(second.conversation_id, "8Other");
});
