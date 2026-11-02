"use strict";
const assert = require("node:assert/strict");
const { policy } = require("../normalize.cjs");
const profile = { version: 3, profile: "identity", symbolFields: ["site_ids"] };
// The fixture declares the extension. Consumers must load and validate it before
// comparing generated site identifiers and their derived response headers.
function applyProfile(recorded) {
  assert.deepEqual(
    recorded,
    profile,
    "unsupported identity comparison profile"
  );
  assert.equal(policy.version, recorded.version);
  for (const field of recorded.symbolFields) {
    if (!policy.symbolFields.includes(field)) policy.symbolFields.push(field);
  }
}
module.exports = { profile, applyProfile };
