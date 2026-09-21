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

function wrapper(name) {
  const deferreds = [];
  const jquery = {
    extend(options, callbacks) {
      return Object.assign(options || {}, callbacks);
    },
    Deferred() {
      // Record exactly what the wrapper submits to jQuery. This double does not
      // emulate Deferred callback argument conversion, scheduling or settlement.
      const record = { calls: [], promise: Object.freeze({ deferred: deferreds.length }) };
      deferreds.push(record);
      return {
        resolveWith(context, args) {
          record.calls.push({ method: "resolveWith", context, args });
        },
        rejectWith(context, args) {
          record.calls.push({ method: "rejectWith", context, args });
        },
        promise() {
          return record.promise;
        }
      };
    }
  };
  return {
    invoke: load(`${name}.js`, { jquery, lodash: { bind: (fn, receiver) => fn.bind(receiver) } }),
    deferreds
  };
}

for (const [name, method] of [
  ["bbFetch", "fetch"],
  ["bbDestroy", "destroy"]
]) {
  test(`${name} preserves options and returns the deferred promise instead of the transport result`, () => {
    const boundary = wrapper(name);
    const options = { wait: true, data: { public_id: 7 }, success() {}, error() {} };
    const previousSuccess = options.success;
    let received, receiver;
    const model = {
      [method](value) {
        receiver = this;
        received = value;
        return { abort() {} };
      }
    };
    const result = boundary.invoke(model, options);
    assert.equal(receiver, model);
    assert.equal(received, options);
    assert.equal(received.wait, true);
    assert.deepEqual(received.data, { public_id: 7 });
    assert.notEqual(received.success, previousSuccess);
    assert.equal(typeof received.error, "function");
    assert.equal(result, boundary.deferreds[0].promise);
    assert.deepEqual(boundary.deferreds[0].calls, []);
  });

  test(`${name} forwards its current callback arguments to the Deferred boundary without parsing response bodies`, () => {
    const boundary = wrapper(name);
    let callbacks;
    const model = {
      [method](options) {
        callbacks = options;
      }
    };
    boundary.invoke(model);
    const body = { public_value: "unchanged" };
    callbacks.success(model, body, callbacks);
    const error = {
      status: 422,
      responseText: '{"code":"public_validation"}',
      responseJSON: { code: "public_validation" }
    };
    callbacks.error(model, error, callbacks);
    assert.deepEqual(boundary.deferreds[0].calls, [
      { method: "resolveWith", context: model, args: body },
      { method: "rejectWith", context: model, args: error }
    ]);
    assert.equal(boundary.deferreds[0].calls[1].args, error);
    // The second arguments are raw objects, not callback argument arrays. This
    // records the existing adapter boundary, not successful jQuery propagation.
    assert.equal(Array.isArray(boundary.deferreds[0].calls[0].args), false);
  });

  test(`${name} concurrent models retain independent deferreds when callbacks complete out of order`, () => {
    const boundary = wrapper(name);
    const pending = [];
    const model = () => ({ [method]: (options) => pending.push(options) });
    const first = model(),
      second = model();
    const firstPromise = boundary.invoke(first, {}),
      secondPromise = boundary.invoke(second, {});
    assert.notEqual(firstPromise, secondPromise);
    pending[1].error(second, { status: 503 });
    assert.deepEqual(boundary.deferreds[0].calls, []);
    pending[0].success(first, { public_value: 1 });
    assert.equal(boundary.deferreds[0].calls[0].context, first);
    assert.equal(boundary.deferreds[1].calls[0].context, second);
    assert.equal(boundary.deferreds[0].calls[0].method, "resolveWith");
    assert.equal(boundary.deferreds[1].calls[0].method, "rejectWith");
  });

  test(`${name} does not convert a synchronous transport exception into Deferred rejection`, () => {
    const boundary = wrapper(name),
      error = new Error("public transport failure");
    assert.throws(
      () =>
        boundary.invoke(
          {
            [method]() {
              throw error;
            }
          },
          {}
        ),
      (actual) => actual === error
    );
    assert.deepEqual(boundary.deferreds[0].calls, []);
  });
}

test("bbSave passes attribute/options identity and preserves every success callback argument", () => {
  const boundary = wrapper("bbSave"),
    attrs = { text: "public comment" },
    options = { wait: true, patch: true };
  let received;
  const model = {
    save(...args) {
      received = args;
      return { abort() {} };
    }
  };
  const promise = boundary.invoke(model, attrs, options);
  assert.equal(received[0], attrs);
  assert.equal(received[1], options);
  assert.equal(options.wait, true);
  assert.equal(options.patch, true);
  assert.equal(promise, boundary.deferreds[0].promise);
  const response = { saved: true };
  options.success(model, response, options);
  const call = boundary.deferreds[0].calls[0];
  assert.equal(call.context, model);
  assert.equal(call.method, "resolveWith");
  assert.deepEqual(Array.from(call.args), [model, response, options]);
});

test("bbSave preserves the error response and callback options without body parsing", () => {
  const boundary = wrapper("bbSave");
  let callbacks;
  const model = {
    save(_attrs, options) {
      callbacks = options;
      return true;
    }
  };
  boundary.invoke(model, { text: "public comment" });
  const response = { status: 400, responseText: "not JSON", responseJSON: undefined };
  callbacks.error(model, response, callbacks);
  const call = boundary.deferreds[0].calls[0];
  assert.equal(call.method, "rejectWith");
  assert.equal(call.context, model);
  assert.deepEqual(Array.from(call.args), [model, response, callbacks]);
  assert.equal(call.args[1], response);
});

test("bbSave false return submits its existing validation marker directly to rejectWith", () => {
  const boundary = wrapper("bbSave"),
    model = {
      save() {
        return false;
      }
    };
  const promise = boundary.invoke(model, {});
  assert.equal(promise, boundary.deferreds[0].promise);
  assert.deepEqual(boundary.deferreds[0].calls, [{ method: "rejectWith", context: model, args: "validation failed" }]);
  // The marker is a string, not an argument array; real jQuery consumption is
  // outside this external-boundary test and is not claimed successful here.
});

test("bbSave concurrent success and validation failure do not share deferred state", () => {
  const boundary = wrapper("bbSave");
  let callbacks;
  const saved = {
    save(_attrs, options) {
      callbacks = options;
      return true;
    }
  };
  const invalid = {
    save() {
      return false;
    }
  };
  boundary.invoke(saved, { text: "valid public comment" }, {});
  boundary.invoke(invalid, {}, {});
  assert.deepEqual(boundary.deferreds[0].calls, []);
  assert.equal(boundary.deferreds[1].calls[0].context, invalid);
  callbacks.success(saved, { saved: true }, callbacks);
  assert.equal(boundary.deferreds[0].calls[0].method, "resolveWith");
  assert.equal(boundary.deferreds[1].calls.length, 1);
});

test("bbSave propagates a synchronous save exception unchanged", () => {
  const boundary = wrapper("bbSave"),
    error = new Error("public save failure");
  assert.throws(
    () =>
      boundary.invoke(
        {
          save() {
            throw error;
          }
        },
        {},
        {}
      ),
    (actual) => actual === error
  );
  assert.deepEqual(boundary.deferreds[0].calls, []);
});

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
