"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { readVote } = require("./seed-vote.cjs");

// P-078 PR-G. Recorded database effects carry stored vote values, whose sign is
// the storage convention of the database they were recorded against. The
// committed baseline declares its own (artifacts/baseline.sign.json); a live
// replay passes the convention of the database it runs against. The comparator
// compares the MEANING of each stored vote, so the same request is the same
// case under either convention, while a changed vote still differs. No
// recorded byte is rewritten.
const DECLARATION = path.join(__dirname, "artifacts/baseline.sign.json");
let declaration = null;
function baselineDeclaration() {
  if (declaration === null) {
    const meta = JSON.parse(fs.readFileSync(DECLARATION, "utf8"));
    if (meta.schema !== "declared-vote-sign/1")
      throw Error(`${DECLARATION}: not a declared-vote-sign/1 companion`);
    const bytes = fs.readFileSync(
      path.join(path.dirname(DECLARATION), meta.fixture)
    );
    if (
      crypto.createHash("sha256").update(bytes).digest("hex") !==
      meta.fixture_sha256
    )
      throw Error(
        `${DECLARATION}: ${meta.fixture} changed after its sign was declared`
      );
    if (meta.storage_agree_value !== 1 && meta.storage_agree_value !== -1)
      throw Error(`${DECLARATION}: storage_agree_value must be -1 or +1`);
    declaration = meta;
  }
  return declaration;
}
function storedVoteMeaning(raw, agreeValue) {
  if (raw === null || raw === undefined) return raw;
  try {
    return readVote(raw, agreeValue);
  } catch {
    return `not a stored vote: ${String(raw)}`; // still compared, never hidden
  }
}
/** Replace each stored vote in the recorded effects with its meaning. */
function normalizeStoredVotes(copy, agreeValue) {
  const meta = baselineDeclaration();
  const agree = agreeValue ?? meta.storage_agree_value;
  for (const table of meta.stored_vote_tables) {
    const effect = copy.effects?.db?.[table];
    if (!effect) continue;
    for (const side of ["added", "removed"])
      for (const row of effect[side] || [])
        if (Object.prototype.hasOwnProperty.call(row, meta.stored_vote_field))
          row[meta.stored_vote_field] = storedVoteMeaning(
            row[meta.stored_vote_field],
            agree
          );
  }
  return copy;
}
function comparable(c, storageAgreeValue) {
  const copy = normalizeStoredVotes(
    JSON.parse(JSON.stringify(c)),
    storageAgreeValue
  );
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
/**
 * The first field in which `actual` differs from `expected`. `conventions`
 * names the storage convention of each side's stored votes: `expected`
 * defaults to the baseline's declaration, `actual` to the same value (a replay
 * passes the live database's own, see cli.cjs).
 */
function firstDifference(expected, actual, conventions = {}) {
  const { firstDiff } = require("./core.cjs");
  const a = comparable(expected, conventions.expected),
    b = comparable(actual, conventions.actual);
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
module.exports = {
  comparable,
  firstDifference,
  baselineDeclaration,
  normalizeStoredVotes,
};
