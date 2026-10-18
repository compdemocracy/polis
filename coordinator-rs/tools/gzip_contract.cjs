"use strict";
const { gunzipSync } = require("node:zlib");
const assert = require("node:assert/strict");

// Check the actual cached response, not a recompression of the declared JSON.
function assertGzipJson(value) {
  assert.ok(Buffer.isBuffer(value.asBufferOfGzippedJson), "missing cached gzip");
  assert.equal(typeof value.asJSON, "string", "missing cached JSON");
  assert.ok(
    gunzipSync(value.asBufferOfGzippedJson).equals(Buffer.from(value.asJSON)),
    "cached gzip does not decompress to the exact JSON bytes"
  );
}
module.exports = { assertGzipJson };
