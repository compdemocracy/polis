"use strict";
const assert = require("node:assert/strict");
const { firstDiff } = require("../core.cjs");
function differences(expected, actual) {
  assert.equal(expected.format, "treevite-recordings/1");
  assert.equal(actual.format, expected.format);
  assert.deepEqual(
    actual.comparison,
    expected.comparison,
    "comparison policy changed"
  );
  assert.deepEqual(
    actual.recordings.map((r) => r.case),
    expected.recordings.map((r) => r.case),
    "case inventory changed"
  );
  return actual.recordings.flatMap((r, i) => {
    const difference = firstDiff(expected.recordings[i], r);
    return difference ? [{ case: r.case, difference }] : [];
  });
}
module.exports = { differences };
