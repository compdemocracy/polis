"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { readVote, validAgreeValue } = require("./seed-vote.cjs");

// P-078 PR-G. Recorded database effects carry stored vote values, whose sign is
// the storage convention of the database they were recorded against. Each
// recording states its own: the recorder writes vote-convention.json into the
// recording (integrity-pinned in its index like every shared artifact), and a
// recording without one (the committed baseline, recorded before this) falls
// back to the committed companion artifacts/baseline.sign.json, checked against
// the committed baseline bytes. A live replay passes the convention of the
// database it runs against. Given conventions, the comparator compares the
// MEANING of each stored vote, so the same request is the same case under
// either convention while a changed vote still differs; without them it
// compares raw values, as it always has. No recorded byte is rewritten.
const STORED_VOTE_TABLES = Object.freeze([
  "pg:votes",
  "pg:votes_latest_unique",
]);
const STORED_VOTE_FIELD = "vote";
const RECORDING_CONVENTION = "vote-convention.json";
const DECLARATION = path.join(__dirname, "artifacts/baseline.sign.json");
function agreeValueOf(value, where) {
  try {
    return validAgreeValue(value);
  } catch (e) {
    throw Error(`${where}: ${e.message}`);
  }
}
let declaration = null;
/** The committed baseline's companion, checked against the committed bytes. */
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
    agreeValueOf(meta.storage_agree_value, DECLARATION);
    declaration = meta;
  }
  return declaration;
}
/** What the recorder writes into a recording: the convention it recorded under. */
function recordingConventionArtifact(storageAgreeValue) {
  return {
    schema: "recording-vote-convention/1",
    storage_agree_value: agreeValueOf(storageAgreeValue, "recorder"),
    stored_vote_tables: STORED_VOTE_TABLES,
    stored_vote_field: STORED_VOTE_FIELD,
    source:
      "vote_convention_current() of the recorded database when present, else the declared fallback (seed-vote.cjs)",
  };
}
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
/**
 * The storage convention a recording directory was recorded under, honoured
 * ONLY when it is bound to the recording's integrity-pinned index:
 *   - vote-convention.json listed in index.json files, its bytes matching the
 *     listed sha256 and byte_length (what the recorder writes);
 *   - else the committed companion artifacts/baseline.sign.json, only for the
 *     recording whose index.json hashes to its recording_index_sha256 (the
 *     unpacked committed baseline, recorded before recorders wrote one).
 * A vote-convention.json present but not indexed, or not matching its index
 * entry, is refused with a closed error: a sidecar dropped beside a recording
 * must never make inverted stored votes compare equal. Otherwise null: no
 * convention is known and stored votes are compared raw.
 */
function recordingConvention(dir) {
  const indexBytes = fs.readFileSync(path.join(dir, "index.json"));
  const index = JSON.parse(indexBytes);
  const own = path.join(dir, RECORDING_CONVENTION);
  const entries = (index.files || []).filter(
    (f) => f.path === RECORDING_CONVENTION
  );
  if (entries.length > 1)
    throw Error(
      `P078_CONVENTION_REFUSED: ${RECORDING_CONVENTION} indexed twice`
    );
  if (!entries.length) {
    if (fs.existsSync(own))
      throw Error(
        `P078_CONVENTION_REFUSED: ${own} is not listed in the recording's index`
      );
    const meta = baselineDeclaration();
    if (sha256(indexBytes) === meta.recording_index_sha256)
      return {
        storageAgreeValue: meta.storage_agree_value,
        source: path.relative(__dirname, DECLARATION),
      };
    return null;
  }
  if (!fs.existsSync(own))
    throw Error(`P078_CONVENTION_REFUSED: indexed ${own} is missing`);
  const bytes = fs.readFileSync(own);
  if (
    sha256(bytes) !== entries[0].sha256 ||
    bytes.length !== entries[0].byte_length
  )
    throw Error(
      `P078_CONVENTION_REFUSED: ${own} does not match its index entry`
    );
  const meta = JSON.parse(bytes);
  if (meta.schema !== "recording-vote-convention/1")
    throw Error(
      `P078_CONVENTION_REFUSED: ${own}: not a recording-vote-convention/1 artifact`
    );
  return {
    storageAgreeValue: agreeValueOf(meta.storage_agree_value, own),
    source: RECORDING_CONVENTION,
  };
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
  if (agreeValue === undefined || agreeValue === null) return copy;
  agreeValueOf(agreeValue, "comparator");
  for (const table of STORED_VOTE_TABLES) {
    const effect = copy.effects?.db?.[table];
    if (!effect) continue;
    for (const side of ["added", "removed"])
      for (const row of effect[side] || [])
        if (Object.prototype.hasOwnProperty.call(row, STORED_VOTE_FIELD))
          row[STORED_VOTE_FIELD] = storedVoteMeaning(
            row[STORED_VOTE_FIELD],
            agreeValue
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
 * names the storage convention of each side's stored votes (a replay passes
 * the recording's own, recordingConvention(dir), and the live database's,
 * see cli.cjs); a side left out takes the other's. With neither, stored votes
 * are compared raw.
 */
function firstDifference(expected, actual, conventions = {}) {
  const { firstDiff } = require("./core.cjs");
  const e = conventions.expected ?? conventions.actual,
    l = conventions.actual ?? conventions.expected;
  const a = comparable(expected, e),
    b = comparable(actual, l);
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
  recordingConvention,
  recordingConventionArtifact,
  RECORDING_CONVENTION,
  STORED_VOTE_TABLES,
  STORED_VOTE_FIELD,
};
