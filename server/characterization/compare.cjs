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
function firstDifference(expected, actual) {
  const { firstDiff } = require("./core.cjs");
  const a = comparable(expected),
    b = comparable(actual);
  // Name served fields before their serialized bytes and derived headers.
  const field = firstDiff(a, b, "$", {
    $: [
      "response",
      "effects",
      "process",
      "routeHits",
      "orderedHeaders",
      "wireBody",
    ],
    "$.response": ["body"],
  });
  if (!field || !firstDiff(a.response.body, b.response.body)) return field;
  const consequences = [];
  for (const [i, h] of a.orderedHeaders.entries()) {
    const other = b.orderedHeaders[i],
      name = h.name.toLowerCase();
    if (
      !other ||
      other.name.toLowerCase() !== name ||
      h.value === other.value ||
      !["content-length", "etag"].includes(name)
    )
      continue;
    const derive = (c) => {
      const body = Buffer.from(c.wireBody, "base64");
      return name === "content-length"
        ? String(body.length)
        : require("express/lib/utils").wetag(body);
    };
    // A mismatched header is not a consequence unless both derivations hold.
    if (h.value === derive(a) && other.value === derive(b))
      consequences.push(`$.orderedHeaders.${i}.value (${name})`);
  }
  return (
    field +
    (consequences.length
      ? ` (body-derived consequences: ${consequences.join(", ")})`
      : "")
  );
}
module.exports = { comparable, firstDifference };
