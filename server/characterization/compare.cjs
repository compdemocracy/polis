"use strict";
function comparable(c) {
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.response.ttfbMs;
  delete copy.response.ttlbMs;
  copy.wireBody = require("./wire.cjs").comparableBody(copy);
  copy.orderedHeaders = require("./wire.cjs").comparableHeaders(copy);
  delete copy.wire;
  delete copy.credentialWireValidation;
  for (const attempt of copy.effects.outbound) {
    delete attempt.at_ms;
    if (attempt.response?.$metadata) delete attempt.response.$metadata;
  }
  for (const event of copy.process) delete event.at_ms;
  if (process.env.P027_MARKERS === "0") {
    delete copy.routeHits;
  }
  return copy;
}
module.exports = { comparable };
