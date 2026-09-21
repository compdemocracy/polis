const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Execute the actual CommonJS router. Its UI, model, analytics and transport
// dependencies are explicit boundary doubles; no browser/history is started.
function fixture(options = {}) {
  const sourcePath = path.resolve(__dirname, "../main-polis-router.js");
  const routes = [],
    metrics = [],
    analytics = [],
    views = [],
    errors = [],
    gets = [],
    models = [];
  let firstRender, done;
  const hidden = [];
  const $ = (selector) => ({ hide: () => hidden.push(selector) });
  $.Deferred = () => ({
    done: (fn) => {
      done = fn;
    },
    resolve: () => done()
  });
  $.get = (url) => {
    gets.push(url);
    return options.commentPromise;
  };
  class Model {
    constructor(value) {
      this.attributes = { ...value };
      models.push(value);
    }
    get(key) {
      return this.attributes[key];
    }
    set(key, value) {
      this.attributes[key] = value;
    }
  }
  const firstConvPromise = {
    then(resolve) {
      if (!options.conversationFailure) {
        return { fail: () => Promise.resolve(resolve(options.remoteConversation || { is_mod: false })) };
      }
      return { fail: (reject) => Promise.resolve().then(() => reject(options.conversationFailure)) };
    }
  };
  const dependencies = {
    jquery: $,
    lodash: { isUndefined: (value) => value === undefined },
    backbone: { Router: { extend: (methods) => methods } },
    "../models/conversation": Model,
    "../models/participant": Model,
    "../eventBus": {
      firstRender: "public-first-render",
      once: (_event, callback) => {
        firstRender = callback;
      }
    },
    "../util/gaMetric": { routeEvent: (...args) => metrics.push(args) },
    "../views/participation": class {
      constructor(value) {
        this.options = value;
      }
    },
    "../util/polisStorage": { getJwtToken: () => options.jwt, uid: () => options.uid },
    "../util/preloadHelper": { firstCommentPromise: options.commentPromise, firstConvPromise },
    "../views/root": { getInstance: () => ({ setView: (view) => views.push(view) }) },
    "../util/constants": { GA_TRACKING_ID: options.analytics },
    "../util/utils": {
      decodeParams: options.decode || (() => ({ vis_type: "2" })),
      parseQueryParams: options.parse || (() => ({ vis_type: "3" }))
    }
  };
  const window = {
    location: { pathname: options.pathname || "/7Public" },
    preloadData: options.preloadData,
    userObject: options.userObject
  };
  const document = { location: { protocol: "https:", host: "public.example.invalid" } };
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    window,
    document,
    Promise,
    console: { error: (...args) => errors.push(args) },
    gtag: (...args) => analytics.push(args),
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
      return dependencies[name];
    }
  });
  new vm.Script(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath }).runInContext(context);
  const router = Object.create(module.exports);
  router.route = (pattern, callback) => routes.push({ pattern, callback });
  return {
    router,
    window,
    document,
    routes,
    metrics,
    analytics,
    views,
    errors,
    gets,
    models,
    hidden,
    firstRender: () => firstRender(),
    Model
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("initialization registers the four public route forms and rejects malformed conversation ids", () => {
  const f = fixture();
  f.router.initialize();
  assert.equal(f.routes.length, 4);
  const examples = ["7Public/?lang=en", "7Public/ep1_Ab12", "ot/7Public/public-invite", "demo/7Public"];
  f.routes.forEach(({ pattern }, index) => assert.ok(pattern.test(examples[index])));
  assert.equal(f.routes[0].pattern.test("not-a-conversation"), false);
  assert.equal(f.routes[1].pattern.test("7Public/other/path"), false);
});

test("registered callback reports its route metric and forwards exact arguments with router context", () => {
  const f = fixture();
  let called;
  f.router.participationViewWithQueryParams = function (...args) {
    called = { owner: this, args };
  };
  f.router.initialize();
  f.routes[0].callback("7Public", "?lang=en");
  assert.equal(called.owner, f.router);
  assert.deepEqual(called.args, ["7Public", "?lang=en"]);
  assert.deepEqual(plain(f.metrics), [["participationViewWithQueryParams", ["7Public", "?lang=en"]]]);
});

test("JWT or existing uid resolves authentication analytics; missing authentication does not", () => {
  for (const options of [{ jwt: "public-token", uid: 0 }, { uid: 7 }, {}]) {
    const f = fixture({ ...options, analytics: "public-tracking" });
    f.router.initialize();
    assert.equal(f.analytics.length, options.jwt || options.uid ? 1 : 0);
    if (f.analytics.length)
      assert.deepEqual(plain(f.analytics[0]), ["set", "user_properties", { user_id: options.uid }]);
  }
});

test("first render hides the loading indicator and disabled analytics stays silent", () => {
  const f = fixture({ jwt: "public-token", uid: 7 });
  f.router.initialize();
  assert.deepEqual(f.hidden, []);
  f.firstRender();
  assert.deepEqual(f.hidden, ["#mainSpinner"]);
  assert.deepEqual(f.analytics, []);
});

test("redirect preserves the captured encoded suffix unless explicitly suppressed", () => {
  const f = fixture({ pathname: "/7Public/ep1_Ab12" });
  f.router.redirect("/8Public");
  assert.equal(f.document.location, "https://public.example.invalid/8Public/ep1_Ab12");
  const g = fixture({ pathname: "/7Public/ep1_Ab12" });
  g.router.redirect("/8Public", true);
  assert.equal(g.document.location, "https://public.example.invalid/8Public");
});

test("encoded and query parameter routes pass decoded values, falling back on decode errors", () => {
  const calls = [];
  const f = fixture({
    decode: (value) => {
      assert.equal(value, "ep1_Ab12");
      return { vis_type: "2" };
    }
  });
  f.router.doLaunchConversation2 = (...args) => calls.push(args);
  f.router.participationView("7Public", "/ep1_Ab12");
  f.router.participationViewWithQueryParams("7Public", "?vis_type=3");
  assert.deepEqual(plain(calls), [
    ["7Public", { vis_type: "2" }],
    ["7Public", { vis_type: "3" }]
  ]);
  for (const method of ["participationView", "participationViewWithQueryParams"]) {
    const g = fixture({
      decode: () => {
        throw Error("public-invalid");
      },
      parse: () => {
        throw Error("public-invalid");
      }
    });
    let args;
    g.router.doLaunchConversation2 = (...value) => {
      args = value;
    };
    g.router[method]("7Public", "/bad");
    assert.deepEqual(plain(args), ["7Public", {}]);
    assert.equal(g.errors.length, 1);
  }
});

test("preloaded conversation is reused without reading the remote conversation promise", async () => {
  const preloadData = { conversation: { conversation_id: "7Public" }, public: true };
  const f = fixture({ preloadData, conversationFailure: Error("must not fetch") });
  await f.router.getConversationModel("7Public");
  assert.equal(f.models[0], preloadData);
  assert.deepEqual(f.errors, []);
});

test("single-use invite bypasses preload and binds the invite to the remotely supplied model", async () => {
  const remoteConversation = { conversation_id: "7Public", is_mod: false };
  const f = fixture({ preloadData: { conversation: {} }, remoteConversation });
  const model = await f.router.getConversationModel("7Public", "public-invite");
  assert.equal(f.models[0], remoteConversation);
  assert.equal(model.get("suzinvite"), "public-invite");
});

test("remote conversation rejection is preserved and logged", async () => {
  const failure = Error("public-network-failure"),
    f = fixture({ conversationFailure: failure });
  await assert.rejects(f.router.getConversationModel("7Public"), (error) => error === failure);
  assert.equal(f.errors.length, 1);
  assert.equal(f.models.length, 0);
});

test("launch forwards the early comment promise and tutorial state, with moderator-only visualization override", async () => {
  for (const moderator of [true, false]) {
    const commentPromise = Promise.resolve({ public: true });
    const f = fixture({
      remoteConversation: { is_mod: moderator, vis_type: 1 },
      commentPromise,
      userObject: { finishedTutorial: true }
    });
    f.router.doLaunchConversation2("7Public", { vis_type: "3", wipCommentFormText: "public draft" });
    await new Promise(setImmediate);
    assert.equal(f.views.length, 1);
    const options = f.views[0].options;
    assert.equal(options.model.get("vis_type"), moderator ? 3 : 1);
    assert.equal(options.firstCommentPromise, commentPromise);
    assert.equal(options.wipCommentFormText, "public draft");
    assert.equal(options.finishedTutorial, true);
    assert.deepEqual(f.gets, []);
  }
});

test("participant launch starts the exact first-comment read and carries the supplied participant", async () => {
  const commentPromise = Promise.resolve({ public: true }),
    f = fixture({ commentPromise });
  const participant = new f.Model({ conversation_id: "7Public" });
  f.router.doLaunchConversation({ ptptModel: participant });
  assert.deepEqual(f.gets, ["/api/v3/nextComment?not_voted_by_pid=-1&limit=1&conversation_id=7Public"]);
  await new Promise(setImmediate);
  assert.equal(f.views[0].options.ptptModel, participant);
  assert.equal(f.views[0].options.firstCommentPromise, commentPromise);
});

test("failed launch does not replace the root view", async () => {
  const f = fixture({ conversationFailure: Error("public-offline") });
  f.router.doLaunchConversation2("7Public", {});
  await new Promise(setImmediate);
  assert.deepEqual(f.views, []);
  assert.ok(f.errors.length >= 1);
});

test("demo and invite routes pass their public routing state without posting a participant", () => {
  const f = fixture();
  let demo, invite;
  f.router.doLaunchConversation = (args) => {
    demo = args.ptptModel;
  };
  f.router.demoConversation("7Public");
  assert.equal(demo.get("pid"), -123);
  assert.equal(demo.get("conversation_id"), "7Public");
  assert.deepEqual(f.gets, []);
  f.router.participationView = (...args) => {
    invite = args;
    return "launched";
  };
  assert.equal(f.router.participationViewWithSuzinvite("7Public", "public-invite"), "launched");
  assert.deepEqual(invite, ["7Public", null, "public-invite"]);
  assert.equal(f.window.suzinvite, "public-invite");
});
