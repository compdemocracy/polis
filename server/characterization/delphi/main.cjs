"use strict";
/**
 * Delphi read-route characterization (P-077 P2-0): record or replay.
 *
 *   node characterization/delphi/main.cjs record   # writes recordings/
 *   node characterization/delphi/main.cjs replay   # byte-compares against recordings/
 *
 * Needs a Postgres (P2ZERO_PG_ADMIN_URL, a superuser URL; the database
 * `p2zero` on it is dropped and rebuilt from the migrations every run) and a
 * DynamoDB Local (DYNAMODB_ENDPOINT; every Delphi table on it is dropped and
 * recreated). Nothing else: the OIDC JWKS and the S3 listing come from a local
 * stub fed by generated fixtures, and the server runs in this process with the
 * clock pinned to the harness instant (../clock.cjs, 1700000000000).
 *
 * Steps: rebuild Postgres and load fixtures/postgres.sql; recreate the Delphi
 * tables; prove the storage codec round-trips every golden family and every
 * fixture family byte-exact THROUGH DynamoDB Local (write, strongly consistent
 * scan, re-encode, compare); load the fixtures; boot the unchanged server;
 * request every case in cases.cjs; record or compare.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const HERE = __dirname;
const SERVER = path.resolve(HERE, "../..");
const ROOT = path.resolve(SERVER, "..");
const RECORDINGS = path.join(HERE, "recordings");
const FIXTURES = path.join(HERE, "fixtures");
const GOLDEN = path.join(ROOT, "delphi/polismath/delphi_storage/golden");
const FORMAT = "delphi-characterization/1";
const EXCLUDED_HEADERS = new Set(["date", "connection", "keep-alive"]);

const mode = process.argv[2];
if (!["record", "replay"].includes(mode)) {
  console.error("usage: main.cjs record|replay");
  process.exit(2);
}
for (const k of ["P2ZERO_PG_ADMIN_URL", "DYNAMODB_ENDPOINT"])
  if (!process.env[k]) {
    console.error(`${k} is required`);
    process.exit(2);
  }

const APP_PORT = Number(process.env.P2ZERO_APP_PORT || 5470);
const STUB_PORT = Number(process.env.P2ZERO_STUB_PORT || 5471);
const pgAdmin = new URL(process.env.P2ZERO_PG_ADMIN_URL);
const pgApp = new URL(process.env.P2ZERO_PG_ADMIN_URL);
pgApp.pathname = "/p2zero";

// Every setting that can reach a recorded byte is pinned here, whatever the
// caller's environment says.
const PINNED_ENV = {
  NODE_ENV: "production",
  DEV_MODE: "true",
  TZ: "UTC",
  SERVER_LOG_LEVEL: "error",
  DATABASE_URL: pgApp.toString(),
  DATABASE_SSL: "false",
  DOMAIN_OVERRIDE: "localhost",
  SERVICE_URL: "http://localhost",
  EMBED_SERVICE_HOSTNAME: "localhost",
  STATIC_FILES_HOST: "localhost",
  STATIC_FILES_PORT: "8080",
  MATH_ENV: "p2zero",
  AUTH_ISSUER: "https://oidc.p2zero.invalid/",
  AUTH_AUDIENCE: "users",
  AUTH_NAMESPACE: "https://pol.is/",
  JWKS_URI: `http://127.0.0.1:${STUB_PORT}/.well-known/jwks.json`,
  POLIS_JWT_ISSUER: "https://pol.is/",
  POLIS_JWT_AUDIENCE: "participants",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "generatedlocal",
  AWS_SECRET_ACCESS_KEY: "generatedlocal",
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_S3_ENDPOINT: `http://127.0.0.1:${STUB_PORT}`,
  AWS_S3_PUBLIC_ENDPOINT: "http://s3.p2zero.invalid",
  AWS_S3_BUCKET_NAME: "polis-delphi",
  AWS_ENDPOINT_URL_SQS: "http://127.0.0.1:9",
  SES_ENDPOINT: "http://127.0.0.1:9",
  POLIS_FROM_ADDRESS: "sender@example.invalid",
  SHOULD_USE_TRANSLATION_API: "false",
  ADMIN_UIDS: "[2]",
  WEBSERVER_USERNAME: "generated-worker",
  WEBSERVER_PASS: "generated-worker",
  TOPICAL_COMMENT_RATIO: "0",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GEMINI_API_KEY: "",
};
Object.assign(process.env, PINNED_ENV);
process.chdir(SERVER);
require("ts-node/register/transpile-only");

const codec = require(path.join(SERVER, "src/utils/delphiStorageCodec.ts"));
const { definition, TABLES } = require("./tables.cjs");
const { allCases, manifest } = require("./cases.cjs");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ------------------------------------------------------------------ Postgres

async function setupPostgres() {
  const { Client } = require("pg");
  const admin = new Client({ connectionString: pgAdmin.toString() });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS p2zero WITH (FORCE)");
  await admin.query("CREATE DATABASE p2zero");
  await admin.end();
  const db = new Client({ connectionString: pgApp.toString() });
  await db.connect();
  const dir = path.join(SERVER, "postgres/migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files)
    await db.query(fs.readFileSync(path.join(dir, f), "utf8"));
  await db.query(fs.readFileSync(path.join(FIXTURES, "postgres.sql"), "utf8"));
  await db.end();
  return files.length;
}

// ------------------------------------------------------------------ DynamoDB

function dynamo() {
  const {
    DynamoDBClient,
    CreateTableCommand,
    DeleteTableCommand,
    ListTablesCommand,
    BatchWriteItemCommand,
    ScanCommand,
  } = require("@aws-sdk/client-dynamodb");
  const client = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: "us-east-1",
    credentials: {
      accessKeyId: "generatedlocal",
      secretAccessKey: "generatedlocal",
    },
  });
  return {
    async recreateAll() {
      const existing = new Set();
      let start;
      do {
        const r = await client.send(
          new ListTablesCommand({ ExclusiveStartTableName: start })
        );
        (r.TableNames || []).forEach((t) => existing.add(t));
        start = r.LastEvaluatedTableName;
      } while (start);
      for (const name of Object.keys(TABLES)) {
        if (existing.has(name))
          await client.send(new DeleteTableCommand({ TableName: name }));
        await client.send(new CreateTableCommand(definition(name)));
      }
    },
    async write(table, items) {
      for (let i = 0; i < items.length; i += 25) {
        let request = {
          [table]: items
            .slice(i, i + 25)
            .map((Item) => ({ PutRequest: { Item } })),
        };
        for (let tries = 0; Object.keys(request).length; tries++) {
          if (tries > 20) throw new Error(`unprocessed writes on ${table}`);
          const r = await client.send(
            new BatchWriteItemCommand({ RequestItems: request })
          );
          request = r.UnprocessedItems || {};
        }
      }
    },
    async scan(table) {
      const items = [];
      let start;
      do {
        const r = await client.send(
          new ScanCommand({
            TableName: table,
            ConsistentRead: true,
            ExclusiveStartKey: start,
          })
        );
        items.push(...(r.Items || []));
        start = r.LastEvaluatedKey;
      } while (start);
      return items;
    },
  };
}

/** Write one family file, scan it back, and require the same bytes. */
async function storeRoundTrip(db, file) {
  const bytes = fs.readFileSync(file);
  const { family, items } = codec.decodeFamily(bytes);
  await db.write(family, items);
  const back = codec.encodeFamily(family, await db.scan(family));
  if (Buffer.compare(back, bytes) !== 0)
    throw new Error(
      `codec store round trip differs for ${path.relative(ROOT, file)}`
    );
  return { family, rows: items.length };
}

