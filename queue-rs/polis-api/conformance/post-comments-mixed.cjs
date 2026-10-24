"use strict";
// Real Node and Rust HTTP writers, the same migrated disposable conversation.
// No production module is replaced and valid votes are never inserted here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const requireServer = createRequire(path.resolve("server/package.json"));
const { Client } = requireServer("pg");
const { generateKeyPairSync } = require("node:crypto");
const { once } = require("node:events");
const wait = ms => new Promise(r => setTimeout(r, ms));
const pair = generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" } });
Object.assign(process.env, { JWT_PRIVATE_KEY: pair.privateKey, JWT_PUBLIC_KEY: pair.publicKey,
  SHOULD_USE_TRANSLATION_API: "false", DEV_MODE: "true", NODE_ENV: "production", TESTING: "true",
  ADMIN_UIDS: "[]", POLIS_JWT_ISSUER: "https://fixture.invalid/", POLIS_JWT_AUDIENCE: "participants" });
assert.match(process.env.DATABASE_URL || "", /^postgres(?:ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\//);
const port = Number(process.env.POST_COMMENTS_RUST_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
assert.ok(process.env.POLIS_API_BIN);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comment-writer-"));
const publicFile = path.join(directory, "public.pem");
fs.writeFileSync(publicFile, pair.publicKey);
let child, server, client;
async function until(f) { for (let i = 0; i < 400; i++) { if (await f()) return; await wait(5); } throw Error("condition not observed"); }
async function main() {
  requireServer("ts-node/register/transpile-only");
  const { default: app, appReady } = require(path.resolve("server/app.ts"));
  await appReady;
  server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const node = `http://127.0.0.1:${server.address().port}`;
  const rust = `http://127.0.0.1:${port}`;
  child = spawn(process.env.POLIS_API_BIN, [], { stdio: ["ignore", "ignore", "inherit"], env: {
    ...process.env, POLIS_API_LISTEN: `127.0.0.1:${port}`, POLIS_API_DB_TRANSPORT: "loopback",
    POLIS_API_DATABASE_URL: process.env.DATABASE_URL,
    POLIS_API_POST_COMMENTS: "1", POLIS_API_POST_COMMENTS_DATABASE_URL: process.env.DATABASE_URL,
    POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE: publicFile,
  }});
  await until(() => fetch(rust + "/health").then(r => r.ok).catch(() => false));
  client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  await client.query("INSERT INTO users(uid,site_id) VALUES(900001,'generated-owner'),(900003,'generated-member')");
  await client.query("INSERT INTO conversations(zid,owner,is_active) VALUES(900001,900001,true)");
  await client.query("INSERT INTO zinvites(zid,zinvite) VALUES(900001,'2generatedmixed')");
  const member = (await client.query("INSERT INTO participants(zid,uid) VALUES(900001,900003) RETURNING pid")).rows[0].pid;
  const token = require(path.resolve("server/src/auth/anonymous-jwt.ts")).issueAnonymousJWT("2generatedmixed", 900003, member);
  const post = async (base, txt) => {
    const response = await fetch(base + "/api/v3/comments", { method: "POST", headers: {
      "content-type": "application/json", "x-forwarded-proto": "https", authorization: `Bearer ${token}`
    }, body: JSON.stringify({ conversation_id: "2generatedmixed", txt }) });
    return {status: response.status, body: await response.json()};
  };
  const results = [];
  for (const first of [node, rust]) {
    const second = first === node ? rust : node;
    for (const duplicate of [false, true]) {
      const label = `${first === node ? "node" : "rust"}-first-${duplicate ? "duplicate" : "unique"}`;
      const before = Number((await client.query("SELECT count(*) FROM comments WHERE zid=900001")).rows[0].count);
      const pending = [];
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(873791984,900001)");
      try {
        pending.push(post(first, label + " first"));
        await until(async () => Number((await client.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=873791984 AND objid=900001 AND NOT granted")).rows[0].count) === 1);
        pending.push(post(second, label + (duplicate ? " first" : " second")));
        await until(async () => Number((await client.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=873791984 AND objid=900001 AND NOT granted")).rows[0].count) === 2);
        await client.query("COMMIT");
      } finally { await client.query("ROLLBACK"); }
      const responses = await Promise.all(pending);
      assert.deepEqual(responses.map(r => r.status), duplicate ? [200, 409] : [200, 200]);
      assert.equal(responses[0].body.tid, before);
      if (!duplicate) assert.equal(responses[1].body.tid, before + 1);
      const rows = Number((await client.query("SELECT count(*) FROM comments WHERE zid=900001")).rows[0].count);
      assert.equal(rows - before, duplicate ? 1 : 2);
      results.push({case: label, statuses: responses.map(r => r.status), rowsAdded: rows - before});
    }
  }
  const burst = await Promise.all(Array.from({length: 24}, (_, i) => post(i % 2 ? rust : node, `generated burst ${i}`)));
  assert.ok(burst.every(r => r.status === 200), JSON.stringify(burst));
  assert.equal(new Set(burst.map(r => r.body.tid)).size, 24);
  assert.equal(Number((await client.query("SELECT count(*) FROM votes WHERE zid=900001")).rows[0].count), 0);
  const totals = (await client.query("SELECT count(*)::int AS n,min(tid) AS first,max(tid) AS last FROM comments WHERE zid=900001")).rows[0];
  assert.deepEqual(totals, {n: 30, first: 0, last: 29});
  // Fresh paired conversations isolate notification effects from the burst.
  await wait(100);
  await client.query("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint'");
  const notificationBudgets = [];
  for (const holdMs of [150, 350]) {
    const actors = [];
    for (const [i, base] of [node, rust].entries()) {
      const zid = 901000 + holdMs + i, cid = `2generatednotify${zid}`;
      await client.query("INSERT INTO conversations(zid,owner,is_active) VALUES($1,900001,true)", [zid]);
      await client.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)", [zid,cid]);
      const pid = (await client.query("INSERT INTO participants(zid,uid,last_interaction,nsli) VALUES($1,900003,1,7) RETURNING pid", [zid])).rows[0].pid;
      await client.query("INSERT INTO notification_tasks(zid,modified) VALUES($1,1)", [zid]);
      const token = require(path.resolve("server/src/auth/anonymous-jwt.ts")).issueAnonymousJWT(cid,900003,pid);
      actors.push({base,zid,cid,token});
    }
    const zids = actors.map(a => a.zid);
    const waiting = async () => {
      await client.query("SELECT pg_stat_clear_snapshot()");
      return Number((await client.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query ILIKE '%notification_tasks%' OR query ILIKE 'update participants%')")).rows[0].count);
    };
    const effects = async () => (await client.query("SELECT p.last_interaction,p.nsli,n.modified FROM participants p JOIN notification_tasks n USING(zid) WHERE p.zid=ANY($1::int[]) ORDER BY p.zid", [zids])).rows;
    let responses, observedWaiters, heldAfterObservationMs;
    await client.query("BEGIN");
    try {
      await client.query("SELECT 1 FROM participants WHERE zid=ANY($1::int[]) FOR NO KEY UPDATE", [zids]);
      await client.query("SELECT 1 FROM notification_tasks WHERE zid=ANY($1::int[]) FOR NO KEY UPDATE", [zids]);
      responses = await Promise.all(actors.map(async a => {
        const response = await fetch(a.base + "/api/v3/comments", {method:"POST",headers:{
          "content-type":"application/json","x-forwarded-proto":"https",authorization:`Bearer ${a.token}`
        },body:JSON.stringify({conversation_id:a.cid,txt:"notification wait"})});
        return {status:response.status,body:await response.text()};
      }));
      // Both requests succeed and commit before any background lock is released.
      assert.deepEqual(responses, [{status:200,body:'{"tid":0,"currentPid":0}'},{status:200,body:'{"tid":0,"currentPid":0}'}]);
      assert.equal(Number((await client.query("SELECT count(*) FROM comments WHERE zid=ANY($1::int[])",[zids])).rows[0].count),2);
      await until(async () => (observedWaiters = await waiting()) === 4);
      const observedAt = performance.now();
      await wait(holdMs);
      heldAfterObservationMs = performance.now() - observedAt;
      if (holdMs === 150) assert.ok(heldAfterObservationMs < 250, "release must stay inside the notification budget");
      else assert.equal(await waiting(),0,"over-budget background work must stop waiting while locks remain held");
    } finally { await client.query("COMMIT"); }
    const expected = holdMs === 150
      ? {last_interaction:"1700000000000",nsli:0,modified:"1700000000000"}
      : {last_interaction:"1",nsli:7,modified:"1"};
    if (holdMs === 150) await until(async () => (await effects()).every(row => row.nsli === 0 && row.modified === expected.modified));
    else await wait(100);
    const settled = await effects();
    assert.deepEqual(settled,[expected,expected]);
    notificationBudgets.push({holdMs,observedWaiters,heldAfterObservationMs,responses,effects:settled});
  }
  console.log(JSON.stringify({pass: true, cases: results, burst: {requests: 24, stored: 24}, totals, notificationBudgets}));
}
main().then(() => process.exitCode = 0, e => {console.error(e); process.exitCode = 1;}).finally(async () => {
  if (client) await client.end();
  if (server) await new Promise(r => server.close(r));
  if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGINT"); await stopped; }
  fs.rmSync(directory, {recursive: true, force: true});
  // Node's application owns background timers; only this harness process exits.
  process.exit(process.exitCode || 0);
});
