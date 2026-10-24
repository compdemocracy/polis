"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { oracle } = require("../core.cjs");
const { PROVIDER_TIMEOUT, observation } = require("./observation.cjs");
const timeoutCase = () => ({
  caseId: "post-comments/language-timeout", case: "language-timeout",
  request: { method: "POST", path: "/api/v3/comments" },
  observationProfile: { ...PROVIDER_TIMEOUT },
});
const response = { completed: true, ttlbMs: 5100, ttfbMs: 5050 };

test("unmarked cases retain the exact default oracle and sender deadline", () => {
  assert.deepEqual(observation({}, true), { oracle });
  assert.deepEqual(observation({}, false), { oracle });
  assert.equal(observation({}).oracle(response, []).pass, false);
});
test("declared provider timeout captures eventual response after Node budget", () => {
  const profile = observation(timeoutCase(), true);
  assert.equal(profile.deadlineMs, 10000);
  assert.equal(profile.oracle(response, []).pass, true);
});
test("timeout profile rejects every other case and route", () => {
  for (const change of [
    { caseId: "post-comments/language-error" }, { case: "language-error" },
    { request: { method: "GET", path: "/api/v3/comments" } },
    { request: { method: "POST", path: "/api/v3/votes" } },
  ]) assert.throws(() => observation({ ...timeoutCase(), ...change }, true));
});
test("timeout profile cannot run without comments isolation", () => {
  assert.throws(() => observation(timeoutCase(), false));
});
test("profile metadata and deadline are exact and cannot be supplied freely", () => {
  for (const profile of [{}, { ...PROVIDER_TIMEOUT, deadlineMs: 60000 },
    { ...PROVIDER_TIMEOUT, extra: true }]) {
    assert.throws(() => observation({ ...timeoutCase(), observationProfile: profile }, true));
  }
});
test("eventual observation still fails slow, incomplete and process-error responses", () => {
  const profile = observation(timeoutCase(), true);
  for (const value of [{ ...response, completed: false },
    { ...response, ttlbMs: 10001 }, { ...response, ttfbMs: 10001 }]) {
    assert.equal(profile.oracle(value, []).pass, false);
  }
  assert.equal(profile.oracle(response, ["unhandled rejection"]).pass, false);
});
