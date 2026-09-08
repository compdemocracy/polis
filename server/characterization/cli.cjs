"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  https = require("node:https");
const { Pool } = require("pg");
const {
  DynamoDBClient,
  ListTablesCommand,
  ScanCommand,
  CreateTableCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  canonical,
  hash,
  delta,
  firstDiff,
  normalizeDump,
  coverage,
  coverageStats,
  coverageTable,
  readRecording,
  oracle,
} = require("./core.cjs");
const { blob, writeRecording } = require("./recording.cjs");
const { assertAttempts } = require("./admission.cjs");
const { Normalizer, policy } = require("./normalize.cjs");
const { generate } = require("./generate.cjs");
const inventory = require("./inventory.json"),
  scope = require("./scope.json");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dynamo = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: "generatedlocal",
    secretAccessKey: "generatedlocal",
  },
  maxAttempts: 1,
});
const base = process.env.P027_BASE_URL || "http://localhost:5000";
const control = process.env.P027_CONTROL_URL || "http://localhost:5001";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quoted = (x) => '"' + x.replaceAll('"', '""') + '"';
async function get(p) {
  const r = await fetch(control + p, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error(`observer ${p}: ${r.status}`);
  return r.json();
}
async function schema() {
  return (
    await pool.query(
      "select table_name,column_name,data_type,udt_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position"
    )
  ).rows;
}
async function snapshot(tables) {
  const client = await pool.connect();
  const result = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const table of tables)
      result[`pg:${table}`] = (
        await client.query(
          `select to_jsonb(t) as row from ${quoted(
            table
          )} t order by to_jsonb(t)::text`
        )
      ).rows.map((r) => r.row);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  let next;
  do {
    const out = await dynamo.send(
      new ListTablesCommand({ ExclusiveStartTableName: next })
    );
    for (const table of out.TableNames) {
      let key;
      const rows = [];
      do {
        const page = await dynamo.send(
          new ScanCommand({
            TableName: table,
            ExclusiveStartKey: key,
            ConsistentRead: true,
          })
        );
        rows.push(...page.Items);
        key = page.LastEvaluatedKey;
      } while (key);
      result[`dynamo:${table}`] = rows.sort((a, b) =>
        canonical(a).localeCompare(canonical(b))
      );
    }
    next = out.LastEvaluatedTableName;
  } while (next);
  return result;
}
function send(request, tokens, deadlineMs = 2000) {
  return new Promise((resolve) => {
    const u = new URL(request.path, base);
    for (const [k, v] of Array.isArray(request.query)
      ? request.query
      : Object.entries(request.query))
      u.searchParams.append(
        k,
        typeof v === "object" ? JSON.stringify(v) : String(v)
      );
    const headers = { host: "localhost:5000", ...request.headers };
    if (request.method === "GET" && request.body !== null)
      headers["content-length"] = String(
        Buffer.byteLength(JSON.stringify(request.body))
      );
    if (headers.authorization?.startsWith("$auth:"))
      headers.authorization = `Bearer ${
        tokens[headers.authorization.slice(6)]
      }`;
    const start = performance.now();
    let responseStatus = null,
      responseHeaders = {},
      rawHeaders = [];
    const wireChunks = [];
    const elapsed = () => Math.max(0, Math.round(performance.now() - start));
    let first = null,
      done = false,
      chunks = [];
    const result = (
      completed,
      status = null,
      rheaders = {},
      termination = completed ? "end" : "aborted"
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks),
        raw = bytes.toString("utf8");
      const gzip = bytes[0] === 31 && bytes[1] === 139;
      let body = Buffer.from(raw).equals(bytes)
        ? raw
        : { $base64: bytes.toString("base64") };
      if (gzip) body = JSON.parse(require("node:zlib").gunzipSync(bytes));
      else if (rheaders["content-type"]?.includes("application/json")) {
        try {
          body = JSON.parse(raw);
        } catch {}
      }
      resolve({
        wire: {
          request: {
            method: request.method,
            target: blob(u.pathname + u.search),
            headers: req._header
              .split("\r\n")
              .slice(1)
              .filter(Boolean)
              .map((line) => {
                const at = line.indexOf(":"),
                  name = line.slice(0, at),
                  value = line.slice(at + 1).trim();
                return {
                  name,
                  value: name.toLowerCase() === "authorization" ? null : value,
                  credential_ref:
                    name.toLowerCase() === "authorization"
                      ? request.headers.authorization
                      : null,
                };
              }),
            body:
              request.body === null
                ? []
                : [
                    {
                      sequence: 0,
                      at_ms: 0,
                      bytes: blob(JSON.stringify(request.body)),
                    },
                  ],
            encoding: "utf8",
          },
          response: {
            status,
            headers: rawHeaders.reduce((a, v, i) => {
              if (i % 2 === 0)
                a.push({
                  name: v,
                  value: rawHeaders[i + 1],
                  credential_ref: null,
                });
              return a;
            }, []),
            body: wireChunks,
            completed,
            termination,
            first_byte_ms: first === null ? null : Math.round(first),
            last_byte_ms: elapsed(),
            process_alive_at_end: true,
          },
          encoding: gzip ? "gzip-json" : "utf8",
        },
        completed,
        status,
        headers: Object.fromEntries(
          policy.responseHeaders
            .filter((k) => rheaders[k] !== undefined)
            .map((k) => [k, rheaders[k]])
        ),
        body,
        ttfbMs: first,
        ttlbMs: performance.now() - start,
      });
    };
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      { method: request.method, headers },
      (res) => {
        first = performance.now() - start;
        responseStatus = res.statusCode;
        responseHeaders = res.headers;
        rawHeaders = res.rawHeaders;
        res.on("data", (b) => {
          chunks.push(b);
          wireChunks.push({
            sequence: wireChunks.length,
            at_ms: elapsed(),
            bytes: blob(b),
          });
        });
        res.on("end", () => result(true, res.statusCode, res.headers));
        res.on("error", () => result(false, res.statusCode, res.headers));
      }
    );
    const timer = setTimeout(() => {
      result(false, responseStatus, responseHeaders, "deadline");
      req.destroy();
    }, deadlineMs);
    req.on("error", () => result(false, responseStatus, responseHeaders));
    if (request.body !== null) req.write(JSON.stringify(request.body));
    req.end();
  });
}
let caseActive = false;
async function runCase(c, tokens, tables, normalizer) {
  if (caseActive) throw Error("concurrent case execution forbidden");
  caseActive = true;
  await get("/begin?seed=" + c.seed + "&case=" + encodeURIComponent(c.caseId));
  const before = await snapshot(tables),
    obsBefore = await get("/state");
  const response = await send(c.request, tokens);
  // Capture delayed 100 ms writes, then demand quiescence; do not treat an arbitrary delay as proof.
  await wait(200);
  let after = await snapshot(tables),
    stable = false;
  for (let n = 0; n < 25; n++) {
    await wait(100);
    const check = await snapshot(tables);
    const work = await get("/state")
      .then((s) => s.work)
      .catch(() => ({ pending: [1], late: [] }));
    if (
      canonical(after) === canonical(check) &&
      !work.pending.length &&
      !work.late.length
    ) {
      stable = await get("/barrier")
        .then((x) => x.name === "request-effects-drained")
        .catch(() => false);
      break;
    }
    after = check;
  }
  let observerUnavailable = false;
  const obsAfter = await get("/state").catch(() => {
    observerUnavailable = true;
    const events = fs
      .readFileSync("/artifacts/process-events.jsonl", "utf8")
      .trim();
    return {
      ...obsBefore,
      process: events
        ? events.split("\n").map((x) => JSON.parse(x))
        : obsBefore.process,
    };
  });
  const processErrors = obsAfter.process.slice(obsBefore.process.length);
  const db = delta(before, after),
    files = delta(
      Object.fromEntries(
        Object.entries(obsBefore.files).map(([k, v]) => [k, [v]])
      ),
      Object.fromEntries(
        Object.entries(obsAfter.files).map(([k, v]) => [k, [v]])
      )
    );
  const participants = (db["pg:participants"]?.added || []).filter(
    (a) =>
      !(db["pg:participants"]?.removed || []).some(
        (b) => a.zid === b.zid && a.pid === b.pid
      )
  );
  const issueStart = normalizer.issued.length;
  normalizer.binding = {
    publicKey: tokens.publicKey,
    now: 1700000000,
    issuer: "https://pol.is/",
    audience: "participants",
    ttl: 31536000,
    conversation_id:
      c.request.body?.conversation_id || c.request.query.conversation_id,
    participants: after["pg:participants"],
    zid: 1,
    actorUid: { owner: 1, admin: 2, moderator: 2, participant: 3 }[c.auth],
    oidcSub: ["owner", "admin"].includes(c.auth)
      ? JSON.parse(Buffer.from(tokens[c.auth].split(".")[1], "base64url")).sub
      : undefined,
    xid: c.request.body?.xid,
  };
  const wire = response.wire;
  wire.response.headers = require("./headers.cjs").headers(
    wire.response.headers
  );
  if (response.headers["set-cookie"])
    response.headers["set-cookie"] = wire.response.headers
      .filter((h) => h.credential_ref?.startsWith("$cookie:"))
      .map((h) => h.credential_ref + "; " + h.value);
  delete response.wire;
  const normalizedResponse = normalizer.normalize(response, "$.response");
  const issued = normalizer.issued.slice(issueStart);
  // Verify byte-derived headers before erasing token bytes, and replace only
  // verified token VALUES. Surrounding whitespace/key order remain wire evidence.
  let credentialWireValidation;
  if (issued.length) {
    const { bytes, strings } = require("./wire.cjs");
    const raw = bytes({ wire });
    const header = (name) =>
      wire.response.headers.find((h) => h.name.toLowerCase() === name)?.value;
    const etag = require("express/lib/utils").wetag;
    if (
      header("content-length") !== String(raw.length) ||
      header("etag") !== etag(raw)
    )
      throw Error("credential wire header derivation mismatch");
    let replaced = 0;
    const safe = strings(raw.toString("utf8"), (value, path, key) => {
      if (
        !/jwt|token/i.test(key) ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
      )
        return value;
      const verified = path.reduce((x, k) => x?.[k], normalizedResponse.body);
      if (!verified || typeof verified !== "object")
        throw Error("unverified wire credential");
      replaced++;
      return "$jwt:" + hash(verified);
    });
    if (replaced !== issued.length)
      throw Error("credential substitution count mismatch");
    credentialWireValidation = {
      kind: "verified-jwt-values/1",
      contentLength: header("content-length"),
      etag: header("etag"),
      count: replaced,
    };
    wire.response.body = [
      { sequence: 0, at_ms: wire.response.last_byte_ms, bytes: blob(safe) },
    ];
  }
  wire.response.process_alive_at_end = !observerUnavailable;
  if (observerUnavailable) wire.response.termination = "process_exit";
  const effects = {
    db,
    files,
    outbound: obsAfter.outbound.slice(obsBefore.outbound.length),
    participantCreated: participants.length,
    participants,
    jwtIssued: issued.length,
    jwts: issued,
    jwtMinted: (obsAfter.jwtIssues || 0) - (obsBefore.jwtIssues || 0),
  };
  const o = oracle(response, processErrors, c.case === "proxy-tail");
  try {
    assertAttempts(effects.outbound);
  } catch (e) {
    o.pass = false;
    o.failures.push(e.message);
  }
  if (observerUnavailable) {
    o.pass = false;
    o.failures.push("observer unavailable");
  }
  if (!stable) {
    o.pass = false;
    o.failures.push("effects did not settle");
  }
  const enabled = inventory.routes.filter(
    (r) => r.registered_in_default_config
  );
  const routeHits = [
    ...new Set(
      obsAfter.hits.slice(obsBefore.hits.length).map((i) => enabled[i]?.id)
    ),
  ].sort((a, b) => a - b);
  if (
    process.env.P027_MARKERS !== "0" &&
    c.routeId &&
    !routeHits.includes(c.routeId)
  ) {
    o.pass = false;
    o.failures.push("target route was not reached");
  }
  caseActive = false;
  return {
    ...c,
    version: 1,
    wire,
    ...(credentialWireValidation ? { credentialWireValidation } : {}),
    response: normalizedResponse,
    effects: normalizer.normalize(effects, "$.effects"),
    process: processErrors,
    oracle: o,
    routeHits,
  };
}
const { firstDifference } = require("./compare.cjs");
function write(dir, name, x) {
  fs.writeFileSync(
    path.join(dir, name),
    typeof x === "string" ? x : JSON.stringify(x, null, 2) + "\n"
  );
}
async function main() {
  const [
    command,
    dir = "/artifacts/recording",
    profile = "boundary",
    fromRoute = "1",
  ] = process.argv.slice(2);
  if (
    !/^\d+$/.test(fromRoute) ||
    Number(fromRoute) < 1 ||
    Number(fromRoute) > 201
  )
    throw Error("from-route must be an inventory ID from 1 through 201");
  if (command === "seed-pages") {
    const TableName = "Delphi_NarrativeReports";
    await dynamo.send(
      new CreateTableCommand({
        TableName,
        ...require("./dynamo-schema.json").tables[TableName],
      })
    );
    // Six generated 300 KiB rows force real DynamoDB pagination at its 1 MiB page boundary.
    for (let i = 0; i < 6; i++)
      await dynamo.send(
        new PutItemCommand({
          TableName,
          Item: Object.fromEntries(
            Object.entries({
              rid_section_model: `r2p027generated#section${i}#generated`,
              timestamp: "2023-11-14T22:13:20.000Z",
              report_id: "r2p027generated",
              job_id: "p027-generated-job",
              report_data: "Generated narrative. ".repeat(15000),
            }).map(([k, v]) => [k, { S: v }])
          ),
        })
      );
    console.log("generated two-page provider fixture installed");
    return;
  }
  if (command === "init-dynamo") {
    const tables = require("./dynamo-schema.json").tables;
    for (const [TableName, spec] of Object.entries(tables).filter(
      ([name]) => name !== "Delphi_NarrativeReports"
    ))
      await dynamo.send(new CreateTableCommand({ TableName, ...spec }));
    await pool.query(
      "INSERT INTO participant_metadata_questions(pmqid,zid,key,created) VALUES(1,1,'Generated question',1700000000000)"
    );
    await pool.query(
      "INSERT INTO participant_metadata_answers(pmaid,pmqid,zid,value,created) VALUES(1,1,1,'Generated answer',1700000000000)"
    );
    await pool.query(
      "SELECT setval('participant_metadata_questions_pmqid_seq',1,true),setval('participant_metadata_answers_pmaid_seq',1,true)"
    );
    console.log(
      `created ${
        Object.keys(tables).length
      } generated empty Dynamo tables and generated metadata fixtures`
    );
    return;
  }
  if (command === "seed") {
    if (new URL(process.env.DATABASE_URL).pathname !== "/p027")
      throw Error("seed only accepts disposable p027 database");
    const tables = (
      await pool.query(
        "select tablename from pg_tables where schemaname='public' order by tablename"
      )
    ).rows.map((r) => r.tablename);
    await pool.query(
      `TRUNCATE ${tables.map(quoted).join(",")} RESTART IDENTITY CASCADE`
    );
    await pool.query(
      fs.readFileSync(path.join(__dirname, "fixture.sql"), "utf8")
    );
    for (const r of await schema()) {
      if (
        policy.timeFields.includes(r.column_name) &&
        ["bigint", "integer"].includes(r.data_type) &&
        tables.includes(r.table_name)
      )
        await pool.query(
          `UPDATE ${quoted(r.table_name)} SET ${quoted(
            r.column_name
          )}=1700000000000 WHERE ${quoted(
            r.column_name
          )} IS NOT NULL AND ${quoted(r.column_name)} NOT IN (0,-1)`
        );
    }
    await pool.query(
      "UPDATE conversations SET created=1700000000000+zid*1000, modified=1700000000000+zid*1000"
    );
    await pool.query(
      "UPDATE zinvites SET uuid='00000000-0000-4000-8000-000000000027'"
    );
    const tokens = await get("/tokens");
    for (const [role, uid] of [
      ["owner", 1],
      ["admin", 2],
    ]) {
      const claims = JSON.parse(
        Buffer.from(tokens[role].split(".")[1], "base64url")
      );
      await pool.query(
        "INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES($1,$2,1700000000000)",
        [claims.sub, uid]
      );
    }
    console.log("generated fixture installed");
    return;
  }
  const dump = await get("/ready");
  const routes = normalizeDump(dump, inventory);
  require("./serialization.cjs").assertProfile(dump.serialization);
  if (command === "probe-oracle") {
    const before = await get("/state");
    const response = await send(
      {
        method: "GET",
        path: "/api/v3/testConnection",
        query: {},
        headers: { "x-forwarded-proto": "https" },
        body: null,
      },
      {}
    );
    await wait(200);
    const after = await get("/state").catch(() => ({
      process: fs
        .readFileSync("/artifacts/process-events.jsonl", "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x)),
    }));
    const verdict = oracle(
      response,
      after.process.slice(before.process.length)
    );
    console.log(
      JSON.stringify({ route: "GET /api/v3/testConnection", response, verdict })
    );
    if (!verdict.pass) process.exitCode = 1;
    return;
  }
  if (command === "coverage") {
    console.log(
      `PASS: ${dump.routes.length} runtime entries -> ${routes.length} enabled + 1 explicitly disabled = 201`
    );
    return;
  }
  if (dump.boot.notificationLoop)
    throw Error(
      "background notification loop running during ordinary recording"
    );
  assertAttempts(dump.boot.outbound, true);
  if (dump.boot.process.length) throw Error("process error at boot");
  const schemaRows = await schema();
  if (hash(schemaRows) !== hash(require("./catalog.json")))
    throw Error(
      "unknown schema column/type: update the reviewed catalog and column policy before recording"
    );
  const tables = [...new Set(schemaRows.map((r) => r.table_name))].filter(
    (t) => !t.startsWith("pg_")
  );
  // Snapshot only tables, not views (views can be nondeterministic and duplicate effects).
  const actualTables = new Set(
    (
      await pool.query(
        "select tablename from pg_tables where schemaname='public'"
      )
    ).rows.map((r) => r.tablename)
  );
  const selected = tables.filter((t) => actualTables.has(t));
  const tokens = { ...(await get("/tokens")), ...(await get("/public-key")) };
  tokens.moderator = tokens.admin; // uid 2 is the configured global moderator.
  const participantBindings = [];
  for (const f of require("./pca2-fixtures.json").filter(
    (f) => f.auth === "participant"
  )) {
    const binding = {
      publicKey: tokens.publicKey,
      now: 1700000000,
      issuer: "https://pol.is/",
      audience: "participants",
      ttl: 31536000,
      conversation_id: f.capability,
      uid: 3,
      pid: 2,
      sub: "anon:3",
    };
    require("./jwt.cjs").verifyToken(tokens[`participant-${f.zid}`], binding);
    const rows = await pool.query(
      "select pid from participants where zid=$1 and uid=3",
      [f.zid]
    );
    if (rows.rows.length !== 1 || rows.rows[0].pid !== 2)
      throw Error("PCA2 participant binding missing");
    participantBindings.push({
      credentialRef: `$auth:participant-${f.zid}`,
      zid: f.zid,
      uid: 3,
      pid: 2,
      conversation_id: f.capability,
      verified: true,
    });
  }
  for (const auth of ["participant", "owner", "admin"]) {
    const probe = await send(
      {
        method: "GET",
        path: "/api/v3/users",
        query: {},
        headers: {
          authorization: `$auth:${auth}`,
          "x-forwarded-proto": "https",
        },
        body: null,
      },
      tokens
    );
    if (probe.status !== 200)
      throw Error(`auth preflight failed for ${auth}: ${probe.status}`);
  }
  const norm = new Normalizer(),
    initial = await snapshot(selected);
  const expected = command === "replay" ? readRecording(dir) : null;
  if (process.env.P027_PARITY_ONLY) {
    if (!expected || process.env.P027_MARKERS !== "0")
      throw Error("parity selection requires marker-disabled replay");
    const ids = process.env.P027_PARITY_ONLY.split(",");
    if (ids.some((id) => !expected.cases.some((c) => c.caseId === id)))
      throw Error("missing parity scenario");
    expected.cases = expected.cases.filter((c) => ids.includes(c.caseId));
  }
  const planned = expected
    ? expected.cases.map((c) => ({
        caseId: c.caseId,
        routeId: c.routeId,
        auth: c.auth,
        case: c.case,
        seed: c.seed,
        request: c.request,
      }))
    : generate(inventory, scope, "p027-v1", profile).filter(
        (c) =>
          (c.routeId === null || c.routeId >= Number(fromRoute)) &&
          (!process.env.P027_ONLY ||
            process.env.P027_ONLY.split(",").includes(c.caseId))
      );
  if (expected) {
    if (
      firstDiff(expected.manifest.serialization, dump.serialization) ||
      firstDiff(expected.manifest.runtime, dump.runtime)
    )
      throw Error("serialization/runtime profile mismatch");
    const recordedDump = JSON.parse(
      fs.readFileSync(path.join(dir, "routes.json"))
    );
    if (
      firstDiff(normalizeDump(recordedDump, inventory), routes) ||
      firstDiff(recordedDump.middleware, dump.middleware)
    )
      throw Error("runtime route callback/middleware inventory mismatch");
    for (const [k, v] of Object.entries({
      inventoryHash: hash(inventory),
      schemaHash: hash(schemaRows),
      normalizationHash: hash(policy),
      scopeHash: hash(scope),
      corpusHash: hash(initial),
    }))
      if (expected.manifest[k] !== v) throw Error(`manifest ${k} mismatch`);
  }
  const results = [],
    diffs = [];
  for (let i = 0; i < planned.length; i++) {
    const actual = await runCase(planned[i], tokens, selected, norm);
    results.push(actual);
    const field = expected ? firstDifference(expected.cases[i], actual) : null;
    diffs.push({
      route: actual.routeId,
      auth: actual.auth,
      case: actual.case,
      result: field || !actual.oracle.pass ? "different" : "same",
      firstField: field || actual.oracle.failures[0] || "",
    });
    if (i % 25 === 0 || !actual.oracle.pass || field)
      console.log(
        `${i + 1}/${planned.length} ${actual.caseId} status=${
          actual.response.status
        } ${
          actual.oracle.pass ? "complete" : actual.oracle.failures.join("; ")
        }${field ? " DIFF " + field : ""}`
      );
    if (
      (field && process.env.P027_STOP_ON_DIFF === "1") ||
      actual.oracle.failures.includes("observer unavailable") ||
      actual.oracle.failures.includes("effects did not settle")
    )
      break;
  }
  const cov = coverage(inventory, scope, results),
    failures = results.filter((c) => !c.oracle.pass).length;
  if (command === "record") {
    fs.mkdirSync(dir, { recursive: true });
    const meta = fs.existsSync("/artifacts/stack.json")
      ? JSON.parse(fs.readFileSync("/artifacts/stack.json"))
      : null;
    if (!meta) throw Error("missing host-verified stack.json provenance");
    const metadata = {
      version: 2,
      expressVersion: require("express/package.json").version,
      serialization: dump.serialization,
      runtime: dump.runtime,
      inventoryHash: hash(inventory),
      inventorySourceHash: inventory.source_sha256,
      appCommit: meta.commit,
      appSourceHash: meta.sourceHash,
      stackDigest: hash(meta),
      stack: meta,
      schemaHash: hash(schemaRows),
      migrationVersion: meta.migrationHash,
      seed: "p027-v1",
      profile,
      scopeHash: hash(scope),
      normalizationHash: hash(policy),
      corpusHash: hash(initial),
      inputsHash: hash(
        results.map((c) => ({ caseId: c.caseId, request: c.request }))
      ),
      caseCount: results.length,
      blockingFailures: failures,
      coverage: cov,
    };
    writeRecording(dir, metadata, results, {
      "schema.json": schemaRows,
      "boot.json": dump.boot,
      "routes.json": dump,
      "normalization.json": {
        policy,
        applications: norm.rules,
        code: fs.readFileSync(path.join(__dirname, "normalize.cjs"), "utf8"),
      },
      "generated-policy.json": {
        origin:
          "fixture.sql + pca2-fixtures.json + Python engine/writer; no imported data permitted",
        columns: schemaRows.map((r) => ({ ...r, policy: "generated-exact" })),
      },
      "run.json": {
        ...meta,
        serialization: dump.serialization,
        runtime: dump.runtime,
      },
      "recording-schema.json": require("./P-025-recording.schema.json"),
      "pca2-auth.json": {
        participantBindings,
        moderator: {
          credentialRef: "$auth:moderator",
          uid: 2,
          source: "ADMIN_UIDS=[2]; isPolisDev grants isModerator",
        },
      },
      "pca2-fixtures.json": require("./pca2-fixtures.json"),
      "pca2-seed.json": JSON.parse(
        fs.readFileSync("/artifacts/pca2-seed.json", "utf8")
      ),
      "seed-pca2.py": fs.readFileSync(
        path.join(__dirname, "seed-pca2.py"),
        "utf8"
      ),
      "fixture.sql": fs.readFileSync(
        path.join(__dirname, "fixture.sql"),
        "utf8"
      ),
      "clock.cjs": fs.readFileSync(path.join(__dirname, "clock.cjs"), "utf8"),
    });
    if (!failures && Number(fromRoute) === 1 && !process.env.P027_ONLY)
      readRecording(dir);
  }
  const out = command === "replay" ? `${dir}-replay` : dir;
  fs.mkdirSync(out, { recursive: true });
  if (command === "replay")
    write(
      out,
      "comparisons.actual.jsonl",
      results.map((c) => JSON.stringify(c)).join("\n") + "\n"
    );
  const stats = coverageStats(results);
  write(out, "coverage-stats.json", stats);
  write(out, "results.json", {
    cases: results.length,
    failures,
    differences: diffs.filter((d) => d.result === "different").length,
    coverage: cov,
    rows: diffs,
  });
  write(
    out,
    "report.md",
    `Validation-heavy generated corpus: ${stats.cases} cases; ${stats.opaque400Cases}/${stats.cases} bodies are the identical opaque "Bad Request" string (HTTP 400, trailing newline) under production serialization, not distinct response shapes; ${stats.registrationsWith2xx}/${stats.targetRegistrations} targeted registrations with any 2xx; ${stats.roleInvariantRegistrations} role-invariant registrations; ${stats.dbEffectCases} DB-effect cases; ${stats.participantsCreated} participants and ${stats.jwtsIssued} verified client-visible JWTs. Three temporary P-029/r11,r88,r102 generator exceptions remain. Dispatch coverage is not API replacement admission.\n\n` +
      coverageTable(stats) +
      "\n" +
      "| Route | Auth | Case | Result | First differing field |\n|---|---|---|---|---|\n" +
      diffs
        .map(
          (d) =>
            `| ${d.route ?? "proxy-tail"} | ${d.auth} | ${d.case} | ${
              d.result
            } | ${d.firstField} |`
        )
        .join("\n") +
      "\n"
  );
  console.log(
    JSON.stringify({
      cases: results.length,
      oracleFailures: failures,
      differences: diffs.filter((d) => d.result === "different").length,
      recorded: cov.recorded,
      excluded: cov.excluded,
      missing: cov.missing,
    })
  );
  if (
    failures ||
    (cov.missing && profile !== "pca2" && process.env.P027_MARKERS !== "0") ||
    diffs.some((d) => d.result === "different")
  )
    process.exitCode = 1;
}
async function close() {
  await pool.end();
  dynamo.destroy();
}

// The recorder is also a library: an alternate-runtime judge reuses this exact
// sender, snapshot and schema reader rather than reimplementing request
// semantics. Requiring the module must not run the recorder, and a consumer
// needs a way to release the pg pool and the DynamoDB client it opens on import.
module.exports = { send, snapshot, schema, close };

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e.stack);
      process.exitCode = 1;
    })
    .finally(close);
}
