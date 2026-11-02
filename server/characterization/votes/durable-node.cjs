"use strict";
// Current Node handler witness, with real Postgres commits and the real vote
// convention. Only follow-on dependencies are controlled. This is not an auth,
// nextComment-selection, HTTP gateway or production-load qualification.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
require("ts-node/register/transpile-only");
const { Client } = require("pg");
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "src/routes/votes.ts");
const convention = require(path.join(root, "src/votes/convention.ts"));
const admin = new Client({ connectionString: process.env.POLIS_VOTES_NODE_TEST_DATABASE_URL });
let db, fault;
const load = Module._load;
const noop = () => {};
Module._load = function (name, parent, ...args) {
  if (name.endsWith("/logger")) return { error: noop, info: noop, warn: noop };
  if (parent?.filename === source) {
    if (name === "../db/pg-query") return {
      query: (...args) => db.query(...args),
      queryP_readOnly: async (...args) => (await db.query(...args)).rows,
    };
    if (name === "../nextComment") return { getNextComment: async () => {
      if (fault === "next") throw Error("controlled next failure");
      return undefined;
    } };
    if (name === "../server-helpers") return {
      safeTimestampToMillis: Number,
      updateLastInteractionTimeForConversation: async () => {},
      addNoMoreCommentsRecord: noop,
      addStar: async () => { if (fault === "star") throw Error("controlled star failure"); },
      finishOne: (res, body) => res.status(200).json(body),
    };
    if (name === "../utils/common") return { isDuplicateKey: e => e.code === "23505" };
    if (name === "../utils/import-target" || name === "../user" || name === "../db/sql"
      || name === "../config" || name === "../utils/sqs" || name === "@aws-sdk/client-sqs") return {};
    if (name === "@aws-sdk/client-s3") return { S3Client: class {} };
  }
  return load.call(this, name, parent, ...args);
};
const { handle_POST_votes } = require(source);
Module._load = load;
async function main() {
  assert.ok(process.env.POLIS_VOTES_NODE_TEST_DATABASE_URL, "disposable database required");
  await admin.connect();
  const name = `node_durable_${process.pid}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.POLIS_VOTES_NODE_TEST_DATABASE_URL);
  url.pathname = "/" + name;
  db = new Client({ connectionString: url.href });
  try {
    await db.connect();
    for (const file of ["000000_initial.sql", "000006_update_votes_rule.sql", "000008_add_comment_priority.sql"]) {
      await db.query(fs.readFileSync(path.join(root, "postgres/migrations", file), "utf8"));
    }
    await db.query("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint'");
    await db.query("INSERT INTO conversations(zid,is_active) VALUES(1,true)");
    const cases = [];
    for (const [name, tid, mode, status] of [
      ["success", 7, null, 200], ["star-failure-after-commit", 8, "star", 500],
      ["next-failure-after-commit", 9, "next", 500], ["retry-after-next-failure", 9, null, 200],
    ]) {
      fault = mode;
      const before = Number((await db.query("SELECT count(*) FROM votes")).rows[0].count);
      const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      await handle_POST_votes({ p: { zid: 1, uid: 1, pid: 0, tid,
        vote: convention.semanticToWire("agree"), high_priority: false,
        ...(mode === "star" ? { starred: true } : {}) } }, response);
      const after = Number((await db.query("SELECT count(*) FROM votes")).rows[0].count);
      assert.equal(response.code, status);
      assert.equal(after - before, 1);
      assert.deepEqual(response.body, status === 200 ? { currentPid: 0 } : {
        error: "polis_err_vote", message: "polis_err_vote", status: 500,
      });
      const latest = (await db.query("SELECT vote FROM votes_latest_unique WHERE tid=$1", [tid])).rows[0];
      assert.equal(convention.storageToSemantic(latest.vote), "agree");
      cases.push({ name, status: response.code, body: response.body, historyAdded: after - before });
    }
    const result = { boundary: "current Node handler and real SQL; controlled follow-on dependencies",
      sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"), cases };
    assert.deepEqual(cases, JSON.parse(fs.readFileSync(path.join(__dirname, "durable-node-cases.json"))).cases);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
