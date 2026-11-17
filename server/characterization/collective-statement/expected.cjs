"use strict";
/**
 * The collective-statement recordings' expected-differences mechanism, as
 * plain functions so the mechanism itself is unit-tested (expected.test.cjs)
 * and the replay (main.cjs) uses exactly the same code. Same rules as the
 * vote-path recordings' mechanism (server/__tests__/setup/vote-path-expected.ts,
 * PR #2951), applied to a recording file's text.
 *
 * An entry names ONE recorded case and spells out the change literally, so the
 * PR diff shows what changes:
 *
 *   { "case": "<case id, e.g. post/eligible>",
 *     "find": "<the changed text, exactly as in the committed recording>",
 *     "replace": "<the new text>",
 *     "whole_response"?: true, "whole_response_reason"?: "<why>",
 *     "why": "<the change>",
 *     "ruling": "pending" | "ruled:<who, when, where>" | "rejected" }
 *
 * Rules (each violation is a named problem; any problem fails the replay):
 *  - one entry per case, and the case must be a recorded case;
 *  - `find` is non-empty and occurs in that case's recording exactly once;
 *  - `find` and `replace` carry at most MAX_CONTEXT characters of unchanged
 *    text around the change (just enough to make `find` unique);
 *  - an entry whose `find` covers WHOLE_SHARE or more of the recording is a
 *    whole-response entry: `find` must then be the whole text and the entry
 *    must say `whole_response: true` with a reason;
 *  - `why` is non-empty; `ruling` is `pending`, `ruled:<reference>` or
 *    `rejected`. Only a `ruled:` entry lets its case pass: a pending or
 *    rejected entry fails the replay with its state.
 * A served recording must then equal the committed one with every entry
 * applied. A case nobody named must be byte-identical; an entry whose case
 * still serves the old bytes fails too (the served text no longer matches the
 * expected one), so a stale entry cannot linger.
 *
 * The index (recordings/index.json) is pinned whole, except for the one thing
 * a case entry can change in it: the provider-request totals. expectedIndex
 * moves egress.providerStubRequests and egress.providerRequestsRecorded by
 * exactly what the ruled entries change in their cases' provider transcripts
 * (the length of each case's "provider" array, committed against expected).
 * No other field moves, a count no ruled entry explains still fails, and with
 * no ruled entry that changes a transcript the committed index is the one
 * compared, as before.
 */
const RULING = /^(pending|rejected|ruled:\S.*)$/;
const MAX_CONTEXT = 120;
const WHOLE_SHARE = 0.9;

/** Characters `find` and `replace` share at their start plus at their end. */
function sharedContext(find, replace) {
  let prefix = 0;
  const max = Math.min(find.length, replace.length);
  while (prefix < max && find[prefix] === replace[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    find[find.length - 1 - suffix] === replace[replace.length - 1 - suffix]
  )
    suffix++;
  return prefix + suffix;
}

/**
 * recorded: { caseId: committed recording text }. Returns the expected text
 * per case, the problems, and the ruling that governs each named case.
 */
function applyExpectedDifferences(recorded, entries) {
  const expected = { ...recorded };
  const problems = [];
  const rulings = {};
  const seen = new Set();
  for (const d of entries) {
    const name = d.case;
    if (seen.has(name)) {
      problems.push(`${name}: more than one entry`);
      continue;
    }
    seen.add(name);
    if (!(name in recorded)) {
      problems.push(`${name}: names no recorded case`);
      continue;
    }
    if (!d.why) problems.push(`${name}: why is empty`);
    if (typeof d.ruling !== "string" || !RULING.test(d.ruling))
      problems.push(
        `${name}: ruling must be "pending", "ruled:<reference>" or "rejected"`
      );
    else if (!d.ruling.startsWith("ruled:"))
      problems.push(`${name}: expected difference is ${d.ruling}, not ruled`);
    rulings[name] = d.ruling;
    const text = recorded[name];
    const hits =
      typeof d.find === "string" && d.find ? text.split(d.find).length - 1 : 0;
    if (hits !== 1) {
      problems.push(`${name}: find occurs ${hits} times in the recording`);
      continue;
    }
    const whole = text.length > 0 && d.find.length >= WHOLE_SHARE * text.length;
    if (whole || d.whole_response) {
      if (d.find !== text)
        problems.push(
          `${name}: a whole-response entry must find the whole text`
        );
      if (d.whole_response !== true || !d.whole_response_reason)
        problems.push(
          `${name}: replaces the whole response; needs whole_response: true and a reason`
        );
    } else {
      const context = sharedContext(d.find, String(d.replace));
      if (context > MAX_CONTEXT)
        problems.push(
          `${name}: carries ${context} unchanged characters; trim find/replace to the change`
        );
    }
    expected[name] = text.replace(d.find, () => String(d.replace));
  }
  return { expected, problems, rulings };
}

/** The number of provider requests a recording text holds, or null. */
function providerCount(text) {
  try {
    const provider = JSON.parse(text).provider;
    return Array.isArray(provider) ? provider.length : null;
  } catch {
    return null;
  }
}

const PROVIDER_TOTALS = ["providerStubRequests", "providerRequestsRecorded"];

/**
 * The index a replay must serve: recordedIndex, with its two provider-request
 * totals moved by the change the ruled entries make to their cases' provider
 * transcripts. recorded: { caseId: committed text }; applied: the result of
 * applyExpectedDifferences on it. Returns { index, problems, notes }.
 */
function expectedIndex(recordedIndex, recorded, applied) {
  const problems = [];
  const notes = [];
  let delta = 0;
  const moved = [];
  for (const [id, ruling] of Object.entries(applied.rulings)) {
    if (!String(ruling).startsWith("ruled:") || !(id in recorded)) continue;
    const before = providerCount(recorded[id]);
    const after = providerCount(applied.expected[id]);
    if (before === null || after === null) {
      problems.push(`${id}: no provider transcript to count`);
      continue;
    }
    if (after !== before) {
      delta += after - before;
      moved.push(`${id} ${before} -> ${after}`);
    }
  }
  if (delta === 0) return { index: recordedIndex, problems, notes };
  const egress = (recordedIndex && recordedIndex.egress) || {};
  const totals = {};
  for (const key of PROVIDER_TOTALS) {
    if (!Number.isInteger(egress[key])) {
      problems.push(`index egress.${key} is not a count`);
      return { index: recordedIndex, problems, notes };
    }
    totals[key] = egress[key] + delta;
  }
  notes.push(
    `index.json: provider requests ${egress.providerRequestsRecorded} -> ${
      totals.providerRequestsRecorded
    } through ruled expected differences (${moved.join(", ")})`
  );
  return {
    index: { ...recordedIndex, egress: { ...egress, ...totals } },
    problems,
    notes,
  };
}

/**
 * Whether a served index equals the expected one. The Postgres schema is
 * compared separately (schema drift is reported field by field) and the case
 * digests are compared through the case texts, so both are left out here.
 */
function sameIndex(expected, served) {
  const strip = (x) => ({
    ...x,
    postgres: { ...x.postgres, schema: undefined },
    cases: x.cases.map((c) => c.id),
  });
  return JSON.stringify(strip(expected)) === JSON.stringify(strip(served));
}

/** Case ids whose served text differs from the expected text. */
function differingCases(served, expected) {
  return Object.keys(expected).filter((id) => served[id] !== expected[id]);
}

module.exports = {
  RULING,
  MAX_CONTEXT,
  WHOLE_SHARE,
  sharedContext,
  applyExpectedDifferences,
  differingCases,
  expectedIndex,
  providerCount,
  sameIndex,
};
