"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const net = require("node:net"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const req = require("node:module").createRequire(root + "/server/package.json");
const dir = process.env.MIXED_ARTIFACTS;
const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, value) =>
  fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2));
if (mode === "prepare") {
  for (const prefix of ["", "provider-"]) {
    const pair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    fs.writeFileSync(dir + "/" + prefix + "private.pem", pair.privateKey, {
      mode: 0o600,
    });
    fs.writeFileSync(dir + "/" + prefix + "public.pem", pair.publicKey);
    if (prefix)
      save("jwks", {
        keys: [
          {
            ...crypto.createPublicKey(pair.publicKey).export({ format: "jwk" }),
            kid: "generated",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
  }
  process.exit(0);
}
if (mode === "provider") {
  http
    .createServer((r, s) => {
      s.setHeader("content-type", "application/json");
      s.end(fs.readFileSync(dir + "/jwks.json"));
    })
    .listen(Number(process.env.MIXED_PROVIDER_PORT), "127.0.0.1");
} else if (mode === "run")
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
function rpc(value) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      Number(process.env.POLIS_MIXED_WORKER_PORT),
      "127.0.0.1"
    );
    let data = "";
    socket.setTimeout(10000, () => socket.destroy(Error("RPC deadline")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        socket.end();
        resolve(JSON.parse(data));
      }
    });
  });
}
async function until(fn, label, limit = 60000) {
  const deadline = Date.now() + limit;
  let last,
    reported = false;
  while (true) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = String(e) + " " + String(e.cause);
      if (!reported) {
        console.error(label, last);
        reported = true;
      }
    }
    if (Date.now() > deadline)
      throw Error(label + " readiness deadline: " + last);
    await sleep(50);
  }
}
function percentile(xs, p) {
  return xs.length
    ? [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.floor(xs.length * p))
      ]
    : null;
}
const stats = (xs) => ({
  n: xs.length,
  p50: percentile(xs, 0.5),
  p99: percentile(xs, 0.99),
  max: xs.length ? Math.max(...xs) : null,
});
async function main() {
  req("ts-node/register/transpile-only");
  const { Pool } = req("pg"),
    jwt = req("jsonwebtoken"),
    bcrypt = req("bcryptjs");
  const convention = req(root + "/server/src/votes/convention.ts");
  const { createJwtValidation, issueParticipantJWT } = req(
    root + "/server/src/auth/jwt-utils.ts"
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const node = `http://127.0.0.1:${process.env.MIXED_NODE_PORT}`;
  const api = `http://127.0.0.1:${process.env.MIXED_API_PORT}`;
  const full = process.env.MIXED_FULL === "1",
    callers = full ? 200 : 8,
    rounds = full ? 3 : 1;
  const report = {
    profile: full ? "full" : "small",
    callers,
    rounds,
    cases: [],
    failures: [],
    scope:
      "Rust library admission with test-only minter; all vote writes use Node; API remains unchanged",
  };
  let guard;
  const check = (ok, label) => {
    if (!ok) report.failures.push(label);
    return ok;
  };
  const httpCall = async (base, route, body, token, caller) => {
    const start = performance.now();
    try {
      const response = await fetch(base + "/api/v3/" + route, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          ...(caller ? { "x-mixed-caller": caller } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }
      return {
        status: response.status,
        body: data,
        ms: performance.now() - start,
      };
    } catch (e) {
      return { status: 0, error: e.message, ms: performance.now() - start };
    }
  };
  try {
    await until(async () => (await rpc({ ready: true })).ready, "Rust");
    await until(async () => {
      const r = await fetch(node + "/api/v3/testConnection", {
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw Error(`Node HTTP ${r.status}`);
      await r.text();
      return true;
    }, "Node");
    await until(async () => (await fetch(api + "/health")).ok, "API");
    // Generated audit rows survive only committed writes and identify the writer.
    // Product tables, triggers and allocator are left intact.
    await pool.query(`CREATE TABLE mixed_audit(kind text, uid int, zid int, writer text, caller text);
      CREATE FUNCTION mixed_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO mixed_audit VALUES(TG_TABLE_NAME,NEW.uid,CASE WHEN TG_TABLE_NAME='participants' THEN (to_jsonb(NEW)->>'zid')::int ELSE NULL END,current_setting('application_name'),coalesce((regexp_match(current_query(),'mixed-caller:([a-z0-9-]+)'))[1],current_setting('mixed.caller',true)));
      RETURN NEW; END $$;
      CREATE TRIGGER mixed_user_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION mixed_audit_insert();
      CREATE TRIGGER mixed_participant_audit AFTER INSERT ON participants FOR EACH ROW EXECUTE FUNCTION mixed_audit_insert();`);
    const owner = (
      await pool.query(
        "INSERT INTO users(is_owner,site_owner) VALUES(true,true) RETURNING uid"
      )
    ).rows[0].uid;
    // Avoid collision with the unchanged guard's explicit fixture identifiers.
    await pool.query(
      "SELECT setval(pg_get_serial_sequence('users','uid'),10000)"
    );
    await pool.query(
      "SELECT setval(pg_get_serial_sequence('conversations','zid'),10000)"
    );
    let guardExit;
    const guardLog = fs.openSync(dir + "/guard.log", "w");
    guard = spawn(
      process.execPath,
      [
        root + "/server/node_modules/jest/bin/jest.js",
        "--config",
        "__tests__/delphi-results-pg/jest.config.json",
        "--runInBand",
        "--runTestsByPath",
        "__tests__/delphi-results-pg/concurrency.pgtest.ts",
        "--setupFilesAfterEnv",
        __dirname + "/mixed-identity-guard.cjs",
      ],
      {
        cwd: root + "/server",
        env: {
          ...process.env,
          DATABASE_URL: process.env.MIXED_GUARD_DATABASE_URL,
        },
        stdio: ["ignore", guardLog, guardLog],
      }
    );
    const guardDone = new Promise((resolve) =>
      guard.once("exit", (code) => {
        guardExit = code;
        resolve();
      })
    );
    await until(() => fs.existsSync(dir + "/guard-ready"), "unchanged guard");
    let first = true;
    for (const kind of ["anonymous", "xid", "oidc", "invite"]) {
      for (let round = 0; round < rounds; round++) {
        const cid = `2mixed${kind}${round}`;
        const zid = (
          await pool.query(
            "INSERT INTO conversations(owner,topic,is_active,is_draft,is_public,profanity_filter,spam_filter,treevite_enabled) VALUES($1,'Generated mixed writer',true,false,true,false,false,$2) RETURNING zid",
            [owner, kind === "invite"]
          )
        ).rows[0].zid;
        await pool.query("INSERT INTO zinvites(zid,zinvite) VALUES($1,$2)", [
          zid,
          cid,
        ]);
        await pool.query("INSERT INTO participants(zid,uid) VALUES($1,$2)", [
          zid,
          owner,
        ]);
        await pool.query(
          "INSERT INTO comments(zid,pid,uid,txt,lang,mod) VALUES($1,0,$2,'Generated known agree statement','en',0)",
          [zid, owner]
        );
        const invite = `generated-invite-${round}`;
        if (kind === "invite") {
          const wave = (
            await pool.query(
              "INSERT INTO treevite_waves(zid,wave,invites_per_user,owner_invites) VALUES($1,1,0,1) RETURNING id",
              [zid]
            )
          ).rows[0].id;
          await pool.query(
            "INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES($1,$2,$3)",
            [zid, wave, invite]
          );
        }
        const sub = `generated-shared-${round}`;
        const providerToken = jwt.sign(
          {
            iss: process.env.AUTH_ISSUER,
            aud: "users",
            sub,
            email: `${sub}@example.invalid`,
            name: "Generated Shared",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          fs.readFileSync(dir + "/provider-private.pem"),
          { algorithm: "RS256", keyid: "generated" }
        );
        const recovery = Array.from(
          { length: callers },
          (_, i) => `generated-recovery-${round}-${i}`
        );
        // Bcrypt is prepared before contention, as required by the Rust caller contract.
        const hashes =
          kind === "invite"
            ? await Promise.all(recovery.map((code) => bcrypt.hash(code, 10)))
            : [];
        const usersBefore = (
          await pool.query("SELECT coalesce(max(uid),0) uid FROM users")
        ).rows[0].uid;
        const samples = [],
          episodes = [],
          active = new Map();
        let polling = true;
        const sample = async () => {
          while (polling) {
            const time = performance.now();
            const rows = (
              await pool.query(
                `SELECT a.pid,a.wait_event,a.query,l.locktype,l.classid,l.objid FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.application_name IN ('mixed-rust','mixed-node')`
              )
            ).rows;
            const seen = new Set();
            for (const r of rows) {
              const type =
                r.locktype === "advisory" && Number(r.classid) === 873791983
                  ? "participant-number"
                  : /treevite_invites/i.test(r.query)
                  ? "invite"
                  : "other";
              const key = `${r.pid}:${type}`;
              seen.add(key);
              if (!active.has(key)) active.set(key, { type, start: time });
            }
            for (const [key, item] of active)
              if (!seen.has(key)) {
                episodes.push({ type: item.type, ms: time - item.start });
                active.delete(key);
              }
            samples.push({ time, waiters: rows.map(({ query, ...r }) => r) });
            await sleep(5);
          }
        };
        const observer = sample();
        let blocker,
          allocatorBarrier = first;
        if (allocatorBarrier) {
          blocker = await pool.connect();
          await blocker.query("SELECT pg_advisory_lock(873791983,$1)", [zid]);
        } else if (kind === "invite") {
          blocker = await pool.connect();
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM treevite_invites WHERE zid=$1 FOR UPDATE",
            [zid]
          );
        }
        const start = Date.now();
        if (first) {
          fs.writeFileSync(dir + "/load-active", String(start));
          first = false;
        }
        const guardToken = issueParticipantJWT("anonymous", cid, owner, 0);
        const participationOffered = Promise.all(
          Array.from({ length: 12 }, async (_, i) => {
            const sent = await Promise.all([
              httpCall(
                node,
                "votes",
                {
                  conversation_id: cid,
                  tid: 0,
                  vote: convention.semanticToWire("agree"),
                },
                guardToken
              ),
              httpCall(
                node,
                "comments",
                {
                  conversation_id: cid,
                  txt: `Generated guard ${kind} ${round} ${i}`,
                  agid: 1,
                },
                guardToken
              ),
              httpCall(
                node,
                `nextComment?conversation_id=${cid}`,
                null,
                guardToken
              ),
            ]);
            return sent.map((r, j) => ({
              op: ["vote", "comment", "nextComment"][j],
              ...r,
            }));
          })
        );
        const offered = Promise.all(
          Array.from({ length: callers }, async (_, i) => {
            const writer = i % 2 ? "rust" : "node",
              begun = performance.now();
            const xid = `generated-${kind}-${round}-${i}`,
              caller = `${kind}-${round}-${i}`;
            let result, token, admitted;
            if (writer === "rust") {
              admitted = await rpc({
                zid,
                cid,
                caller,
                ...(kind === "xid" ? { xid } : {}),
                ...(kind === "oidc" ? { oidc: providerToken } : {}),
                ...(kind === "invite"
                  ? {
                      invite,
                      recovery: recovery[i],
                      hash: hashes[i],
                      lookup: crypto
                        .createHash("sha256")
                        .update(recovery[i] + "generated-mixed-pepper")
                        .digest("hex"),
                    }
                  : {}),
              }).catch((e) => ({ status: 0, error: e.message }));
              token = admitted.token;
              if (token && kind !== "invite")
                result = await httpCall(
                  node,
                  "votes",
                  {
                    conversation_id: cid,
                    tid: 0,
                    vote: convention.semanticToWire("agree"),
                  },
                  token
                );
              else
                result = {
                  status: token ? 200 : admitted.status ?? 500,
                  body: admitted,
                };
            } else {
              result = await httpCall(
                node,
                kind === "invite" ? "treevite/acceptInvite" : "votes",
                {
                  conversation_id: cid,
                  ...(kind === "invite"
                    ? { invite_code: invite }
                    : { tid: 0, vote: convention.semanticToWire("agree") }),
                  ...(kind === "xid" ? { xid } : {}),
                },
                kind === "oidc" ? providerToken : undefined,
                caller
              );
              token = result.body?.auth?.token;
            }
            const claims = token ? jwt.decode(token) : null;
            return {
              i,
              caller,
              writer,
              status: result.status,
              error: result.error,
              body: result.body,
              token,
              uid: claims?.uid,
              pid: claims?.pid,
              ms: performance.now() - begun,
              admissionMs: admitted?.admissionMs,
            };
          })
        );
        if (blocker && allocatorBarrier) {
          try {
            await until(
              () => fs.existsSync(dir + "/guard-measurement"),
              "guard measurement",
              5000
            );
          } catch (e) {
            check(false, `${kind}/${round} barrier: ${e.message}`);
          } finally {
            await blocker.query("SELECT pg_advisory_unlock(873791983,$1)", [
              zid,
            ]);
            blocker.release();
          }
        } else if (blocker) {
          try {
            await until(
              async () => {
                const rows = (
                  await pool.query(
                    "SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%treevite_invites%' AND application_name IN ('mixed-node','mixed-rust')"
                  )
                ).rows;
                return rows.length === 2;
              },
              "both invite writers waiting",
              5000
            );
          } catch (e) {
            check(false, `${kind}/${round} barrier: ${e.message}`);
          } finally {
            await blocker.query("ROLLBACK");
            blocker.release();
          }
        }
        const outcomes = await offered;
        const participation = (await participationOffered).flat();
        check(
          participation.every((r) => r.status === 200 && r.ms < 5000),
          `${kind}/${round} participation guard response or budget`
        );
        const guardVotes = (
          await pool.query(
            "SELECT count(*)::int n FROM votes WHERE zid=$1 AND pid=0",
            [zid]
          )
        ).rows[0].n;
        const guardComments = (
          await pool.query(
            "SELECT count(*)::int n FROM comments WHERE zid=$1 AND pid=0 AND tid<>0",
            [zid]
          )
        ).rows[0].n;
        check(
          guardVotes === 12 && guardComments === 12,
          `${kind}/${round} participation durability`
        );
        const end = Date.now();
        polling = false;
        await observer;
        for (const item of active.values())
          episodes.push({
            type: item.type,
            ms: performance.now() - item.start,
          });
        const members = (
          await pool.query(
            "SELECT uid,pid FROM participants WHERE zid=$1 AND uid<>$2 ORDER BY pid",
            [zid, owner]
          )
        ).rows;
        const newUsers = (
          await pool.query(
            `SELECT u.uid,a.writer,EXISTS(SELECT 1 FROM participants p WHERE p.uid=u.uid) member,EXISTS(SELECT 1 FROM oidc_user_mappings m WHERE m.uid=u.uid) mapped FROM users u JOIN mixed_audit a ON a.uid=u.uid AND a.kind='users' WHERE u.uid>$1`,
            [usersBefore]
          )
        ).rows;
        const successful = outcomes.filter((o) =>
            [200, 201].includes(o.status)
          ),
          minted = outcomes.filter((o) => o.token);
        const unexpected = outcomes.filter((o) =>
          kind !== "invite"
            ? o.status !== 200
            : ![200, 201, 400].includes(o.status)
        );
        check(unexpected.length === 0, `${kind}/${round} unexpected responses`);
        if (kind === "invite")
          check(
            outcomes
              .filter((o) => o.status === 400)
              .every((o) =>
                /polis_err_treevite_(invalid_or_used_invite|invite_race_condition)/.test(
                  JSON.stringify(o.body)
                )
              ),
            `${kind}/${round} only named invite refusals`
          );
        check(
          new Set(members.map((m) => m.pid)).size === members.length,
          `${kind}/${round} duplicate participant numbers`
        );
        const rustOrphans = newUsers.filter(
          (u) => u.writer === "mixed-rust" && !u.member && !u.mapped
        );
        const nodeOrphans = newUsers.filter(
          (u) => u.writer === "mixed-node" && !u.member && !u.mapped
        );
        check(rustOrphans.length === 0, `${kind}/${round} Rust orphan users`);
        let verification = 0,
          apiReadbacks = 0;
        for (const o of minted) {
          const request = { headers: { authorization: `Bearer ${o.token}` } };
          await new Promise((resolve, reject) =>
            createJwtValidation("verified")(request, {}, (e) =>
              e ? reject(e) : resolve()
            )
          ).catch(() =>
            check(false, `${kind}/${round} Node token verifier caller ${o.i}`)
          );
          const verified = await rpc({ cid, verify: o.token }).catch(() => ({
            error: "RPC verification failed",
          }));
          check(
            verified.uid === o.uid && verified.pid === o.pid,
            `${kind}/${round} cross verification caller ${o.i}`
          );
          check(
            members.some((m) => m.uid === o.uid && m.pid === o.pid),
            `${kind}/${round} token without membership ${o.i}`
          );
          verification++;
          if (kind === "anonymous") {
            const read = await httpCall(
              api,
              `votes/me?conversation_id=${cid}`,
              null,
              o.token
            );
            check(
              read.status === 200,
              `${kind}/${round} API readback caller ${o.i}`
            );
            apiReadbacks++;
          }
        }
        if (kind === "oidc") {
          const mapping = (
            await pool.query(
              "SELECT uid FROM oidc_user_mappings WHERE oidc_sub=$1",
              [sub]
            )
          ).rows;
          check(
            mapping.length === 1 &&
              members.length === 1 &&
              members[0].uid === mapping[0].uid,
            `${kind}/${round} same-sub convergence`
          );
          check(
            minted.every((o) => o.uid === mapping[0]?.uid),
            `${kind}/${round} token mapping agreement`
          );
        } else if (kind !== "invite") {
          check(
            minted.length === callers && members.length === callers,
            `${kind}/${round} lost joins`
          );
          check(
            members.every(
              (m) =>
                minted.filter((o) => o.uid === m.uid && o.pid === m.pid)
                  .length === 1
            ),
            `${kind}/${round} caller-row bijection`
          );
        }
        const stranded = members.filter(
          (m) => !minted.some((o) => o.uid === m.uid)
        );
        const audits = (
          await pool.query(
            "SELECT uid,writer,caller FROM mixed_audit WHERE kind='participants' AND zid=$1",
            [zid]
          )
        ).rows;
        check(
          audits
            .filter((a) => a.uid !== owner)
            .every(
              (a) => outcomes.filter((o) => o.caller === a.caller).length === 1
            ),
          `${kind}/${round} exact creator attribution`
        );
        const rustStranded = stranded.filter(
          (m) => audits.find((a) => a.uid === m.uid)?.writer === "mixed-rust"
        );
        if (kind !== "oidc")
          check(
            rustStranded.length === 0,
            `${kind}/${round} Rust unbindable participants`
          );
        if (kind === "invite") {
          check(
            successful.length === 1,
            `${kind}/${round} invite has exactly one success`
          );
          const winner = minted[0];
          const recovered = (
            await pool.query(
              "SELECT * FROM treevite_login_codes WHERE zid=$1 AND pid=$2",
              [zid, winner?.pid]
            )
          ).rows;
          const code =
            winner?.writer === "rust"
              ? recovery[winner.i]
              : winner?.body?.login_code;
          check(
            recovered.length === 1 && !!code,
            `${kind}/${round} durable recovery`
          );
          if (recovered.length === 1 && code) {
            const r = recovered[0];
            check(
              await bcrypt.compare(code, r.login_code_hash),
              `${kind}/${round} bindable bcrypt`
            );
            check(
              r.login_code_lookup ===
                crypto
                  .createHash("sha256")
                  .update(code + "generated-mixed-pepper")
                  .digest("hex"),
              `${kind}/${round} bindable lookup`
            );
            check(
              r.login_code_fingerprint ===
                crypto
                  .createHmac("sha256", "generated-mixed-fingerprint")
                  .update(`${zid}:${winner.pid}:${code}`)
                  .digest("hex"),
              `${kind}/${round} bindable fingerprint`
            );
          }
          check(
            stranded.every((m) => {
              const a = audits.find((a) => a.uid === m.uid);
              const o = outcomes.find((o) => o.caller === a?.caller);
              return (
                a?.writer === "mixed-node" &&
                o?.status === 400 &&
                JSON.stringify(o.body).includes(
                  "polis_err_treevite_invite_race_condition"
                )
              );
            }),
            `${kind}/${round} Node stranded rows pinned to known invite race`
          );
        }
        if (kind === "xid")
          check(
            (
              await pool.query(
                "SELECT count(*)::int n FROM xids WHERE owner=$1 AND xid LIKE $2",
                [owner, `generated-xid-${round}-%`]
              )
            ).rows[0].n === members.length,
            `${kind}/${round} XID binding coverage`
          );
        let votes = 0;
        if (kind !== "invite") {
          const rows = (
            await pool.query("SELECT vote FROM votes WHERE zid=$1 AND pid<>0", [
              zid,
            ])
          ).rows;
          votes = rows.length;
          check(
            votes === successful.length,
            `${kind}/${round} every answered vote committed once`
          );
          check(
            rows.every(
              (r) =>
                convention.storageToSemantic(r.vote, {
                  convention: convention.currentStorageConvention(),
                }) === "agree"
            ),
            `${kind}/${round} vote sign`
          );
        }
        check(
          successful.every((o) => o.ms < 5000),
          `${kind}/${round} participation exceeds 5000ms`
        );
        check(
          episodes.every((e) => e.ms < 5000),
          `${kind}/${round} observed lock wait exceeds 5000ms`
        );
        const row = {
          kind,
          round,
          start,
          end,
          sent: callers,
          answered: outcomes.filter((o) => o.status > 0).length,
          success: successful.length,
          tokens: minted.length,
          crossVerified: verification,
          apiReadbacks,
          members: members.length,
          votes,
          nodeOrphans: nodeOrphans.length,
          rustOrphans: rustOrphans.length,
          nodeStranded:
            kind === "oidc" ? 0 : stranded.length - rustStranded.length,
          rustStranded: rustStranded.length,
          latencyMs: stats(outcomes.map((o) => o.ms)),
          rustAdmissionMs: stats(
            outcomes
              .filter((o) => o.admissionMs !== undefined)
              .map((o) => o.admissionMs)
          ),
          lockWaitSampleMs: Object.fromEntries(
            ["participant-number", "invite", "other"].map((type) => [
              type,
              stats(episodes.filter((e) => e.type === type).map((e) => e.ms)),
            ])
          ),
          samplingMs: 5,
          allocatorBarrier,
          inviteBarrier: kind === "invite",
          participation: {
            sent: 36,
            answered: participation.filter((r) => r.status > 0).length,
            success: participation.filter((r) => r.status === 200).length,
            votes: guardVotes,
            comments: guardComments,
            latencyMs: stats(participation.map((r) => r.ms)),
          },
        };
        report.cases.push(row);
        save(`${kind}-${round}`, {
          row,
          outcomes: outcomes.map(({ token, ...o }) => ({
            ...o,
            body: o.body?.auth
              ? {
                  ...o.body,
                  auth: { ...o.body.auth, token: "[generated token verified]" },
                }
              : o.body?.token
              ? { ...o.body, token: "[generated token verified]" }
              : o.body,
          })),
          members,
          newUsers,
          episodes,
          samples,
          participation,
        });
        console.log("MIXED_IDENTITY " + JSON.stringify(row));
        save("summary", report);
        // Integrity or participation failures stop offered work; never retry them away.
        if (report.failures.length) throw Error(report.failures.join("; "));
      }
    }
    await guardDone;
    report.guard = {
      exit: guardExit,
      start: Number(fs.readFileSync(dir + "/guard-start")),
      end: Number(fs.readFileSync(dir + "/guard-end")),
      measurement: JSON.parse(fs.readFileSync(dir + "/guard-measurement")),
    };
    check(guardExit === 0, "unchanged participation guard failed");
    check(
      report.cases.some(
        (c) =>
          c.start <=
            report.guard.measurement.end - report.guard.measurement.busy_ms &&
          c.end >= report.guard.measurement.end
      ),
      "guard did not overlap offered load"
    );
    // Exercise the actual API against a committed Rust-created anonymous row.
    report.apiHealth = await (await fetch(api + "/health")).json();
    save("summary", report);
    assert.equal(report.failures.length, 0, report.failures.join("; "));
  } catch (e) {
    report.error = e.message;
    throw e;
  } finally {
    if (guard && guard.exitCode === null) guard.kill();
    save("summary", report);
    await pool.end();
    await rpc({ stop: true }).catch(() => {});
  }
}
