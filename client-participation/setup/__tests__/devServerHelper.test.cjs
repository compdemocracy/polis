const { afterEach, beforeEach, mock, test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchConversationData, createMockConversationData } = require("../dev-server-helper");

const now = 1704067200000;
const originalApiUrl = process.env.API_URL;

beforeEach(() => {
  mock.method(Date, "now", () => now);
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(globalThis, "fetch", async () => {
    throw new Error("public offline fixture");
  });
});

afterEach(() => {
  mock.restoreAll();
  if (originalApiUrl === undefined) delete process.env.API_URL;
  else process.env.API_URL = originalApiUrl;
});

function assertFallback(data, conversationId) {
  assert.equal(data.conversation.conversation_id, conversationId);
  assert.equal(data.nextComment.conversation_id, conversationId);
  assert.equal(data.user, null);
  assert.equal(data.ptpt, null);
  assert.deepEqual(data.votes, []);
  assert.deepEqual(data.famous, []);
  assert.deepEqual(JSON.parse(data.pca), { comment_count: 1, group_count: 0, n: 0 });
  assert.equal(data.conversation.created, now - 86400000);
  assert.equal(data.conversation.modified, now);
  assert.equal(data.nextComment.created, now - 3600000);
}

test("requests anonymous participation initialization and returns the API object unchanged", async () => {
  const data = { conversation: { conversation_id: "7Public" }, votes: [{ tid: 0, vote: -1 }] };
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => data }));
  assert.equal(await fetchConversationData("7Public", "https://public.example"), data);
  assert.deepEqual(globalThis.fetch.mock.calls[0].arguments, [
    "https://public.example/api/v3/participationInit?conversation_id=7Public&pid=-1&lang=acceptLang",
    { method: "GET", headers: { Accept: "application/json", "Content-Type": "application/json" } }
  ]);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test("the default API URL is read when the request is made", async () => {
  process.env.API_URL = "https://environment.example";
  await fetchConversationData("7Public");
  assert.match(globalThis.fetch.mock.calls[0].arguments[0], /^https:\/\/environment\.example\//);
});

test("a non-success HTTP response consumes its diagnostic body and returns development data", async () => {
  let bodyReads = 0;
  globalThis.fetch.mock.mockImplementation(async () => ({
    ok: false,
    status: 503,
    statusText: "Unavailable",
    text: async () => {
      bodyReads++;
      return "public service unavailable";
    },
    json: async () => assert.fail("error response must not be admitted as API data")
  }));
  assertFallback(await fetchConversationData("8Offline", "https://public.example"), "8Offline");
  assert.equal(bodyReads, 1);
});

test("an unreadable error body still yields development data", async () => {
  globalThis.fetch.mock.mockImplementation(async () => ({
    ok: false,
    status: 500,
    text: async () => {
      throw new Error("public body read failure");
    }
  }));
  assertFallback(await fetchConversationData("8Offline", "https://public.example"), "8Offline");
});

test("a network rejection yields development data without a second request", async () => {
  assertFallback(await fetchConversationData("8Offline", "https://public.example"), "8Offline");
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test("invalid JSON in a success response yields development data", async () => {
  globalThis.fetch.mock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("public invalid JSON fixture");
    }
  }));
  assertFallback(await fetchConversationData("8Offline", "https://public.example"), "8Offline");
});

test("a 304 without a JSON body follows the existing development fallback", async () => {
  let jsonReads = 0;
  globalThis.fetch.mock.mockImplementation(async () => ({
    ok: false,
    status: 304,
    text: async () => assert.fail("304 does not take the HTTP-error body path"),
    json: async () => {
      jsonReads++;
      throw new SyntaxError("public empty response");
    }
  }));
  assertFallback(await fetchConversationData("8Offline", "https://public.example"), "8Offline");
  assert.equal(jsonReads, 1);
});

test("each fallback object has independent arrays and conversation state", () => {
  const first = createMockConversationData("7Public");
  const second = createMockConversationData("8Offline");
  first.votes.push({ tid: 0, vote: 1 });
  first.conversation.topic = "Changed locally";
  assertFallback(second, "8Offline");
  assert.notEqual(first.conversation.topic, second.conversation.topic);
});
