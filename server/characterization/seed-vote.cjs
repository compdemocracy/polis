"use strict";
/**
 * The one JavaScript helper for server test and seed code that writes vote rows
 * (P-078 PR-G).
 *
 * A seed that INSERTs into `votes` bypasses the API, so the number it writes is a
 * storage-sign value. Every such writer in server/ names the vote by MEANING
 * ("agree" | "disagree" | "pass") and takes the stored number from here; no seed
 * spells the storage sign itself.
 *
 * Where the storage sign comes from, in order:
 *   1. the database's own convention row, `vote_convention_current()` (P-078
 *      PR-A), when the seed holds a connection to a database that has it
 *      (`databaseConvention(pool)`), exactly as `vote_insert()` would;
 *   2. otherwise the declared fallback for data that carries no declaration:
 *      `STORAGE_AGREE_VALUE` of delphi/polismath/utils/vote_convention.py, the one
 *      statement of the historical convention (P-078 §1a), read from that file so
 *      it is never restated here.
 *
 * The wire (what clients POST) is a different number and is NOT this module's
 * business: API-level tests post wire values through their own wire helper.
 */
const fs = require("node:fs");
const path = require("node:path");

const VOTES = Object.freeze(["agree", "disagree", "pass"]);
const CONVENTION_FILE = path.join(
  __dirname,
  "../../delphi/polismath/utils/vote_convention.py"
);

class SeedVoteError extends Error {}

function validAgreeValue(value) {
  if (value !== 1 && value !== -1) {
    throw new SeedVoteError(
      `a storage convention is the integer -1 or +1, got ${String(value)}`
    );
  }
  return value;
}

let declared = null;
/** The declared fallback: the Python module's STORAGE_AGREE_VALUE. */
function declaredStorageAgreeValue() {
  if (declared === null) {
    const text = fs.readFileSync(CONVENTION_FILE, "utf8");
    const found = text.match(
      /^STORAGE_AGREE_VALUE:\s*int\s*=\s*([+-]?\d+)\s*$/m
    );
    if (!found)
      throw new SeedVoteError(
        `no STORAGE_AGREE_VALUE statement in ${CONVENTION_FILE}`
      );
    declared = validAgreeValue(Number(found[1]));
  }
  return declared;
}

function convention(agreeValue) {
  return agreeValue === undefined || agreeValue === null
    ? declaredStorageAgreeValue()
    : validAgreeValue(agreeValue);
}

/** The number a seed stores in votes.vote for a vote named by meaning. */
function seedVote(vote, agreeValue) {
  const agree = convention(agreeValue);
  switch (vote) {
    case "agree":
      return agree;
    case "disagree":
      return -agree;
    case "pass":
      return 0;
    default:
      throw new SeedVoteError(`not a vote: ${String(vote)}`);
  }
}

/** A stored votes.vote back to its meaning; NULL stays null. */
function readVote(raw, agreeValue) {
  if (raw === null || raw === undefined) return null;
  const agree = convention(agreeValue);
  if (raw === agree) return "agree";
  if (raw === -agree) return "disagree";
  if (raw === 0) return "pass";
  throw new SeedVoteError(`not a stored vote: ${String(raw)}`);
}

/**
 * The storage convention of the database behind `client` (a pg Pool or
 * Client): the row's agree_value when the database carries vote_convention
 * (P-078 PR-A), else the declared fallback (such a database is at version 0).
 */
async function databaseConvention(client) {
  const present = await client.query(
    "SELECT to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present"
  );
  if (!present.rows[0].present) return declaredStorageAgreeValue();
  const row = await client.query(
    "SELECT agree_value FROM public.vote_convention_current()"
  );
  return validAgreeValue(Number(row.rows[0].agree_value));
}

module.exports = {
  VOTES,
  SeedVoteError,
  declaredStorageAgreeValue,
  seedVote,
  readVote,
  databaseConvention,
};
