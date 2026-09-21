const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Exercise the actual render overrides with plain receivers. The extension
// boundary captures methods; it does not emulate Handlebones inheritance,
// Backbone lifecycle, template rendering, DOM operations or the real event bus.
function fixture(filename, baseName, { eventFailure, renderFailure } = {}) {
  const calls = [];
  const eventBus = {
    firstRender: "public-first-render",
    trigger(event) {
      assert.equal(this, eventBus);
      calls.push({ kind: "event", event });
      if (eventFailure) throw eventFailure;
    }
  };
  const base = {
    prototype: {
      render(...args) {
        calls.push({ kind: "render", receiver: this, args });
        if (renderFailure) throw renderFailure;
        this.baseRenderCalls = (this.baseRenderCalls || 0) + 1;
        return this;
      }
    },
    extend(methods) {
      return methods;
    }
  };
  const otherName = baseName === "View" ? "ModelView" : "View";
  const dependencies = {
    "../eventBus": eventBus,
    handlebones: {
      [baseName]: base,
      [otherName]: {
        prototype: {
          render() {
            assert.fail("wrong base render");
          }
        },
        extend() {
          assert.fail("wrong base extension");
        }
      }
    }
  };
  const module = { exports: {} },
    source = path.join(__dirname, "..", filename);
  vm.runInNewContext(
    fs.readFileSync(source, "utf8"),
    {
      module,
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), name);
        return dependencies[name];
      }
    },
    { filename: source }
  );
  return { render: module.exports.render, calls, eventBus };
}

for (const [filename, baseName] of [
  ["PolisView.js", "View"],
  ["PolisModelView.js", "ModelView"]
]) {
  test(`${baseName} emits before delegating with the exact receiver and argument identities`, () => {
    const f = fixture(filename, baseName),
      receiver = {},
      options = { force: true },
      callback = () => {};
    const result = f.render.call(receiver, options, callback, undefined);
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ["event", "render"]
    );
    assert.equal(f.calls[0].event, f.eventBus.firstRender);
    assert.equal(f.calls[1].receiver, receiver);
    assert.equal(f.calls[1].args.length, 3);
    assert.equal(f.calls[1].args[0], options);
    assert.equal(f.calls[1].args[1], callback);
    assert.equal(f.calls[1].args[2], undefined);
    assert.equal(receiver.baseRenderCalls, 1);
    // The current override has no return statement. Do not
    // promise base-class chaining that this boundary does not provide.
    assert.equal(result, undefined);
  });

  test(`${baseName} emits firstRender on every invocation without sharing receiver state`, () => {
    const f = fixture(filename, baseName),
      first = {},
      second = {};
    f.render.call(first);
    f.render.call(second);
    f.render.call(first);
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ["event", "render", "event", "render", "event", "render"]
    );
    assert.equal(first.baseRenderCalls, 2);
    assert.equal(second.baseRenderCalls, 1);
    assert.ok(f.calls.filter((call) => call.kind === "event").every((call) => call.event === f.eventBus.firstRender));
    assert.ok(f.calls.filter((call) => call.kind === "render").every((call) => call.args.length === 0));
  });

  test(`${baseName} propagates event failure before any base-render side effect`, () => {
    const failure = new Error("public event failure"),
      receiver = {};
    const f = fixture(filename, baseName, { eventFailure: failure });
    assert.throws(
      () => f.render.call(receiver, { force: true }),
      (error) => error === failure
    );
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ["event"]
    );
    assert.equal(Object.hasOwn(receiver, "baseRenderCalls"), false);
  });

  test(`${baseName} propagates base-render failure after the event without retry`, () => {
    const failure = new Error("public base render failure"),
      receiver = {};
    const f = fixture(filename, baseName, { renderFailure: failure });
    assert.throws(
      () => f.render.call(receiver),
      (error) => error === failure
    );
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ["event", "render"]
    );
    assert.equal(f.calls[1].receiver, receiver);
    assert.equal(Object.hasOwn(receiver, "baseRenderCalls"), false);
  });
}
