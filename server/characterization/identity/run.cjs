"use strict";
require("ts-node/register/transpile-only");
const { profile, applyProfile } = require("./policy.cjs");
applyProfile(profile);
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { Pool } = require("pg");
const recorder = require("../cli.cjs");
const { Normalizer } = require("../normalize.cjs");
const { hash } = require("../core.cjs");
const { firstDifference } = require("../compare.cjs");
const { records, put } = require("../recording.cjs");
const convention = require("../../src/votes/convention.ts");
const { cases } = require("./cases.cjs");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.argv[2];
const get = async (p) => {
  const response = await fetch(process.env.P027_CONTROL_URL + p, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, p);
  return response.json();
};
const identityTables = [
  "users",
  "participants",
  "participants_extended",
  "xids",
  "oidc_user_mappings",
  "treevite_invites",
  "treevite_login_codes",
];
const subset = (snapshot) =>
  Object.fromEntries(identityTables.map((t) => [t, snapshot["pg:" + t]]));
class IdentityNormalizer extends Normalizer {
  normalize(value, location = "$", key = "") {
    // Only the generated Treevite row's verified credential derivations and
    // SQL CURRENT_TIMESTAMP values vary beyond the shared normalization policy.
    // Raw rows and verification results are retained separately.
    if (location.includes("pg:treevite_") && typeof value === "string") {
      if (
        [
          "login_code_hash",
          "login_code_fingerprint",
          "login_code_lookup",
        ].includes(key)
      )
        return "$verified:" + key;
      if (
        ["created_at", "updated_at", "invite_used_at", "last_used_at"].includes(
          key
        )
      ) {
        assert.ok(Number.isFinite(Date.parse(value)), key);
        return "$sql-timestamp";
      }
    }
    return super.normalize(value, location, key);
  }
}
async function initialize() {
  for (const [zid, owner] of [
    [2, 1],
    [3, 2],
  ]) {
    await pool.query(
      "INSERT INTO conversations(zid,owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter) VALUES($1,$2,'Generated identity conversation',true,false,true,false,false)",
      [zid, owner]
    );
    await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)", [
      zid,
      `2p027identity${zid}`,
    ]);
    await pool.query("INSERT INTO participants(zid,uid) VALUES($1,$2)", [
      zid,
      owner,
    ]);
    await pool.query(
      "INSERT INTO comments(zid,pid,uid,txt,lang,mod) VALUES($1,0,$2,'Generated identity comment','en',0)",
      [zid, owner]
    );
  }
  await pool.query("UPDATE comments SET mod=0 WHERE zid=1");
  await pool.query(
    "INSERT INTO participants_extended(zid,uid,permanent_cookie) VALUES(1,2,'generated-anonymous-cookie')"
  );
  await pool.query(
    "UPDATE participants_extended SET permanent_cookie='generated-xid-cookie' WHERE zid=1 AND uid=3"
  );
  await pool.query(
    "INSERT INTO treevite_waves(zid,wave,invites_per_user,owner_invites) VALUES(1,1,0,1)"
  );
  await pool.query(
    "INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES(1,1,'generated-invite')"
  );
  for (const c of cases.filter(
    (c) => c.policy === "allowed" && c.xid !== "generated-denied" && c.xid
  )) {
    await pool.query("INSERT INTO xid_whitelist(owner,xid) VALUES(1,$1)", [
      c.xid,
    ]);
  }
}
async function main() {
  assert.equal(new URL(process.env.DATABASE_URL).pathname, "/p027");
  assert.ok(out?.startsWith("/artifacts/identity-"));
  const update = process.argv[3] === "--update";
  assert.ok(
    !process.argv[3] || update,
    "only --update can replace the pinned expectation"
  );
  const pinned = update
    ? null
    : JSON.parse(
        fs.readFileSync(
          path.join(
            __dirname,
            "../../__tests__/fixtures/identity/recordings.json"
          )
        )
      );
  if (pinned) {
    applyProfile(pinned.comparison);
    assert.deepEqual(
      pinned.recordings.map((r) => r.case),
      cases.map((c) => c.name)
    );
  }
  fs.mkdirSync(out, { recursive: true });
  const functionText = (
    await pool.query(
      "select pg_get_functiondef(oid) as definition from pg_proc where proname='pid_auto'"
    )
  ).rows[0].definition;
  assert.match(functionText, /pg_advisory_xact_lock/);
  await initialize();
  const tokens = { ...(await get("/tokens")), ...(await get("/votes-tokens")) };
  const jwksResponse = await fetch(
    "https://oidc-simulator:3000/.well-known/jwks.json"
  );
  assert.equal(jwksResponse.status, 200);
  const providerJwks = await jwksResponse.json();
  const ready = await get("/ready");
  assert.deepEqual(ready.serialization, {
    ...require("../serialization.cjs").expected,
    devModeFixtures: false,
  });
  const tables = [
    ...new Set((await recorder.schema()).map((r) => r.table_name)),
  ];
  const normalizer = new IdentityNormalizer();
  const actual = [],
    evidence = [];
  let loginCode, failedUid, firstOidcUid;
  for (const spec of cases) {
    const zid = spec.zid || 1;
    const cid = zid === 1 ? "2p027generated" : `2p027identity${zid}`;
    await pool.query(
      "UPDATE conversations SET treevite_enabled=$1,xid_required=$2,use_xid_whitelist=$3 WHERE zid=$4",
      [
        spec.policy === "treevite",
        spec.policy === "required",
        spec.policy === "allowed",
        zid,
      ]
    );
    await get("/identity-fault?kind=" + (spec.fault || "none"));
    const method = ["participation", "participationInit"].includes(spec.route)
      ? "GET"
      : "POST";
    const data = { conversation_id: cid };
    if (spec.route === "votes")
      Object.assign(data, { tid: 0, vote: convention.semanticToWire("agree") });
    if (spec.route === "comments")
      Object.assign(data, {
        txt: "Generated identity comment " + spec.name,
        agid: 1,
      });
    if (spec.xid) data.xid = spec.xid;
    if (spec.route === "treevite/acceptInvite")
      data.invite_code = "generated-invite";
    if (spec.route === "treevite/login")
      data.login_code =
        spec.name === "treevite-invalid-login"
          ? "generated-invalid"
          : loginCode;
    const claims = tokens[spec.auth]?.includes(".")
      ? JSON.parse(Buffer.from(tokens[spec.auth].split(".")[1], "base64url"))
      : {};
    const c = {
      caseId: "identity/" + spec.name,
      case: spec.name,
      auth: spec.auth,
      seed: hash(spec.name).slice(0, 12),
      credentialBinding: {
        zid,
        actorUid: spec.name.startsWith("standard-user") ||
            spec.name === "anonymous-repeat" ||
            spec.name === "xid-own-conversation" ||
            spec.name === "xid-other-conversation"
          ? claims.uid
          : undefined,
        xid: spec.xid || spec.bindingXid || claims.xid,
        oidcSub: claims.oidc_sub || claims.sub,
      },
      request: {
        method,
        path: "/api/v3/" + spec.route,
        query: method === "GET" ? data : {},
        body: method === "GET" ? null : data,
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          ...(spec.auth === "unauthenticated"
            ? {}
            : { authorization: "$auth:" + spec.auth }),
          ...(spec.cookie ? { cookie: "pc=" + spec.cookie } : {}),
          ...(spec.prefix ? { authorization: spec.prefix } : {}),
        },
      },
    };
    const before = await recorder.snapshot(tables);
    const r = await recorder.runCase(c, tokens, tables, normalizer);
    const raw = await get("/identity-last");
    const after = await recorder.snapshot(tables);
    const rawBody = Buffer.from(raw.body_base64, "base64");
    const isJson = raw.headers["content-type"]?.includes("application/json");
    const body = isJson ? JSON.parse(rawBody.toString()) : rawBody.toString();
    assert.ok(
      raw.body_base64 !== undefined,
      "this case must capture its own response"
    );
    assert.equal(raw.status, r.response.status);
    assert.equal(rawBody.length, Number(raw.headers["content-length"]));
    if (isJson)
      assert.equal(
        require("express/lib/utils").wetag(rawBody),
        raw.headers.etag
      );
    if (body.user?.site_ids) {
      const user = after["pg:users"].find((u) => u.uid === body.user.uid);
      assert.ok(user, "site_ids belongs to a committed user");
      assert.deepEqual(body.user.site_ids, [user.site_id]);
    }
    if (body.auth) tokens[spec.name] = body.auth.token;
    if (body.login_code) loginCode = body.login_code;
    const proof = {
      users: after["pg:users"].length - before["pg:users"].length,
      participants:
        after["pg:participants"].length - before["pg:participants"].length,
      xids: after["pg:xids"].length - before["pg:xids"].length,
      mappings:
        after["pg:oidc_user_mappings"].length -
        before["pg:oidc_user_mappings"].length,
      fault: raw.fault,
    };
    const row = after["pg:treevite_login_codes"][0];
    if (row) {
      assert.ok(
        await require("bcryptjs").compare(loginCode, row.login_code_hash)
      );
      assert.equal(
        row.login_code_lookup,
        crypto
          .createHash("sha256")
          .update(loginCode + "generated-identity-pepper")
          .digest("hex")
      );
      assert.equal(
        row.login_code_fingerprint,
        crypto
          .createHmac("sha256", "generated-identity-fingerprint")
          .update(`${row.zid}:${row.pid}:${loginCode}`)
          .digest("hex")
      );
      proof.treeviteCredentialVerified = true;
    }
    // Keep request artifacts deterministic without replacing business strings.
    if (spec.name === "treevite-login")
      r.request.body.login_code = "$login_code:1";
    actual.push(r);
    evidence.push({
      case: spec.name,
      credential: tokens[spec.auth] || null,
      raw,
      proof,
      before: subset(before),
      after: subset(after),
    });
    put(out, "cases.json", actual);
    put(out, "evidence.json", evidence);
    assert.equal(r.response.status, spec.status, spec.name + " status");
    assert.equal(r.oracle.pass, true, JSON.stringify(r.oracle));
    for (const key of ["users", "participants", "xids", "mappings"])
      assert.equal(proof[key], spec[key] || 0, spec.name + " " + key);
    assert.equal(
      raw.fault.fired,
      spec.fault === "load" ? 4 : spec.fault ? 1 : 0
    );
    assert.equal(raw.fault.armed, null);
    if (spec.name === "pc-xid") {
      assert.ok(!before["pg:xids"].some((x) => x.xid === spec.xid));
      assert.equal(
        after["pg:xids"].find((x) => x.xid === spec.xid).uid,
        JSON.parse(Buffer.from(body.auth.token.split(".")[1], "base64url")).uid
      );
    }
    if (["oidc-account", "oidc-extraction"].includes(spec.name))
      assert.equal(body.details, undefined);
    if (spec.details) assert.equal(body.details, spec.details);
    if (spec.error) assert.equal(body.error, spec.error, spec.name);
    if (spec.text) assert.equal(body, spec.text);
    assert.equal(!!body.auth, !!spec.token, spec.name + " token");
    if (spec.token) {
      assert.equal(r.effects.jwtIssued, 1);
      assert.equal(body.auth.token_type, "Bearer");
      assert.equal(body.auth.expires_in, 31536000);
      assert.equal(
        JSON.parse(Buffer.from(body.auth.token.split(".")[1], "base64url"))[
          spec.token + "_participant"
        ],
        true
      );
    }
    if (spec.route === "votes" && spec.status === 200) {
      const votes = r.effects.db["pg:votes"]?.added || [];
      assert.equal(votes.length, 1, spec.name + " committed vote");
      assert.equal(convention.storageToSemantic(votes[0].vote), "agree");
    }
    const newUsers = after["pg:users"].filter(
      (u) => !before["pg:users"].some((b) => b.uid === u.uid)
    );
    if (spec.token && spec.users) {
      const tokenClaims = JSON.parse(
        Buffer.from(body.auth.token.split(".")[1], "base64url")
      );
      assert.equal(tokenClaims.uid, newUsers[0].uid);
    }
    if (spec.name === "treevite-refused-first-join")
      assert.ok(
        !after["pg:participants"].some((p) => p.uid === newUsers[0].uid)
      );
    if (spec.name === "xid-upsert-failure") {
      failedUid = newUsers[0].uid;
      assert.ok(after["pg:participants"].some((p) => p.uid === failedUid));
      assert.ok(!after["pg:xids"].some((x) => x.uid === failedUid));
    }
    if (spec.name === "xid-upsert-retry") {
      assert.notEqual(newUsers[0].uid, failedUid);
      assert.ok(after["pg:participants"].some((p) => p.uid === failedUid));
      assert.equal(
        after["pg:xids"].find((x) => x.xid === spec.xid).uid,
        newUsers[0].uid
      );
    }
    if (spec.name === "oidc-first-use") firstOidcUid = newUsers[0].uid;
    if (["oidc-first-use", "oidc-repeat"].includes(spec.name)) {
      const mappings = after["pg:oidc_user_mappings"].filter(
        (m) => m.oidc_sub === "generated-identity-user"
      );
      assert.equal(mappings.length, 1);
      assert.equal(mappings[0].uid, firstOidcUid);
      const user = after["pg:users"].find((u) => u.uid === firstOidcUid);
      assert.equal(user.email, "identity@example.invalid");
      assert.equal(user.hname, "Generated Identity");
      assert.equal(user.username, "identity");
      assert.equal(user.is_owner, true);
    }
    const dest = path.join(out, spec.name);
    fs.mkdirSync(dest, { recursive: true });
    for (const [name, value] of Object.entries(records(r)))
      put(dest, name + ".json", value);
    console.log(
      JSON.stringify({ case: spec.name, status: r.response.status, ...proof })
    );
  }
  const corpus = {
    format: "identity-recordings/2",
    comparison: profile,
    dev_mode: false,
    source_commit: process.env.P027_SOURCE_COMMIT,
    public_key: tokens.publicKey,
    provider_jwks: providerJwks,
    provenance: JSON.parse(
      fs.readFileSync("/artifacts/identity-provenance.json")
    ),
    runtime: ready.runtime,
    serialization: ready.serialization,
    cases: actual.length,
    storage_agree: convention.currentStorageConvention().agreeValue,
  };
  put(out, "corpus.json", corpus);
  put(out, "fixture.json", { ...corpus, recordings: actual, evidence });
  if (pinned) {
    const differences = actual.flatMap((r, i) => {
      const difference = firstDifference(pinned.recordings[i], r);
      return difference ? [{ case: r.case, difference }] : [];
    });
    put(out, "replay.json", { cases: actual.length, differences });
    assert.deepEqual(
      differences,
      [],
      "live Node differs from the committed identity fixture"
    );
  }
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
