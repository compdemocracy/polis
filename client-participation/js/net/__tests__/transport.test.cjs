const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// Execute unchanged product CommonJS exports. Only external dependency boundaries
// are replaced; no global loader patch, browser, network or copied product logic.
function load(name, dependencies) {
  const filename = path.join(__dirname, "..", name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = (request) => {
    assert.ok(Object.hasOwn(dependencies, request), `unexpected dependency: ${request}`);
    return dependencies[request];
  };
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

function ajaxBoundary(tokens = []) {
  const merges = [],
    requests = [],
    pending = [];
  let tokenReads = 0;
  const Backbone = {
    ajax(url, options) {
      const promise = new Promise((resolve, reject) => pending.push({ resolve, reject }));
      promise.abort = () => "public abort result";
      requests.push({ url, options, promise });
      return promise;
    }
  };
  const jquery = {
    extend(deep, options, additions) {
      // Assert the request handed to jQuery's deep-merge boundary, and return a
      // unique result. Do not duplicate or pretend to test jQuery's deep merge.
      const result = { merge: merges.length };
      merges.push({ deep, options, additions, result });
      return result;
    }
  };
  load("backbonePolis.js", {
    jquery,
    backbone: Backbone,
    "../util/url": { urlPrefix: "https://public.example.invalid/polis/" },
    "../util/polisStorage": {
      getJwtToken() {
        return tokens[tokenReads++];
      }
    }
  });
  return { Backbone, merges, requests, pending, tokenReads: () => tokenReads };
}

test("Backbone AJAX string signature prefixes the route and forwards the deep-merge result", () => {
  const b = ajaxBoundary(),
    data = { public_id: 7 },
    options = { type: "GET", data, timeout: 5000 };
  const result = b.Backbone.ajax("comments?limit=2", options);
  assert.equal(b.requests[0].url, "https://public.example.invalid/polis/api/v3/comments?limit=2");
  assert.equal(b.merges[0].deep, true);
  assert.equal(b.merges[0].options, options);
  assert.equal(b.requests[0].options, b.merges[0].result);
  assert.equal(b.merges[0].additions.data, data);
  assert.equal(result, b.requests[0].promise);
  assert.equal(result.abort(), "public abort result");
});

test("Backbone AJAX object signature retains caller method/callback options at the merge boundary", () => {
  const b = ajaxBoundary(),
    options = { url: "votes", type: "POST", data: '{"vote":1}', success() {}, error() {} };
  const ignored = { url: "other" };
  b.Backbone.ajax(options, ignored);
  assert.equal(b.requests[0].url, "https://public.example.invalid/polis/api/v3/votes");
  assert.equal(b.merges[0].options, options);
  assert.equal(b.merges[0].options.error, options.error);
  assert.deepEqual(b.merges[0].additions, {
    contentType: "application/json",
    processData: false,
    dataType: "json",
    data: options.data,
    headers: { "Cache-Control": "max-age=0" },
    xhrFields: { withCredentials: true }
  });
});

test("Backbone AJAX transport policy is the overriding input to the options merge", () => {
  const b = ajaxBoundary(["public-token"]);
  const options = {
    contentType: "text/plain",
    processData: true,
    dataType: "text",
    headers: { Authorization: "caller-token", "Cache-Control": "no-store" },
    xhrFields: { withCredentials: false }
  };
  b.Backbone.ajax("participants", options);
  assert.deepEqual(b.merges[0].additions.headers, {
    Authorization: "Bearer public-token",
    "Cache-Control": "max-age=0"
  });
  assert.equal(b.merges[0].additions.xhrFields.withCredentials, true);
  assert.equal(b.merges[0].additions.processData, false);
  assert.equal(b.merges[0].additions.contentType, "application/json");
  assert.equal(b.merges[0].additions.dataType, "json");
});

test("Backbone AJAX rereads tokens for each request and omits its authorization addition when absent", () => {
  const b = ajaxBoundary(["public-first", null, "public-next"]);
  for (let i = 0; i < 3; i++) b.Backbone.ajax("comments", {});
  assert.equal(b.tokenReads(), 3);
  assert.equal(b.merges[0].additions.headers.Authorization, "Bearer public-first");
  assert.equal(Object.hasOwn(b.merges[1].additions.headers, "Authorization"), false);
  assert.equal(b.merges[2].additions.headers.Authorization, "Bearer public-next");
  assert.notEqual(b.merges[0].additions.headers, b.merges[2].additions.headers);
});

test("Backbone AJAX preserves successful response identity through the original transport promise", async () => {
  const b = ajaxBoundary(),
    response = { comments: [{ tid: 0, text: "public comment" }] };
  const result = b.Backbone.ajax("comments", {});
  b.pending[0].resolve(response);
  assert.equal(await result, response);
});

test("Backbone AJAX preserves rejected status and opaque error-body identity", async () => {
  const b = ajaxBoundary(),
    error = { status: 502, responseText: "<public upstream error>", responseJSON: undefined };
  const result = b.Backbone.ajax("comments", {});
  const rejection = assert.rejects(result, (actual) => actual === error);
  b.pending[0].reject(error);
  await rejection;
});

test("Backbone AJAX concurrent requests retain their own response and rejection paths", async () => {
  const b = ajaxBoundary(["public-first", "public-second"]);
  const first = b.Backbone.ajax("comments", { data: { public_id: 7 } });
  const second = b.Backbone.ajax("votes", { data: { public_id: 8 } });
  assert.notEqual(first, second);
  const error = { status: 409, responseText: "public conflict" },
    response = { accepted: true };
  const rejection = assert.rejects(first, (actual) => actual === error);
  b.pending[1].resolve(response);
  b.pending[0].reject(error);
  assert.equal(await second, response);
  await rejection;
  assert.equal(b.merges[0].additions.data.public_id, 7);
  assert.equal(b.merges[1].additions.data.public_id, 8);
});
