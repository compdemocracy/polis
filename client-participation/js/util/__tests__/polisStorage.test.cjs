const { beforeEach, afterEach, test, mock } = require("node:test");
const assert = require("node:assert/strict");

// Public cache fixtures exercise parsing/storage only, not JWT signature admission.
const previousPrefix = process.env.OIDC_CACHE_KEY_PREFIX;
const previousSuffix = process.env.OIDC_CACHE_KEY_ID_TOKEN_SUFFIX;
process.env.OIDC_CACHE_KEY_PREFIX = "public-oidc:";
process.env.OIDC_CACHE_KEY_ID_TOKEN_SUFFIX = "@@user@@";
const storage = require("../polisStorage");
for (const [key, previous] of [
  ["OIDC_CACHE_KEY_PREFIX", previousPrefix],
  ["OIDC_CACHE_KEY_ID_TOKEN_SUFFIX", previousSuffix]
]) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

const now = 1704067200;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const token = (payload) => `public.${Buffer.from(JSON.stringify(payload)).toString("base64")}.fixture`;
const valid = (conversation = "7Public", uid = 12) => token({ conversation_id: conversation, uid, exp: now + 60 });
function cache() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

beforeEach(() => {
  mock.method(Date, "now", () => now * 1000);
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  globalThis.window = {
    location: { pathname: "/7Public" },
    localStorage: cache(),
    sessionStorage: cache(),
    preload: { firstUser: { uid: 99, created: 123 } }
  };
});
afterEach(() => {
  mock.restoreAll();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

test("stores each participant token under its own conversation and reads only the active conversation", () => {
  const first = valid();
  const other = valid("8Other", 13);
  storage.setJwtToken(first);
  storage.setJwtToken(other);
  assert.equal(window.localStorage.getItem("participant_token_7Public"), first);
  assert.equal(window.localStorage.getItem("participant_token_8Other"), other);
  assert.equal(storage.getJwtToken(), first);
});

for (const pathname of ["/7Public", "/conversation/7Public", "/m/7Public", "/demo/7Public"]) {
  test(`resolves the conversation token from the ${pathname} route`, () => {
    window.location.pathname = pathname;
    const expected = valid();
    window.localStorage.setItem("participant_token_7Public", expected);
    assert.equal(storage.getJwtToken(), expected);
  });
}

test("explicit conversation context takes precedence over the URL", () => {
  window.Polis = { conversation_id: "8Other" };
  window.localStorage.setItem("participant_token_7Public", valid());
  const expected = valid("8Other");
  window.localStorage.setItem("participant_token_8Other", expected);
  assert.equal(storage.getJwtToken(), expected);
});

test("a token expiring now is refused and removed from both caches without clearing other conversations", () => {
  const expired = token({ conversation_id: "7Public", exp: now });
  const other = valid("8Other");
  for (const cache of [window.localStorage, window.sessionStorage]) {
    cache.setItem("participant_token_7Public", expired);
    cache.setItem("participant_token_8Other", other);
  }
  assert.equal(storage.getJwtToken(), null);
  for (const cache of [window.localStorage, window.sessionStorage]) {
    assert.equal(cache.getItem("participant_token_7Public"), null);
    assert.equal(cache.getItem("participant_token_8Other"), other);
  }
});

test("malformed stored tokens are refused and removed", () => {
  window.localStorage.setItem("participant_token_7Public", "not-a-token");
  assert.equal(storage.getJwtToken(), null);
  assert.equal(window.localStorage.getItem("participant_token_7Public"), null);
});

test("tokens without a conversation identity cannot be stored", () => {
  storage.setJwtToken(token({ uid: 12, exp: now + 60 }));
  storage.setJwtToken("not-a-token");
  storage.setJwtToken(null);
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
});

test("OIDC fallback skips ID-token entries, expired entries and malformed JSON before using session access token", () => {
  const entry = (accessToken, expiresAt = now + 60) =>
    JSON.stringify({ body: { access_token: accessToken }, expiresAt });
  window.localStorage.setItem("public-oidc:identity@@user@@", entry(valid("ignored-id")));
  window.localStorage.setItem("public-oidc:expired", entry(valid("expired-cache"), now));
  window.localStorage.setItem("public-oidc:malformed", "not-json");
  window.localStorage.setItem("unrelated-cache", entry(valid("unrelated")));
  const expected = valid("session-auth", 44);
  window.sessionStorage.setItem("public-oidc:access", entry(expected));
  assert.equal(storage.getJwtToken(), expected);
  assert.equal(storage.uid(), 44);
});

test("valid participant identity wins over preload identity, and missing tokens fall back to preload", () => {
  assert.equal(storage.uid(), 99);
  storage.setJwtToken(valid("7Public", 12));
  assert.equal(storage.uid(), 12);
  assert.equal(storage.userCreated(), 123);
});

test("session storage supports participant tokens when local storage is unavailable", () => {
  window.localStorage = undefined;
  const expected = valid();
  storage.setJwtToken(expected);
  assert.equal(window.sessionStorage.getItem("participant_token_7Public"), expected);
  assert.equal(storage.getJwtToken(), expected);
});

test("clearing the current token preserves another conversation and OIDC cache entries", () => {
  for (const cache of [window.localStorage, window.sessionStorage]) {
    cache.setItem("participant_token_7Public", valid());
    cache.setItem("participant_token_8Other", valid("8Other"));
    cache.setItem("public-oidc:access", "public-cache-value");
  }
  storage.clearJwtToken();
  for (const cache of [window.localStorage, window.sessionStorage]) {
    assert.equal(cache.getItem("participant_token_7Public"), null);
    assert.notEqual(cache.getItem("participant_token_8Other"), null);
    assert.equal(cache.getItem("public-oidc:access"), "public-cache-value");
  }
});

test("clear without a conversation context leaves stored participant tokens alone", () => {
  window.location.pathname = "/about";
  const expected = valid();
  window.localStorage.setItem("participant_token_7Public", expected);
  storage.clearJwtToken();
  assert.equal(window.localStorage.getItem("participant_token_7Public"), expected);
});

test("storage access errors yield no token instead of escaping into the UI", () => {
  window.localStorage.getItem = () => {
    throw new Error("public storage refusal");
  };
  assert.equal(storage.getJwtToken(), null);
});
