/*
 * CO08 / O1 candidate `loadBundle`: a coherent whole-Bundle Node reader, and the
 * torn separate-read path it replaces, driven against the same test PostgreSQL as
 * the D4 harness.
 *
 * The server reader that exists today reads each math table on its own
 * connection: `getPca` selects `math_main`, `getBidIndexToPidMapping` selects
 * `math_bidtopid` (server/src/utils/pca.ts, participants.ts), and `getPidsForGid`
 * joins the two by calling both in turn. Nothing pins them to one generation, so
 * a publication that lands between the two reads is served as an OLD main with a
 * NEW mapping — exactly the "old-main/new-mapping" hazard O1 names.
 *
 * `loadBundle` reads all of main + bidtopid + ptptstats + the math_ticks
 * checkpoint inside ONE `REPEATABLE READ READ ONLY` snapshot, so every field
 * belongs to the generation visible when the snapshot opened, regardless of a
 * concurrent publish. The mapping accessor here is pure: it derives bidToPid and
 * per-group pids from the Bundle's own rows, never a fresh query. Missing or
 * tick-mismatched companions fail admission rather than returning a torn Bundle.
 *
 * This is a candidate reader realised in the Node runtime for the experiment's
 * D4 harness. It is NOT the production `server/src` rewrite (that wiring through
 * getPidsForGid/doFamousQuery/report.ts, a bounded whole-Bundle cache and full
 * application boot are the remaining O1/S5 obligations); it is the witness that
 * the immutable-Bundle contract closes the torn read the existing reader allows.
 *
 * Usage: node bundle_reader.cjs '<json spec>'
 *   {"mode":"bundle"|"torn","zid":1,"env":"rustproto","gids":[0,1],
 *    "pause":{"reached":"/path/reached","release":"/path/release","timeout_ms":150000}}
 * DATABASE_URL must be set. Writes one JSON object to stdout.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const server = path.resolve(__dirname, "../../server");
// Use the server's own dependency tree, the same `pg` the reader uses.
const serverRequire = createRequire(path.join(server, "package.json"));
const { Client } = serverRequire("pg");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const COORDINATOR_SQL_SHA256 = "df4b0a1a2df69a666ffd4894b4e231f121ac7d67da7c533738f5dd4a8ddef695";
if (sha256(fs.readFileSync(path.join(server, "postgres/migrations/000021_create_polis_coordinator.sql"))) !== COORDINATOR_SQL_SHA256) {
  throw new Error("COORDINATOR_SCHEMA_BYTE_PIN");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The server's exact per-table query shape, one table at a time — what
// getPca / getBidIndexToPidMapping issue, minus the transforms irrelevant here.
// node-postgres returns bigint as a string; math_tick is small, so coerce it to
// a Number for comparison with the JSONB math_tick the blob carries.
async function selectRow(client, table, zid, env) {
  const result = await client.query(
    `select data, math_tick from ${table} where zid = $1 and math_env = $2`,
    [zid, env]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { data: row.data, math_tick: Number(row.math_tick) };
}

async function selectCheckpoint(client, zid, env) {
  const result = await client.query(
    "select t.math_tick, g.publisher_epoch, g.operation_id, g.input_checkpoint" +
      " from math_ticks t left join polis_coordinator_generations g" +
      " on g.zid=t.zid and g.math_env=t.math_env and g.math_tick=t.math_tick" +
      " where t.zid = $1 and t.math_env = $2",
    [zid, env]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    math_tick: Number(row.math_tick),
    publisher_epoch: row.publisher_epoch === null ? null : Number(row.publisher_epoch),
    operation_id: row.operation_id,
    input_checkpoint: row.input_checkpoint,
  };
}

// The getPidsForGid transform (participants.ts), applied to the Bundle's own
// rows rather than re-reading the database.
function pidsForGid(main, bidToPidData, gid) {
  const clusters = main["group-clusters"];
  const indexToBid = main["base-clusters"].id;
  const bidToIndex = [];
  for (let i = 0; i < indexToBid.length; i++) bidToIndex[indexToBid[i]] = i;
  const indexToPids = bidToPidData.bidToPid;
  const cluster = clusters[gid];
  if (!cluster) return [];
  let pids = [];
  for (const bid of cluster.members) {
    const morePids = indexToPids ? indexToPids[bidToIndex[bid]] : null;
    if (morePids) Array.prototype.push.apply(pids, morePids);
  }
  return pids.map((x) => parseInt(x)).sort((a, b) => a - b);
}

async function reachAndWait(pause, extra) {
  if (!pause) return;
  fs.writeFileSync(pause.reached, JSON.stringify({ pid: process.pid, ...extra }));
  const deadline = Date.now() + (pause.timeout_ms || 150000);
  while (Date.now() < deadline) {
    if (fs.existsSync(pause.release)) return;
    await sleep(10);
  }
  throw new Error("bundle_reader pause: release was never signalled");
}

// The immutable whole-Bundle read.
async function loadBundle(client, zid, env, gids, pause) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const main = await selectRow(client, "math_main", zid, env);
  // A publish interleaving here must not tear the Bundle: everything below is
  // read from the same snapshot taken at the first statement.
  await reachAndWait(pause, { stage: "after_main", main_tick: main ? main.math_tick : null });
  const bidtopid = await selectRow(client, "math_bidtopid", zid, env);
  const ptptstats = await selectRow(client, "math_ptptstats", zid, env);
  const checkpoint = await selectCheckpoint(client, zid, env);
  await client.query("COMMIT");

  if (!main) return { math_env: env, present: false };

  // Admission: a coherent Bundle needs all three companions and a checkpoint at
  // the same generation. Anything else is refused, not served torn.
  const ticks = [
    ["math_bidtopid", bidtopid],
    ["math_ptptstats", ptptstats],
    ["math_ticks", checkpoint],
  ];
  for (const [name, row] of ticks) {
    if (!row) return { math_env: env, present: true, admission: "REFUSED", reason: `missing ${name}` };
    if (row.math_tick !== main.math_tick) {
      return {
        math_env: env, present: true, admission: "REFUSED",
        reason: `${name} at generation ${row.math_tick}, main at ${main.math_tick}`,
      };
    }
  }
  const joins = {};
  for (const gid of gids) joins[gid] = pidsForGid(main.data, bidtopid.data, gid);
  return {
    math_env: env, present: true, admission: "ok",
    // The generation is the DB column math_tick, shared by all four rows. The
    // engine wall-clock field inside the main blob (data.math_tick) is a
    // different quantity and is deliberately not part of this equality.
    coherent:
      main.math_tick === bidtopid.math_tick &&
      main.math_tick === ptptstats.math_tick &&
      main.math_tick === checkpoint.math_tick,
    math_tick: main.math_tick,
    main_tick: main.math_tick,
    bidtopid_tick: bidtopid.math_tick,
    ptptstats_tick: ptptstats.math_tick,
    ticks_tick: checkpoint.math_tick,
    publisher_epoch: checkpoint.publisher_epoch,
    operation_id: checkpoint.operation_id,
    mapping_sha256: sha256(JSON.stringify(bidtopid.data)),
    pids_for_gid: joins,
  };
}

// The naive separate-read path, as a COPIED SQL-shaped model on one client — NOT
// a call through the real getPca / getBidIndexToPidMapping. The real getPidsForGid
// dispatches its two reads via Promise.all (participants.ts), i.e. concurrently,
// not sequentially; independent statement snapshots still permit the same race, so
// this reproduces the hazard but is not the real reader. The real-module byte
// equality is exercised separately by tools/node_reader.cjs / test_node_reader.py.
async function tornRead(client, zid, env, pause) {
  const main = await selectRow(client, "math_main", zid, env);
  await reachAndWait(pause, { stage: "after_main", main_tick: main ? main.math_tick : null });
  const bidtopid = await selectRow(client, "math_bidtopid", zid, env);
  if (!main || !bidtopid) return { math_env: env, present: false };
  return {
    math_env: env, present: true,
    main_tick: main.math_tick,
    bidtopid_tick: bidtopid.math_tick,
    // True when the separate reads observed two different generations.
    torn: main.math_tick !== bidtopid.math_tick,
  };
}

async function main() {
  const spec = JSON.parse(process.argv[2]);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const zid = spec.zid, env = spec.env || "rustproto", gids = spec.gids || [];
    const out =
      spec.mode === "torn"
        ? await tornRead(client, zid, env, spec.pause)
        : await loadBundle(client, zid, env, gids, spec.pause);
    process.stdout.write(JSON.stringify(out));
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String((error && error.stack) || error) + "\n");
    process.exit(1);
  }
);
