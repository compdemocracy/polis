const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const Constants = require("../../util/constants");

function fixture(participantCount) {
  let hidden = false, width = 100, listener;
  const fades = [];
  const calls = { init: 0, comments: 0 };
  const noop = () => {};
  const pending = { then: noop, resolve: noop };
  // Child views, DOM events and timers stay inert; drive only person updates
  // and fade completions through the real participation view methods.
  class Child {
    on() {}
    set() {}
    addSelectionChangedListener() {}
    addInfoPaneButtonClickedListener() {}
    showLineToCluster() {}
    upsertNode() {}
    getFirstShowDeferred() { return pending; }
  }
  const dom = { on: noop, show: noop, hide: noop, html: noop, remove: noop, width: () => width };
  const $ = (selector) => {
    if (selector === "#vis_section:hidden") return { length: hidden ? 1 : 0 };
    if (selector === "#vis_section") return { ...dom, fadeIn: (duration, complete) => fades.push({ duration, complete }) };
    return dom;
  };
  $.Deferred = () => pending;
  const filename = path.join(__dirname, "../participation.js");
  const source = fs.readFileSync(filename, "utf8");
  const dependencies = Object.fromEntries([...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => [m[1], Child]));
  Object.assign(dependencies, {
    backbone: { Model: Child },
    jquery: $,
    lodash: {
      map: (items, fn) => items.map(fn),
      once: (fn) => fn,
      throttle: (fn) => fn,
      isUndefined: (value) => value === undefined
    },
    "../util/constants": Constants,
    "../util/display": { xs: () => false },
    "../eventBus": { on: noop, trigger: noop },
    "../views/conversation": { extend: (definition) => definition },
    "../util/utils": { isIE8: () => false, isMobile: () => false, supportsVis: () => true }
  });
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: (name) => dependencies[name], document: { body: {} }, setTimeout: noop }, { filename });
  const personUpdate = () => listener([], [], participantCount);
  const receiver = Object.assign(Object.create(module.exports), {
    model: { get: () => Constants.VIS_TYPE.PCA },
    serverClient: {
      setNextCachedComment: noop,
      removePersonUpdateListener: noop,
      addPersonUpdateListener: (fn) => {
        listener = fn;
        personUpdate(); // The store broadcasts immediately on registration.
      },
      getFancyComments: () => {
        calls.comments++;
        return pending;
      }
    },
    allCommentsCollection: { length: 0 },
    votesByMe: { on: noop },
    $el: dom,
    addChild: (child) => child,
    listenTo: noop,
    render: noop,
    updateTopComments: noop
  });
  receiver.doInit({});
  receiver.initPcaVis(); // Capture the real nested listener via the store stub.
  const init = receiver.initPcaVis;
  receiver.initPcaVis = () => { calls.init++; init(); };
  calls.comments = 0;
  fades.length = 0;
  return {
    calls, fades, personUpdate,
    setHidden: (value) => { hidden = value; },
    changeWidth: () => { width++; },
    completeFade: () => { hidden = false; fades[0].complete(); }
  };
}

for (const participantCount of [7, 8]) {
  test(`hidden section fades and initializes at participant count ${participantCount}`, () => {
    const f = fixture(participantCount);
    f.setHidden(true);
    f.changeWidth();
    f.personUpdate();
    assert.equal(f.fades.length, 1);
    assert.equal(f.fades[0].duration, 1000);
    assert.equal(f.calls.init, 0);
    assert.equal(f.calls.comments, 1); // Ordinary person update.
    f.completeFade();
    assert.equal(f.calls.init, 1);
    assert.equal(f.calls.comments, 2); // Initializer re-registers the listener.
    assert.equal(f.fades.length, 1); // Its visible-section broadcast cannot fade again.
  });

  test(`visible section skips fade and initialization at participant count ${participantCount}`, () => {
    const f = fixture(participantCount);
    f.changeWidth(); // The dimension equality guard must not mask the regression.
    f.personUpdate();
    assert.equal(f.fades.length, 0);
    assert.equal(f.calls.init, 0);
    // updateVis2 still makes its ordinary request; there is no extra request
    // from a fade completion re-registering the person listener.
    assert.equal(f.calls.comments, 1);
  });
}
