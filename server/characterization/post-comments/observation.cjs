"use strict";

const assert = require("node:assert/strict");
const { oracle } = require("../core.cjs");

const PROVIDER_TIMEOUT = Object.freeze({
  name: "post-comments-provider-timeout/1",
  deadlineMs: 10000,
  nodeDetectionBudgetMs: 5000,
});

// This is an eventual-response observation, never a participation latency proof.
// Unmarked cases keep the shared sender and oracle's original two-second bound.
function observation(c, enabled = process.env.P027_COMMENTS_PROFILE === "1") {
  if (c.observationProfile === undefined) return { oracle };
  assert.equal(enabled, true, "comments observation requires its sealed profile");
  assert.equal(c.caseId, "post-comments/language-timeout");
  assert.equal(c.case, "language-timeout");
  assert.equal(c.request.method, "POST");
  assert.equal(c.request.path, "/api/v3/comments");
  assert.deepEqual(c.observationProfile, PROVIDER_TIMEOUT);
  return {
    deadlineMs: PROVIDER_TIMEOUT.deadlineMs,
    oracle(response, processErrors) {
      const failures = [];
      if (response.ttlbMs > PROVIDER_TIMEOUT.deadlineMs ||
          response.ttfbMs > PROVIDER_TIMEOUT.deadlineMs)
        failures.push("provider-timeout observation bound exceeded");
      if (!response.completed) failures.push("completion deadline exceeded");
      if (processErrors.length) failures.push("process error during case");
      return { pass: failures.length === 0, failures,
        flag: "eventual provider fallback; not participation latency qualification" };
    },
  };
}

module.exports = { PROVIDER_TIMEOUT, observation };
