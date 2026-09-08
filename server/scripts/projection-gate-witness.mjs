#!/usr/bin/env node
// Projection-gate WIRE witness.
//
// The Python gate's DB check (delphi/scripts/projection_gate.py) is a psycopg2
// look-alike: it re-issues its own SELECTs and compares psycopg2 values, which
// drops the PostgreSQL type OIDs and the Node serializer. Real int8 (created,
// modified) decodes to the JS string "1000"; int4 decodes to the number 1000 —
// both are Python int 1000 in the preflight. And handle_GET_votes_me adds a
// `weight` field, while finishArray adds `conversation_id` and DELETES `zid`.
//
// This witness binds the gate to the ACTUAL served path: the same node-sql query
// builder (.star()) / literal SQL that server/src/routes/votes.ts runs, the same
// installed `pg` driver type parsing, the same post-query transform, and the same
// finishArray serializer (addConversationIds + delete zid). For each site it
// captures BOTH the served projection (what votes.ts serves today) and the frozen
// explicit projection (what the refactor will serve) THROUGH THAT SAME serializer,
// so a byte/type/key-order divergence — or an internal column reaching the wire —
// is visible. It is read-only (REPEATABLE READ READ ONLY, no writes) and prints a
// JSON document to stdout.
//
// Deps (sql, pg) resolve from server/node_modules; run with that on NODE_PATH when
// invoking from a worktree without an install.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sql = require("sql");
const { Client } = require("pg");

// The vlu definition exactly as server/src/db/sql.ts declares it (so .star()
// renders the identical `"votes_latest_unique".*` wildcard votes.ts emits).
const VLU_SQLTS_COLUMNS = ["zid", "tid", "pid", "modified", "vote", "weight", "high_priority"];
// The FROZEN explicit projections (real DB columns, ordinal order) the refactor
// would select instead of the wildcard.
const FROZEN = {
  votes_latest_unique: ["zid", "pid", "tid", "vote", "weight_x_32767", "modified"],
  votes: ["zid", "pid", "tid", "vote", "weight_x_32767", "created", "high_priority"],
};

function parseArgs(argv) {
  const out = { pid: null, tid: null, sites: ["votesGet", "handle_GET_votes_me"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dsn") out.dsn = argv[++i];
    else if (a === "--zid") out.zid = parseInt(argv[++i], 10);
    else if (a === "--pid") out.pid = parseInt(argv[++i], 10);
    else if (a === "--tid") out.tid = parseInt(argv[++i], 10);
    else if (a === "--sites") out.sites = argv[++i].split(",").filter(Boolean);
  }
  if (!out.dsn || out.zid === undefined || Number.isNaN(out.zid)) {
    throw new Error("usage: --dsn <dsn> --zid <int> [--pid <int>] [--tid <int>] [--sites a,b]");
  }
  return out;
}

// node-sql query for votesGet, exactly as votes.ts builds it (value inlined via
// .toString(), which is what votes.ts passes to query_readOnly with no params).
function vluServedSql(zid, pid, tid) {
  const t = sql.define({ name: "votes_latest_unique", columns: VLU_SQLTS_COLUMNS });
  let q = t.select(t.star()).where(t.zid.equals(zid));
  if (pid !== null) q = q.where(t.pid.equals(pid));
  if (tid !== null) q = q.where(t.tid.equals(tid));
  return q.toString();
}
// The frozen explicit projection the refactor will use, built the same way.
function vluExpectedSql(zid, pid, tid) {
  const t = sql.define({ name: "votes_latest_unique", columns: FROZEN.votes_latest_unique });
  let q = t.select.apply(t, FROZEN.votes_latest_unique.map((c) => t[c])).where(t.zid.equals(zid));
  if (pid !== null) q = q.where(t.pid.equals(pid));
  if (tid !== null) q = q.where(t.tid.equals(tid));
  return q.toString();
}

// finishArray, faithfully: addConversationIds (a zinvites lookup) then delete zid.
async function finishArraySerialize(client, rows) {
  const zids = [...new Set(rows.filter((r) => r.zid).map((r) => Number(r.zid)))];
  const map = {};
  if (zids.length) {
    const zr = await client.query(`select * from zinvites where zid in (${zids.join(",")})`);
    for (const o of zr.rows) map[o.zid] = o.zinvite;
  }
  for (const o of rows) o.conversation_id = map[o.zid]; // undefined => dropped by JSON
  for (const o of rows) {
    if (o.zid) delete o.zid; // finishArray: "ensure we don't expose zid"
  }
  return rows;
}

// handle_GET_votes_me applies this to each row BEFORE finishArray. `weight` is not
// a column on `votes`, so this is undefined/32767 = NaN => JSON null — reproduced
// exactly so the gate sees the real served shape, latent quirk included.
function applyVotesMeWeight(rows) {
  for (const r of rows) r.weight = r.weight / 32767;
  return rows;
}

async function captureSite(client, site, a) {
  let servedSql, expectedSql, weight = false, table;
  if (site === "votesGet") {
    table = "votes_latest_unique";
    servedSql = vluServedSql(a.zid, a.pid, a.tid);
    expectedSql = vluExpectedSql(a.zid, a.pid, a.tid);
  } else if (site === "handle_GET_votes_me") {
    table = "votes";
    weight = true;
    const cols = FROZEN.votes.map((c) => `"votes"."${c}"`).join(", ");
    if (a.pid !== null) {
      servedSql = { text: "SELECT * FROM votes WHERE zid = ($1) AND pid = ($2)", values: [a.zid, a.pid] };
      expectedSql = { text: `SELECT ${cols} FROM votes WHERE zid = ($1) AND pid = ($2)`, values: [a.zid, a.pid] };
    } else {
      servedSql = { text: "SELECT * FROM votes WHERE zid = ($1)", values: [a.zid] };
      expectedSql = { text: `SELECT ${cols} FROM votes WHERE zid = ($1)`, values: [a.zid] };
    }
  } else {
    throw new Error(`unknown site: ${site}`);
  }

  async function run(spec) {
    const res = typeof spec === "string" ? await client.query(spec) : await client.query(spec.text, spec.values);
    let rows = res.rows;
    if (weight) applyVotesMeWeight(rows);
    rows = await finishArraySerialize(client, rows);
    return rows;
  }

  const served = await run(servedSql);
  const expected = await run(expectedSql);
  return {
    table,
    servedSql: typeof servedSql === "string" ? servedSql : servedSql.text,
    expectedSql: typeof expectedSql === "string" ? expectedSql : expectedSql.text,
    served,
    expected,
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: a.dsn });
  await client.connect();
  const out = {};
  try {
    // One read-only snapshot per site (served + expected + zinvites share it).
    for (const site of a.sites) {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        out[site] = await captureSite(client, site, a);
        await client.query("ROLLBACK");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + "\n");
  process.exit(1);
});