async function setupDynamo() {
  const db = dynamo();
  await db.recreateAll();
  const golden = fs
    .readdirSync(GOLDEN)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const goldenResult = [];
  for (const f of golden)
    goldenResult.push(await storeRoundTrip(db, path.join(GOLDEN, f)));
  await db.recreateAll();
  const dir = path.join(FIXTURES, "dynamo");
  const fixtureResult = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".jsonl"))
    .sort())
    fixtureResult.push(await storeRoundTrip(db, path.join(dir, f)));
  return { golden: goldenResult, fixtures: fixtureResult };
}

// -------------------------------------------------------------- credentials

function b64url(x) {
  return Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString(
    "base64url"
  );
}

function oidcSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "p2zero-generated",
    alg: "RS256",
    use: "sig",
  };
  const sign = (claims) => {
    const head = b64url({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const body = b64url(claims);
    const sig = crypto
      .sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey)
      .toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

// ------------------------------------------------------------------ requests

function request(p, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: APP_PORT,
        path: p,
        method: "GET",
        agent: false,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i].toLowerCase();
            if (!EXCLUDED_HEADERS.has(name))
              headers.push([name, res.rawHeaders[i + 1]]);
          }
          resolve({
            status: res.statusCode,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error(`timeout on ${p}`)));
    req.on("error", reject);
    req.end();
  });
}

function serialize(c, r) {
  const utf8 = Buffer.from(r.body.toString("utf8"), "utf8").equals(r.body);
  const rec = {
    format: FORMAT,
    case: c.id,
    state: c.state,
    route: c.route,
    request: { method: "GET", path: c.path, auth: c.auth },
    response: {
      status: r.status,
      headers: r.headers,
      bodyEncoding: utf8 ? "utf8" : "base64",
      body: utf8 ? r.body.toString("utf8") : r.body.toString("base64"),
      bodySha256: sha256(r.body),
    },
  };
  return JSON.stringify(rec, null, 1) + "\n";
}

