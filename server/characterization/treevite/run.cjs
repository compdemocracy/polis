"use strict";
require("ts-node/register/transpile-only");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { Pool } = require("pg");
const recorder = require("../cli.cjs");
const { Normalizer } = require("../normalize.cjs");
const { strings, bytes } = require("../wire.cjs");
const { hash, delta, canonical } = require("../core.cjs");
const { verifyToken } = require("../jwt.cjs");
const put = (dir, file, value) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2) + "\n");
};
const { cases } = require("./cases.cjs");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tables = [
  "users",
  "participants",
  "participants_extended",
  "xids",
  "xid_whitelist",
  "oidc_user_mappings",
  "conversations",
  "treevite_waves",
  "treevite_invites",
  "treevite_login_codes",
];
const get = async (p) => {
  const r = await fetch(process.env.P027_CONTROL_URL + p, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, p);
  return r.json();
};
const cid = (zid) => (zid === 1 ? "2p027generated" : "2p027treevite2");
const claims = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
const loginCodes = new Map(),
  knownSecrets = new Set(),
  verifiedHashes = new Map();
class TreeviteNormalizer extends Normalizer {
  normalize(value, location = "$", key = "") {
    if (value !== null && typeof value === "string") {
      if (
        [
          "login_code_hash",
          "login_code_lookup",
          "login_code_fingerprint",
        ].includes(key)
      ) {
        assert.ok(
          verifiedHashes.has(value),
          "unverified credential derivation: " + key
        );
        return "$verified:" + key + ":" + verifiedHashes.get(value);
      }
      if (
        [
          "created_at",
          "updated_at",
          "invite_used_at",
          "joined_at",
          "last_used_at",
          "expires_at",
        ].includes(key)
      ) {
        assert.ok(Number.isFinite(Date.parse(value)), key);
        if (location.startsWith("$.response.body."))
          assert.match(
            value,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            "wire timestamp format"
          );
        return "$timestamp";
      }
    }
    return super.normalize(value, location, key);
  }
}
const normalizer = new TreeviteNormalizer();
function safeEffects(effects) {
  const safe = normalizer.normalize(effects);
  for (const change of Object.values(safe))
    for (const rows of Object.values(change))
      rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return safe;
}
function safeSnapshot(snapshot) {
  const safe = normalizer.normalize(snapshot);
  for (const rows of Object.values(safe))
    rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return safe;
}
async function initialize() {
  await pool.query(
    "UPDATE conversations SET treevite_enabled=true WHERE zid=1"
  );
  await pool.query(
    "INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,treevite_enabled) VALUES(2,1,'Generated other conversation',true,false,true,true)"
  );
  await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES(2,$1)", [cid(2)]);
  await pool.query(
    "INSERT INTO xids(owner,uid,xid,zid,pid) VALUES(1,3,'generated-member',1,2)"
  );
  await pool.query(
    "INSERT INTO users(uid,site_id,is_owner) VALUES(100005,'p027-nonmember',false)"
  );
  // Fixed high fixture identity must not advance the generated user sequence.
}
async function verifyCredentials(response, after, spec) {
  const body = response.body;
  if (body?.login_code) {
    assert.ok(
      /^[A-Za-z0-9]{16}$/.test(body.login_code),
      "generated login code format"
    );
    knownSecrets.add(body.login_code);
    loginCodes.set(spec.name, body.login_code);
    const c = claims(body.auth.token);
    const row = after["pg:treevite_login_codes"].find(
      (r) => r.zid === (spec.zid || 1) && r.pid === c.pid
    );
    assert.ok(row);
    assert.match(row.login_code_hash, /^\$2[aby]\$10\$/);
    assert.ok(
      await require("bcryptjs").compare(body.login_code, row.login_code_hash)
    );
    assert.equal(
      row.login_code_lookup,
      crypto
        .createHash("sha256")
        .update(body.login_code + "generated-treevite-pepper")
        .digest("hex")
    );
    assert.equal(
      row.login_code_fingerprint,
      crypto
        .createHmac("sha256", "generated-treevite-fingerprint")
        .update(`${row.zid}:${row.pid}:${body.login_code}`)
        .digest("hex")
    );
    assert.equal(row.fp_kid, 1);
    const symbol = normalizer.normalize(
      body.login_code,
      "$.credential",
      "login_code"
    );
    for (const key of [
      "login_code_hash",
      "login_code_lookup",
      "login_code_fingerprint",
    ])
      verifiedHashes.set(row[key], symbol);
  }
}
function wireRecord(response, request, after, tokens, spec, headReference) {
  assert.equal(response.completed, true, spec.name + " completed");
  const raw = bytes(response);
  const original = response.wire.response.headers;
  const header = (name) =>
    original.find((h) => h.name.toLowerCase() === name)?.value;
  // HEAD has GET's entity headers but deliberately no entity bytes.
  if (request.method !== "HEAD") {
    if (header("content-length") !== undefined)
      assert.equal(header("content-length"), String(raw.length), "wire length");
    if (header("etag") !== undefined)
      assert.equal(
        header("etag"),
        require("express/lib/utils").wetag(raw),
        "wire etag"
      );
  }
  let verified = null;
  if (response.body?.auth) {
    assert.equal(response.body.auth.token_type, "Bearer");
    assert.equal(response.body.auth.expires_in, 31536000);
    verified = verifyToken(response.body.auth.token, {
      publicKey: tokens.publicKey,
      now: 1700000000,
      issuer: "https://pol.is/",
      audience: "participants",
      ttl: 31536000,
      conversation_id: cid(spec.zid || 1),
      zid: spec.zid || 1,
      participants: after["pg:participants"],
    });
    assert.equal(verified.$jwt.anonymous_participant, true);
    if (spec.credential) {
      const source = claims(tokens[spec.credential]);
      assert.equal(verified.$jwt.uid, source.uid, "login retains accepted UID");
      assert.equal(verified.$jwt.pid, source.pid, "login retains accepted PID");
    }
    tokens[spec.name] = response.body.auth.token;
  }
  let text = raw.toString("utf8");
  if (text && header("content-type")?.includes("application/json")) {
    text = strings(text, (v, p, k) =>
      k === "token" && verified
        ? "$jwt:" + hash(verified)
        : normalizer.normalize(v, "$.response.body." + p.join("."), k)
    );
  } else if (text && header("content-type")?.includes("text/csv")) {
    // Generated code cells have no CSV metacharacters. Keep delimiters, labels,
    // row order and newline bytes exact; substitute only verified SQL cell values.
    for (const row of after["pg:treevite_invites"]) {
      text = text
        .split(row.invite_code)
        .join(normalizer.normalize(row.invite_code, "$.csv", "invite_code"));
      for (const k of ["created_at", "invite_used_at"])
        if (row[k])
          text = text.split(new Date(row[k]).toDateString()).join("$date");
    }
  }
  const normalized = Buffer.from(text);
  const headWire = headReference
    ? wireRecord(
        headReference,
        { ...request, method: "GET" },
        after,
        tokens,
        spec
      )
    : null;
  if (headReference)
    for (const name of ["content-length", "etag", "content-type"])
      assert.equal(
        header(name),
        headReference.wire.response.headers.find(
          (h) => h.name.toLowerCase() === name
        )?.value,
        "HEAD agrees with GET"
      );
  const headers = original
    .filter(
      (h) =>
        !["date", "connection", "keep-alive"].includes(h.name.toLowerCase())
    )
    .map((h) => {
      const name = h.name.toLowerCase();
      if (headWire && ["content-length", "etag"].includes(name))
        return headWire.headers.find((x) => x.name.toLowerCase() === name);
      if (request.method !== "HEAD" && name === "content-length")
        return { ...h, value: String(normalized.length) };
      if (request.method !== "HEAD" && name === "etag")
        return { ...h, value: require("express/lib/utils").wetag(normalized) };
      return h;
    });
  return {
    status: response.status,
    headers,
    body_base64: normalized.toString("base64"),
    jwt: verified,
  };
}
async function prepare(spec, tokens) {
  const zid = spec.zid || 1;
  await pool.query(
    "UPDATE conversations SET treevite_enabled=$1,use_xid_whitelist=$2 WHERE zid=$3",
    [!spec.disabled, !!spec.allowlist, zid]
  );
  await pool.query(
    "DELETE FROM xid_whitelist WHERE owner=1 AND xid='generated-member'"
  );
  if (spec.allowlist && !spec.removeAllowed)
    await pool.query(
      "INSERT INTO xid_whitelist(owner,xid) VALUES(1,'generated-member')"
    );
  if (spec.seedTarget) {
    await pool.query(
      "INSERT INTO treevite_waves(zid,wave,invites_per_user,owner_invites) VALUES(2,1,0,1)"
    );
    await pool.query(
      "INSERT INTO treevite_invites(zid,wave_id,invite_code) SELECT 2,id,'generated-other-invite' FROM treevite_waves WHERE zid=2"
    );
  }
  const data = spec.missingConversation ? {} : { conversation_id: cid(zid) };
  if (spec.invite !== undefined) {
    const rows = (
      await pool.query(
        "SELECT * FROM treevite_invites WHERE zid=1 AND wave_id=1 ORDER BY id"
      )
    ).rows;
    data.invite_code = spec.seedTarget
      ? "generated-other-invite"
      : rows[spec.invite].invite_code;
    if (spec.inviteStatus !== undefined)
      await pool.query("UPDATE treevite_invites SET status=$1 WHERE id=$2", [
        spec.inviteStatus,
        rows[spec.invite].id,
      ]);
  }
  if (spec.childOf) {
    const pid = claims(tokens[spec.childOf]).pid;
    data.invite_code = (
      await pool.query(
        "SELECT invite_code FROM treevite_invites WHERE zid=1 AND invite_owner_pid=$1 AND status=0 ORDER BY id LIMIT 1",
        [pid]
      )
    ).rows[0].invite_code;
  }
  if (spec.credential) {
    data.login_code = loginCodes.get(spec.credential);
    assert.ok(data.login_code);
    const pid = claims(tokens[spec.credential]).pid;
    await pool.query(
      "UPDATE treevite_login_codes SET revoked=$1,expires_at=$2 WHERE zid=1 AND pid=$3",
      [!!spec.revoke, spec.expired ? "2000-01-01T00:00:00Z" : null, pid]
    );
    if (spec.mismatch) {
      const invalidHash = await require("bcryptjs").hash(
        "generated-nonmatching-secret",
        10
      );
      verifiedHashes.set(invalidHash, "$deliberate-bcrypt-mismatch");
      await pool.query(
        "UPDATE treevite_login_codes SET login_code_hash=$1 WHERE zid=1 AND pid=$2",
        [invalidHash, pid]
      );
    }
  }
  if (spec.code)
    data[spec.route === "login" ? "login_code" : "invite_code"] = spec.code;
  if (spec.trim)
    for (const key of ["login_code", "invite_code"])
      if (data[key]) data[key] = " \t" + data[key] + "\n ";
  Object.assign(data, spec.data);
  return {
    method: spec.method,
    path: "/api/v3/treevite/" + spec.route,
    query: ["GET", "HEAD"].includes(spec.method) ? data : {},
    body: ["GET", "HEAD"].includes(spec.method) ? null : data,
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      ...(spec.auth ? { authorization: "$auth:" + spec.auth } : {}),
    },
  };
}
async function main() {
  assert.equal(new URL(process.env.DATABASE_URL).pathname, "/p027");
  const out = process.argv[2],
    update = process.argv[3] === "--update";
  assert.ok(out?.startsWith("/artifacts/treevite-"));
  assert.ok(!process.argv[3] || update);
  const pinned = update
    ? null
    : JSON.parse(fs.readFileSync(path.join(__dirname, "recordings.json")));
  if (pinned)
    assert.deepEqual(
      pinned.recordings.map((r) => r.case),
      cases.map((c) => c.name)
    );
  assert.match(
    (
      await pool.query(
        "SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname='pid_auto'"
      )
    ).rows[0].definition,
    /pg_advisory_xact_lock/
  );
  await initialize();
  const tokens = { ...(await get("/tokens")), ...(await get("/votes-tokens")) };
  const ready = await get("/ready");
  assert.equal(ready.serialization.devModeFixtures, false);
  const actual = [];
  for (const spec of cases) {
    const request = await prepare(spec, tokens);
    await get(
      "/begin?seed=" +
        hash(spec.name).slice(0, 12) +
        "&case=treevite/" +
        spec.name
    );
    const before = await recorder.snapshot(tables),
      stateBefore = await get("/state");
    if (spec.race) await get("/treevite-race-arm");
    const responses = spec.race
      ? await Promise.all([
          recorder.send(request, tokens, 15000),
          recorder.send(request, tokens, 15000),
        ])
      : [await recorder.send(request, tokens, 15000)];
    const headReference =
      spec.method === "HEAD"
        ? await recorder.send({ ...request, method: "GET" }, tokens, 15000)
        : null;
    // Wait for the existing observer's actual work registry, with a bounded deadline.
    for (let n = 0; n < 100; n++) {
      const s = await get("/state");
      if (!s.work.pending.length && !s.work.late.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const barrier = await get("/barrier");
    assert.equal(barrier.name, "request-effects-drained");
    const after = await recorder.snapshot(tables),
      stateAfter = await get("/state");
    assert.deepEqual(
      stateAfter.process.slice(stateBefore.process.length),
      [],
      "no process failure"
    );
    const outbound = stateAfter.outbound
      .slice(stateBefore.outbound.length)
      .map((attempt) => {
        assert.equal(attempt.host, "oidc-simulator");
        assert.equal(attempt.path, "/.well-known/jwks.json");
        assert.equal(attempt.method, "GET");
        assert.equal(attempt.blocked, false);
        assert.equal(attempt.termination, "end");
        const jwks = JSON.parse(attempt.response);
        assert.ok(jwks.keys.length);
        const [h, p, s] = tokens.owner.split(".");
        assert.ok(
          jwks.keys.some((key) =>
            crypto.verify(
              "RSA-SHA256",
              Buffer.from(h + "." + p),
              crypto.createPublicKey({ key, format: "jwk" }),
              Buffer.from(s, "base64url")
            )
          ),
          "local OIDC verification key"
        );
        const { at_ms: _at_ms, response: _response, ...metadata } = attempt;
        return { ...metadata, response: "$verified-local-jwks" };
      });
    assert.deepEqual(
      after,
      await recorder.snapshot(tables),
      "durable rows settled"
    );
    // Bind random invites by seeded, monotonic database ID, before response order.
    for (const row of [...after["pg:users"]].sort((a, b) => a.uid - b.uid))
      normalizer.normalize(row.site_id, "$.binding", "site_id");
    for (const row of [...after["pg:treevite_invites"]].sort(
      (a, b) => a.id - b.id
    ))
      normalizer.normalize(row.invite_code, "$.binding", "invite_code");
    for (const response of responses)
      await verifyCredentials(response, after, spec);
    const wire = responses.map((response) =>
      wireRecord(response, request, after, tokens, spec, headReference)
    );
    if (spec.race) wire.sort((a, b) => b.status - a.status);
    assert.deepEqual(
      wire.map((r) => r.status),
      spec.race ? [400, 201] : [spec.status],
      spec.name + " status"
    );
    const body = responses.find((r) => r.status === spec.status)?.body;
    if (spec.error) assert.equal(body.error, spec.error, spec.name);
    const newRows = (table) =>
      after["pg:" + table].filter(
        (r) => !before["pg:" + table].some((b) => canonical(b) === canonical(r))
      );
    const proof = {
      users: after["pg:users"].length - before["pg:users"].length,
      participants:
        after["pg:participants"].length - before["pg:participants"].length,
      loginRows:
        after["pg:treevite_login_codes"].length -
        before["pg:treevite_login_codes"].length,
    };
    assert.equal(proof.users, spec.users || 0, spec.name + " users");
    assert.equal(
      proof.participants,
      spec.participants || 0,
      spec.name + " participants"
    );
    if (spec.children !== undefined) {
      proof.children = newRows("treevite_invites").filter(
        (r) => !before["pg:treevite_invites"].some((b) => b.id === r.id)
      ).length;
      assert.equal(proof.children, spec.children, spec.name + " children");
      const accepted = responses.find((r) => r.status === 201);
      for (const child of newRows("treevite_invites").filter(
        (r) => !before["pg:treevite_invites"].some((b) => b.id === r.id)
      )) {
        assert.equal(
          child.invite_owner_pid,
          claims(accepted.body.auth.token).pid
        );
        assert.equal(String(child.parent_invite_id), accepted.body.invite_id);
      }
    }
    if (spec.name === "accept-existing-xid-conversion") {
      assert.equal(claims(tokens[spec.name]).uid, 3);
      assert.equal(claims(tokens[spec.name]).pid, 2);
      assert.equal(claims(tokens.xid).xid_participant, true);
      proof.retainedXidIdentity = { uid: 3, pid: 2, anonymous: true };
    }
    if (spec.race) {
      proof.schedule = await get("/treevite-race-state");
      assert.equal(proof.schedule.armed, false);
      assert.equal(proof.schedule.reads, 2);
      assert.equal(proof.schedule.updates, 2);
      assert.equal(proof.loginRows, 1);
      const winner = responses.find((r) => r.status === 201),
        loser = responses.find((r) => r.status === 400);
      assert.equal(
        loser.body.error,
        "polis_err_treevite_invite_race_condition"
      );
      const pid = claims(winner.body.auth.token).pid;
      const members = newRows("participants");
      const orphan = members.find((p) => p.pid !== pid);
      assert.ok(orphan);
      assert.ok(
        !after["pg:treevite_login_codes"].some(
          (r) => r.zid === orphan.zid && r.pid === orphan.pid
        )
      );
      assert.equal(
        newRows("treevite_invites").filter((r) => r.status === 1).length,
        1
      );
      assert.ok(
        after["pg:treevite_invites"].some(
          (r) =>
            String(r.id) === winner.body.invite_id &&
            r.invite_used_by_pid === pid
        )
      );
      assert.ok(
        !after["pg:treevite_invites"].some(
          (r) => r.zid === orphan.zid && r.invite_used_by_pid === orphan.pid
        )
      );
      proof.loser = {
        uid: orphan.uid,
        pid: orphan.pid,
        member: true,
        login: false,
        consumedInvite: false,
      };
    }
    const safeRequest = normalizer.normalize(
      JSON.parse(JSON.stringify(request))
    );
    if (spec.credential)
      safeRequest.body.login_code =
        "$login:" + spec.credential + (spec.trim ? ":trimmed" : "");
    const row = {
      case: spec.name,
      delta: spec.delta || null,
      request: safeRequest,
      responses: wire,
      proof,
      before: safeSnapshot(before),
      after: safeSnapshot(after),
      effects: safeEffects(delta(before, after)),
      outbound,
      routeHits: stateAfter.hits.slice(stateBefore.hits.length),
    };
    actual.push(row);
    const serialized = JSON.stringify(row);
    for (const secret of knownSecrets)
      assert.ok(
        !serialized.includes(secret) &&
          !serialized.includes(Buffer.from(secret).toString("base64")),
        "raw login code must never be written"
      );
    for (const response of wire)
      for (const secret of knownSecrets)
        assert.ok(
          !Buffer.from(response.body_base64, "base64")
            .toString()
            .includes(secret),
          "encoded response leaked a raw login code"
        );
    put(path.join(out, spec.name), "record.json", row);
    console.log(
      JSON.stringify({
        case: spec.name,
        status: wire.map((r) => r.status),
        ...proof,
      })
    );
  }
  const corpus = {
    format: "treevite-recordings/1",
    comparison: {
      version: 3,
      profile: "treevite",
      body: "lexical typed values; all other bytes exact",
      ids: "seeded exact, preserve numeric versus bigint string",
      timestamps: "typed presence; null remains null",
      credentials: "verified only; no raw login code or JWT",
    },
    source_commit: process.env.P027_SOURCE_COMMIT,
    provenance: JSON.parse(
      fs.readFileSync("/artifacts/treevite-provenance.json")
    ),
    runtime: ready.runtime,
    serialization: ready.serialization,
    recordings: actual,
  };
  put(out, "fixture.json", corpus);
  const differences = pinned
    ? require("./compare.cjs").differences(pinned, corpus)
    : [];
  put(out, "replay.json", {
    cases: actual.length,
    differences,
    comparedToCommitted: !!pinned,
  });
  assert.deepEqual(
    differences,
    [],
    "live Node differs from committed Treevite fixture"
  );
  console.log(
    JSON.stringify({
      cases: actual.length,
      failed: 0,
      comparedToCommitted: !!pinned,
      update,
    })
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await recorder.close();
  });
