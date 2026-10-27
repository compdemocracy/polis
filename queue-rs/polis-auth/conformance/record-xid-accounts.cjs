"use strict";
// Run from a compiled Node server checkout containing the account guard.
// All rows and keys are generated here; no external connection is permitted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { createRequire } = require("node:module");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (options.path || !["localhost", "127.0.0.1", "::1"].includes(options.host || "localhost")) {
    process.nextTick(() => this.destroy(new Error("recording permits loopback connections only")));
    return this;
  }
  return connect.apply(this, args);
};
const requireServer = createRequire(path.join(process.cwd(), "package.json"));
const { Pool } = requireServer("pg");
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.JWT_PRIVATE_KEY = pair.privateKey;
process.env.JWT_PUBLIC_KEY = pair.publicKey;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const classes = ["admin", "conversation_owner", "owner_flag", "site_moderator", "oidc_mapped", "plain_participant"];
const expected = '{"error":"polis_err_xid_owner_account","message":"polis_err_xid_owner_account","status":403}';
async function main() {
  assert.equal(new URL(process.env.DATABASE_URL).hostname, "127.0.0.1");
  assert.equal(new URL(process.env.DATABASE_URL).pathname, "/polis-test");
  const ids = [];
  for (let i = 0; i < 7; i++) {
    ids.push((await db.query("INSERT INTO users(site_id, is_owner) VALUES ($1, false) RETURNING uid", [`generated-account-site-${process.pid}-${i}`])).rows[0].uid);
  }
  process.env.ADMIN_UIDS = JSON.stringify([ids[0]]);
  const owner = ids[6];
  const zid = (await db.query("INSERT INTO conversations(owner, is_active, is_draft, is_public, topic) VALUES($1,true,false,true,'Generated account contract') RETURNING zid", [owner])).rows[0].zid;
  const conversation = `2generatedaccounts${zid}`;
  await db.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)", [zid, conversation]);
  const pids = [];
  for (let i = 0; i < classes.length; i++) {
    const uid = ids[i], xid = `generated-${classes[i]}`;
    pids.push((await db.query("INSERT INTO participants(zid,uid) VALUES($1,$2) RETURNING pid", [zid, uid])).rows[0].pid);
    await db.query("INSERT INTO xids(owner,uid,xid) VALUES($1,$2,$3)", [owner, uid, xid]);
  }
  await db.query("INSERT INTO conversations(owner) VALUES($1)", [ids[1]]);
  await db.query("UPDATE users SET is_owner=true WHERE uid=$1", [ids[2]]);
  await db.query("UPDATE users SET site_id=(SELECT site_id FROM users WHERE uid=$1) WHERE uid=$2", [owner, ids[3]]);
  await db.query("INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES($1,$2)", [`generated-oidc-account-${ids[4]}`, ids[4]]);
  const { default: app, appReady } = requireServer(path.join(process.cwd(), "dist/app.js"));
  await appReady;
  assert.ok(app.routes.get.length);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { issueXidJWT } = requireServer(path.join(process.cwd(), "dist/src/auth/xid-jwt.js"));
  const logger = requireServer(path.join(process.cwd(), "dist/src/utils/logger.js")).default;
  const warnings = [];
  const warn = logger.warn.bind(logger);
  logger.warn = (...args) => { if (args[0] === "polis_err_xid_owner_account") warnings.push(args); return warn(...args); };
  const cases = [];
  const now = Math.floor(Date.now()/1000);
  for (let i = 0; i < classes.length; i++) {
    const account_class = classes[i], xid = `generated-${account_class}`;
    const token = issueXidJWT(xid, conversation, ids[i], pids[i]);
    const results = {};
    for (const mode of ["bare", "existing"]) {
      const before = warnings.length;
      const url = mode === "bare" ? `/api/v3/participationInit?conversation_id=${conversation}&xid=${xid}` : "/api/v3/users";
      const response = await fetch(base + url, { headers: { "X-Forwarded-Proto": "https", ...(mode === "existing" ? { Authorization: `Bearer ${token}` } : {}) }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      const body = await response.text();
      const status = response.status;
      if (account_class !== "plain_participant") {
        assert.equal(status, 403, `${account_class}/${mode}: ${body}`);
        assert.equal(body, expected);
        assert.equal(warnings.length - before, 1);
        assert.deepEqual(warnings.at(-1), ["polis_err_xid_owner_account", { account_class }]);
      } else {
        assert.equal(status, 200, body);
        assert.equal(warnings.length, before);
        if (mode === "bare") assert.ok(JSON.parse(body).auth.token);
      }
      results[mode] = { status, body };
    }
    cases.push({ account_class, uid: ids[i], pid: pids[i], xid, credential: token, ...results });
  }
  fs.writeFileSync(process.argv[2], JSON.stringify({ contract: "xid-account/1", now, public_key: pair.publicKey, conversation, cases }, null, 2) + "\n");
  console.log(`Recorded ${cases.length} account classes, bare XIDs and existing tokens; exact bodies and class-only warnings checked.`);
  await db.end();
  server.close();
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