function fixtureDigest() {
  const files = [];
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.push(f);
    });
  walk(FIXTURES);
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) {
    h.update(path.relative(FIXTURES, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}

function firstDifference(a, b) {
  const x = JSON.parse(a).response;
  const y = JSON.parse(b).response;
  if (x.status !== y.status) return `status ${y.status} -> ${x.status}`;
  if (JSON.stringify(x.headers) !== JSON.stringify(y.headers))
    return `headers ${JSON.stringify(y.headers)} -> ${JSON.stringify(
      x.headers
    )}`;
  if (x.body !== y.body) {
    let i = 0;
    while (i < x.body.length && x.body[i] === y.body[i]) i++;
    return `body differs at offset ${i}: recorded ${JSON.stringify(
      y.body.slice(i, i + 80)
    )} served ${JSON.stringify(x.body.slice(i, i + 80))}`;
  }
  return "record envelope differs";
}

// ---------------------------------------------------------------------- main

async function main() {
  const migrations = await setupPostgres();
  const store = await setupDynamo();
  console.log(
    `postgres: ${migrations} migrations + fixtures; codec store round trip: ${store.golden.length} golden families, ${store.fixtures.length} fixture families byte-exact`
  );

  const signer = oidcSigner();
  const stub = await require("./stub.cjs").start(STUB_PORT, signer.jwks);

  // Participant JWT keys are generated per run; no credential is recorded.
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  process.env.JWT_PRIVATE_KEY = pair.privateKey;
  process.env.JWT_PUBLIC_KEY = pair.publicKey;

  const clock = require("../clock.cjs");
  clock.install();
  const { default: app, appReady } = require(path.join(SERVER, "app.ts"));
  await appReady;
  await require(path.join(SERVER, "src/utils/moderation.ts")).moderationReady;
  const server = app.listen(APP_PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  const now = Math.floor(clock.instant / 1000);
  const oidc = (sub, email, delphi) =>
    signer.sign({
      iss: PINNED_ENV.AUTH_ISSUER,
      aud: PINNED_ENV.AUTH_AUDIENCE,
      sub,
      email,
      iat: now - 60,
      exp: now + 3600,
      ...(delphi === undefined
        ? {}
        : { [`${PINNED_ENV.AUTH_NAMESPACE}delphi_enabled`]: delphi }),
    });
  const { issueAnonymousJWT } = require(path.join(
    SERVER,
    "src/auth/anonymous-jwt.ts"
  ));
  const tokenFor = (c) => {
    if (c.auth === "none") return null;
    if (c.auth === "owner")
      return oidc("p2zero|owner", "owner@example.invalid");
    if (c.auth === "other")
      return oidc("p2zero|other", "other@example.invalid");
    const pid = Number(c.auth.split(":")[1]);
    const m = manifest.states[c.state];
    return issueAnonymousJWT(m.conversation_id, 9 + pid, pid);
  };

  const cases = allCases();
  const index = {
    format: FORMAT,
    codec: codec.CODEC_VERSION,
    clockMs: clock.instant,
    fixtureSha256: fixtureDigest(),
    excludedHeaders: [...EXCLUDED_HEADERS],
    pinnedEnv: Object.keys(PINNED_ENV).sort(),
    caseCount: cases.length,
    cases: [],
  };
  const failures = [];
  const statusCounts = {};
  for (const c of cases) {
    const r = await request(c.path, tokenFor(c));
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const text = serialize(c, r);
    const file = path.join(RECORDINGS, `${c.id}.json`);
    index.cases.push({
      id: c.id,
      status: r.status,
      sha256: sha256(Buffer.from(text)),
    });
    if (mode === "record") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    } else if (!fs.existsSync(file)) failures.push(`${c.id}: no recording`);
    else {
      const recorded = fs.readFileSync(file, "utf8");
      if (recorded !== text)
        failures.push(`${c.id}: ${firstDifference(text, recorded)}`);
    }
  }
  const indexText = JSON.stringify(index, null, 1) + "\n";
  const indexFile = path.join(RECORDINGS, "index.json");
  if (mode === "record") fs.writeFileSync(indexFile, indexText);
  else {
    const listed = new Set(cases.map((c) => `${c.id}.json`));
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const f = path.join(d, e.name);
        return e.isDirectory() ? walk(f) : [path.relative(RECORDINGS, f)];
      });
    for (const f of walk(RECORDINGS))
      if (f !== "index.json" && !listed.has(f))
        failures.push(`${f}: recording with no case`);
    if (
      !fs.existsSync(indexFile) ||
      fs.readFileSync(indexFile, "utf8") !== indexText
    )
      failures.push(
        "index.json differs (case list, fixtures, codec or pins changed)"
      );
  }
  server.close();
  stub.server.close();
  console.log(
    `${mode}: ${cases.length} cases; status counts ${JSON.stringify(
      statusCounts
    )}`
  );
  console.log(`stub requests: ${stub.seen.length}`);
  if (failures.length) {
    console.error(`${failures.length} difference(s):`);
    for (const f of failures.slice(0, 50)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    mode === "record"
      ? "recorded"
      : "replay matches every recording byte for byte"
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
