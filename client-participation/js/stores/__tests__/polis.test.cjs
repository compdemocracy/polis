const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Run the actual factory. Transport, event bus, model collection, and jQuery
// are external doubles. Geometry/polling/Deferred settlement are not exercised.
function fixture({ language = "", conversation = "7Public" } = {}) {
  const calls = [],
    events = [],
    tokens = [],
    additions = [];
  let response = {};
  const transport = (method) => (url, body) => {
    calls.push({ method, url, body });
    return Promise.resolve(response);
  };
  const dependencies = {
    "../eventBus": { pidChange: "pid", on() {}, trigger: (...args) => events.push(args) },
    deepcopy: () => {
      throw new Error("unexpected geometry");
    },
    "../util/postMessageUtils": {},
    "../util/preloadHelper": {},
    "../util/utils": {
      isDemoMode: () => false,
      uiLanguage: () => language,
      getBestTranslation: (rows, lang) => rows.find((row) => row.lang === lang)
    },
    "../util/net": { polisPost: transport("POST"), polisPut: transport("PUT"), polisGet: transport("GET") },
    "../util/polisStorage": { setJwtToken: (token) => tokens.push(token) },
    jquery: { extend: Object.assign, Callbacks: () => ({ add() {}, remove() {} }), Deferred: () => ({}) },
    lodash: { isUndefined: (value) => value === undefined, isNumber: (value) => typeof value === "number" },
    "../3rdparty/d3.v4.min": {}
  };
  const votes = {
    models: [{ attributes: { tid: 2, vote: -1 } }],
    map: (fn) => [{ get: () => 2 }, { get: () => 3 }].map(fn),
    add: (...args) => additions.push(args)
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, "../polis.js");
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      window: {},
      console: { log() {}, error() {} },
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), name);
        return dependencies[name];
      }
    },
    { filename }
  );
  const store = module.exports({ conversation_id: conversation, votesByMe: votes, logger: { error() {} } });
  return {
    store,
    calls,
    events,
    tokens,
    votes,
    additions,
    reply(value) {
      response = value;
    }
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("vote actions preserve polarity, optional star state, and conversation scope", async () => {
  const f = fixture();
  await f.store.agree(2, false, true);
  await f.store.disagree(3, true, false);
  await f.store.pass(4);
  assert.deepEqual(
    f.calls.map((call) => plain(call.body)),
    [
      { high_priority: true, vote: -1, tid: 2, starred: false, pid: -1, conversation_id: "7Public", agid: 1 },
      { high_priority: false, vote: 1, tid: 3, starred: true, pid: -1, conversation_id: "7Public", agid: 1 },
      { vote: 0, tid: 4, pid: -1, conversation_id: "7Public", agid: 1 }
    ]
  );
  assert.ok(f.calls.every((call) => call.method === "POST" && call.url === "api/v3/votes"));
});

test("vote response stores returned auth and uses the new participant for later votes", async () => {
  const f = fixture();
  const response = { auth: { token: "public-fixture-token" }, currentPid: 8 };
  f.reply(response);
  assert.equal(await f.store.agree(2), response);
  assert.deepEqual(f.tokens, [response.auth.token]);
  assert.deepEqual(f.events, [["pid", 8]]);
  f.reply({});
  await f.store.pass(3);
  assert.equal(f.calls[1].body.pid, 8);
});

test("invalid negative participant identity does not replace the current participant", async () => {
  const f = fixture();
  f.reply({ currentPid: -2 });
  await f.store.agree(2);
  f.reply({});
  await f.store.agree(3);
  assert.deepEqual(f.events, []);
  assert.equal(f.calls[1].body.pid, -1);
});

test("translated next comment selects the requested language while retaining response identity", async () => {
  const f = fixture({ language: "fr" });
  const translation = { lang: "fr", txt: "Public" };
  const response = { nextComment: { translations: [{ lang: "en" }, translation] } };
  f.reply(response);
  assert.equal(await f.store.pass(3), response);
  assert.equal(f.calls[0].body.lang, "fr");
  assert.equal(response.nextComment.translations, translation);
});

test("next-comment cache follows created responses and clears on exhaustion", async () => {
  const f = fixture({ language: "fr" });
  const comment = { tid: 9, created: 1 };
  f.reply(comment);
  assert.equal(await f.store.getNextComment({ notTid: 0 }), comment);
  assert.deepEqual(plain(f.calls[0].body), {
    not_voted_by_pid: -1,
    limit: 1,
    conversation_id: "7Public",
    lang: "fr",
    without: [0]
  });
  assert.equal(f.store.unvotedCommentsExist(), true);
  f.reply({});
  await f.store.getNextComment();
  assert.equal(f.store.unvotedCommentsExist(), false);
});

test("preloaded comment cache waits for resolution and stays isolated between stores", async () => {
  const a = fixture(),
    b = fixture({ conversation: "8Other" });
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  a.store.setNextCachedComment(pending);
  assert.equal(a.store.unvotedCommentsExist(), false);
  resolve({ tid: 2, created: 1 });
  await pending;
  assert.equal(a.store.unvotedCommentsExist(), true);
  assert.equal(b.store.unvotedCommentsExist(), false);
  a.store.setNextCachedComment(Promise.resolve(null));
  await Promise.resolve();
  assert.equal(a.store.unvotedCommentsExist(), false);
});

test("moderation coerces supplied flags and retains conversation and comment identity", async () => {
  const f = fixture();
  await f.store.mod(4, { spam: "yes", offtopic: 0 });
  assert.deepEqual(plain(f.calls[0]), {
    method: "POST",
    url: "api/v3/ptptCommentMod",
    body: {
      conversation_id: "7Public",
      tid: 4,
      spam: true,
      offtopic: false,
      important: false
    }
  });
});

test("participant extension update binds the active conversation and preserves transport result", async () => {
  const f = fixture();
  const response = { accepted: true },
    params = { conversation_id: "8Other", public_field: "value" };
  f.reply(response);
  assert.equal(await f.store.put_participants_extended(params), response);
  assert.equal(params.conversation_id, "7Public");
  assert.equal(f.calls[0].body, params);
  assert.equal(f.calls[0].method, "PUT");
});

test("vote collection helpers preserve attributes and explicitly merge additions", () => {
  const f = fixture();
  assert.deepEqual(plain(f.store.getVotedOnTids()), [2, 3]);
  assert.equal(f.store.getVotesByMe()[0], f.votes.models[0].attributes);
  const vote = { tid: 3, vote: 1 };
  f.store.addToVotesByMe(vote);
  assert.equal(f.additions[0][0], vote);
  assert.deepEqual(plain(f.additions[0][1]), { merge: true });
});

test("separate store instances never share participant state or request conversation", async () => {
  const a = fixture(),
    b = fixture({ conversation: "8Other" });
  a.reply({ currentPid: 8 });
  await a.store.agree(2);
  await b.store.agree(3);
  assert.equal(b.calls[0].body.pid, -1);
  assert.equal(b.calls[0].body.conversation_id, "8Other");
});
