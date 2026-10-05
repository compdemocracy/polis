"use strict";
/**
 * Collective-statement recordings: what the server does TODAY on every
 * collective-statement route in every state, recorded with the model provider
 * replaced by a local stub at the HTTP boundary.
 *
 *   node characterization/collective-statement/main.cjs record   # writes recordings/
 *   node characterization/collective-statement/main.cjs replay   # compares with recordings/
 *        [--failures <file>]   also write the failing case ids as JSON (mutation runner)
 *
 * Needs a Postgres (CSREC_PG_ADMIN_URL, a superuser URL; the database `csrec`
 * on it is dropped and rebuilt from the migrations every run), a DynamoDB
 * Local (DYNAMODB_ENDPOINT; every Delphi table on it is dropped and recreated)
 * and, for the reset case, a python3 with boto3 (CSREC_PYTHON, default
 * python3). Everything else is in this process: the unchanged server bound to
 * 127.0.0.1, and one stub on 127.0.0.1 that serves the OIDC key set and the
 * provider's Messages API (stub.cjs). The server's own Anthropic SDK is used
 * unchanged; ANTHROPIC_BASE_URL points it at the stub and the API key is a
 * generated string. An egress guard (egress.cjs) refuses every connection
 * outside loopback and the two stack hosts, proves itself on the provider's
 * real host at start-up, and any refusal fails the run.
 *
 * Per case the recording holds: the request(s); the response status, headers
 * and body bytes; every request the provider stub received (headers that carry
 * behaviour and the full JSON body: model, max_tokens, output_config, the
 * system prompt and the user prompt, multi-line strings split into
 * {"$lines": [...]} so a prompt change reads as a line diff, and joining the
 * lines with "\n" gives the exact bytes); the Delphi_CollectiveStatement rows
 * the case added or removed, exactly as stored (DynamoDB attribute-value
 * form); and the server's log lines (info and above) while the case ran.
 *
 * Determinism. The clock is pinned per case (fixture instant + one minute per
 * case index); Math.random is a seeded generator reseeded per case. What still
 * varies is named and replaced:
 *   - each random v4 uuid the server mints (the statement key's third part) is
 *     named after the case that first showed it: <uuid:CASE#n>, numbered in
 *     response order, then in stored-row order when a case stored a row the
 *     caller never saw (one at most);
 *   - absolute repository paths -> <repo>; stub and app ports -> <provider-stub>,
 *     <app>; stack frames in logged errors are cut ("<stack frames>"), so a
 *     line moving in a source file is not a behaviour change;
 *   - V8's wording "Cannot read properties of undefined (reading 'x')" ->
 *     <TypeError: read 'x' of undefined> (the engine's text, not the server's);
 *   - response headers date, connection, keep-alive and etag (a hash of the
 *     body, which holds a random uuid before naming) are not recorded.
 * Order exemptions (compared as sorted sets, each named on the case):
 *   - "statement-ties": in a GET list, rows that share one created_at come
 *     back in the index's tie order; those rows (only) are put in key order
 *     within the positions they occupy, so any other change of the served
 *     order still fails;
 *   - "provider" / "logs": two concurrent requests reach the stub and log in
 *     either order; sorted;
 *   - "uuids": the two statement keys two concurrent requests mint are
 *     interchangeable (equal created_at, so the GET's newest-per-layer_cluster
 *     pick between them follows the index's tie order); both are named
 *     <uuid:CASE#either> and the case notes how many distinct keys there were.
 * Stored rows are always sorted by key.
 *
 * Re-recording. The recordings are edge's behaviour. They may be re-recorded
 * only on origin/edge, in a PR that changes no server code (CI's
 * collective-statement-golden-guard job, ci/collective_statement_golden_guard.sh),
 * twice, with identical results:
 *
 *   node characterization/collective-statement/main.cjs record
 *   cp -R characterization/collective-statement/recordings /tmp/cs-1
 *   node characterization/collective-statement/main.cjs record
 *   diff -r /tmp/cs-1 characterization/collective-statement/recordings
 *
 * A PR that changes this behaviour on purpose does NOT re-record: it adds one
 * entry per changed case to expected-differences.json, spelling the change out
 * as literal find/replace text on the committed recording, with a ruling
 * (`pending` | `ruled:<who, when, where>` | `rejected`). The rules are in
 * expected.cjs (unit-tested by expected.test.cjs): one entry per case, `find`
 * occurs exactly once, no more unchanged context than needed, whole-recording
 * entries flagged with a reason. Only a `ruled:` entry lets its case pass. A
 * re-record on edge absorbs the entries and must empty the file (the guard
 * checks).
 *
 * Safety. Setup drops a Postgres database and every Delphi table, so the
 * harness refuses any store that is not its own throwaway one (safety.cjs,
 * unit-tested by safety.test.cjs): loopback on ports 5481/8481 only, a
 * Postgres with no other database, a DynamoDB that is empty or carries the
 * harness's sentinel table. The checks run before anything is dropped.
 */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const HERE = __dirname;
const SERVER = path.resolve(HERE, "../..");
const ROOT = path.resolve(SERVER, "..");
const RECORDINGS = path.join(HERE, "recordings");
const EXPECTED = path.join(HERE, "expected-differences.json");
const FORMAT = "collective-statement-recording/1";
const EXCLUDED_HEADERS = new Set(["date", "connection", "keep-alive", "etag"]);
const { applyExpectedDifferences } = require("./expected.cjs");
const safety = require("./safety.cjs");

const argv = process.argv.slice(2);
const mode = argv[0];
if (!["record", "replay"].includes(mode)) {
  console.error("usage: main.cjs record|replay [--failures <file>]");
  process.exit(2);
}
const failuresOut = argv.includes("--failures")
  ? path.resolve(argv[argv.indexOf("--failures") + 1])
  : null;
for (const k of ["CSREC_PG_ADMIN_URL", "DYNAMODB_ENDPOINT"])
  if (!process.env[k]) {
    console.error(`${k} is required`);
    process.exit(2);
  }

{
  const refused = safety.checkUrls(
    process.env.CSREC_PG_ADMIN_URL,
    process.env.DYNAMODB_ENDPOINT
  );
  if (refused.length) {
    console.error(
      `refusing to run: these are not the harness's throwaway stores\n  ${refused.join(
        "\n  "
      )}\nStart them with compose.yml (ports 5481 and 8481).`
    );
    process.exit(2);
  }
}
const pgAdmin = new URL(process.env.CSREC_PG_ADMIN_URL);
const pgApp = new URL(process.env.CSREC_PG_ADMIN_URL);
pgApp.pathname = "/csrec";
const dynamoUrl = new URL(process.env.DYNAMODB_ENDPOINT);
const PYTHON = process.env.CSREC_PYTHON || "python3";

// The guard goes in before anything that can open a socket.
const egress = require("./egress.cjs").install([
  pgAdmin.hostname,
  dynamoUrl.hostname,
]);

const F = require("./fixtures.cjs");
const { seedVote, databaseConvention } = require("../seed-vote.cjs");
const { definition, TABLES } = require("../delphi/tables.cjs");

const STATEMENTS = "Delphi_CollectiveStatement";

function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

// ------------------------------------------------------------------ Postgres

class SafetyRefusal extends Error {
  constructor(problems) {
    super(`refusing to run: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Refuse a DynamoDB store that is not this harness's; claim an empty one. */
async function claimDynamo(db) {
  const { claim, problems } = safety.checkDynamoTables(await db.tables());
  if (problems.length) throw new SafetyRefusal(problems);
  if (claim) await db.createSentinel();
}

async function setupPostgres() {
  const { Client } = require("pg");
  const admin = new Client({ connectionString: pgAdmin.toString() });
  await admin.connect();
  const dbs = (await admin.query("SELECT datname FROM pg_database")).rows.map(
    (r) => r.datname
  );
  const pgRefused = safety.checkPgDatabases(dbs);
  if (pgRefused.length) {
    await admin.end();
    throw new SafetyRefusal(pgRefused);
  }
  await admin.query("DROP DATABASE IF EXISTS csrec WITH (FORCE)");
  await admin.query("CREATE DATABASE csrec");
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
  await db.query(F.postgresSql());
  const agree = await databaseConvention(db);
  const rows = F.answers();
  for (const [zid, pid, tid, meaning, created] of rows)
    await db.query(
      "INSERT INTO votes(zid,pid,tid,vote,weight_x_32767,created) VALUES ($1,$2,$3,$4,0,$5)",
      [zid, pid, tid, seedVote(meaning, agree), created]
    );
  await db.end();
  return { migrations: files.length, answers: rows.length };
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
  const { marshall } = require("@aws-sdk/util-dynamodb");
  const client = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: "us-east-1",
    credentials: {
      accessKeyId: "generatedlocal",
      secretAccessKey: "generatedlocal",
    },
  });
  const api = {
    async tables() {
      const out = new Set();
      let start;
      do {
        const r = await client.send(
          new ListTablesCommand({ ExclusiveStartTableName: start })
        );
        (r.TableNames || []).forEach((t) => out.add(t));
        start = r.LastEvaluatedTableName;
      } while (start);
      return out;
    },
    async recreate(name) {
      if ((await api.tables()).has(name))
        await client.send(new DeleteTableCommand({ TableName: name }));
      await client.send(new CreateTableCommand(definition(name)));
    },
    async createSentinel() {
      await client.send(
        new CreateTableCommand({
          TableName: safety.SENTINEL,
          KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          BillingMode: "PAY_PER_REQUEST",
        })
      );
    },
    async drop(name) {
      await client.send(new DeleteTableCommand({ TableName: name }));
    },
    async writeRaw(table, items) {
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
    async write(table, plain) {
      await api.writeRaw(
        table,
        plain.map((p) => marshall(p))
      );
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
  return api;
}

async function setupDynamo(db) {
  for (const name of Object.keys(TABLES)) await db.recreate(name);
  await db.write(
    "Delphi_CommentHierarchicalClusterAssignments",
    F.assignments()
  );
  await db.write(STATEMENTS, F.storedStatements());
}

// -------------------------------------------------------------- credentials

function oidcSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "csrec-generated",
    alg: "RS256",
    use: "sig",
  };
  const b64 = (x) =>
    Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString(
      "base64url"
    );
  const sign = (claims) => {
    const head = b64({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const body = b64(claims);
    const sig = crypto
      .sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey)
      .toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

// ------------------------------------------------------------- normalization

const V4 =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

class Names {
  constructor() {
    this.uuids = new Map();
    this.fixed = [];
  }
  fix(value, symbol) {
    if (!value) return;
    this.fixed.push([String(value), symbol]);
    this.fixed.sort((a, b) => b[0].length - a[0].length);
  }
  /** Name every unseen v4 uuid in `text`, in order of appearance. */
  register(text, caseId, counter) {
    for (const u of String(text).match(V4) || [])
      if (!this.uuids.has(u))
        this.uuids.set(
          u,
          counter.either
            ? `<uuid:${caseId}#either>`
            : `<uuid:${caseId}#${++counter.n}>`
        );
  }
  unseen(text) {
    return [
      ...new Set(
        (String(text).match(V4) || []).filter((u) => !this.uuids.has(u))
      ),
    ];
  }
  text(s) {
    let out = String(s);
    for (const [v, sym] of this.fixed) out = out.split(v).join(sym);
    return (
      out
        .replace(V4, (u) => this.uuids.get(u) || "<uuid:unregistered>")
        // The engine's wording of a property read on undefined/null changes
        // between Node releases; the fact (a TypeError on that read) stays.
        .replace(
          /Cannot read properties of (undefined|null) \(reading '([^']*)'\)/g,
          "<TypeError: read '$2' of $1>"
        )
    );
  }
}

/** Multi-line strings become {"$lines": [...]} so a prompt diff is a line diff. */
function splitLines(x) {
  if (typeof x === "string" && x.includes("\n"))
    return { $lines: x.split("\n") };
  if (Array.isArray(x)) return x.map(splitLines);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x).map(([k, v]) => [k, splitLines(v)])
    );
  return x;
}

/**
 * The served order is kept, except that rows sharing one created_at (whose
 * relative order is the index's tie order) are put in key order within the
 * positions they occupy.
 */
function sortTies(rows) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const g = groups.get(r.created_at) || [];
    g.push(i);
    groups.set(r.created_at, g);
  });
  const out = [...rows];
  for (const positions of groups.values()) {
    if (positions.length < 2) continue;
    const members = positions
      .map((i) => rows[i])
      .sort((a, b) =>
        a.zid_topic_jobid < b.zid_topic_jobid
          ? -1
          : a.zid_topic_jobid > b.zid_topic_jobid
          ? 1
          : 0
      );
    positions.forEach((p, k) => (out[p] = members[k]));
  }
  return out;
}

function stripStack(message) {
  const s = String(message);
  const cut = s.replace(/\n\s+at [^\n]*/g, "");
  return cut === s ? s : `${cut} <stack frames>`;
}

function keyOf(item) {
  return item.zid_topic_jobid.S;
}

// ---------------------------------------------------------------------- main

async function main() {
  const db = dynamo();
  await claimDynamo(db); // before Postgres is touched, too
  const pg = await setupPostgres();
  await setupDynamo(db);
  const selfTest = await egress.selfTest();

  const signer = oidcSigner();
  // A second key under the same kid: its tokens fail signature verification.
  const rogue = oidcSigner();
  const stub = await require("./stub.cjs").start(signer.jwks);

  // Every setting that can reach a recorded byte is pinned here, whatever the
  // caller's environment says. The provider settings point the server's
  // unchanged SDK at the stub with a key that is not a credential.
  const PINNED_ENV = {
    NODE_ENV: "production",
    DEV_MODE: "true",
    TZ: "UTC",
    SERVER_LOG_LEVEL: "info",
    DATABASE_URL: pgApp.toString(),
    DATABASE_SSL: "false",
    DOMAIN_OVERRIDE: "localhost",
    SERVICE_URL: "http://localhost",
    EMBED_SERVICE_HOSTNAME: "localhost",
    STATIC_FILES_HOST: "localhost",
    STATIC_FILES_PORT: "8080",
    MATH_ENV: "csrec",
    AUTH_ISSUER: "https://oidc.csrec.invalid/",
    AUTH_AUDIENCE: "users",
    AUTH_NAMESPACE: "https://pol.is/",
    JWKS_URI: `http://127.0.0.1:${stub.port}/.well-known/jwks.json`,
    POLIS_JWT_ISSUER: "https://pol.is/",
    POLIS_JWT_AUDIENCE: "participants",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "generatedlocal",
    AWS_SECRET_ACCESS_KEY: "generatedlocal",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_S3_ENDPOINT: "http://127.0.0.1:9",
    AWS_S3_BUCKET_NAME: "polis-delphi",
    AWS_ENDPOINT_URL_SQS: "http://127.0.0.1:9",
    SES_ENDPOINT: "http://127.0.0.1:9",
    POLIS_FROM_ADDRESS: "sender@example.invalid",
    SHOULD_USE_TRANSLATION_API: "false",
    ADMIN_UIDS: "[2]",
    WEBSERVER_USERNAME: "generated-worker",
    WEBSERVER_PASS: "generated-worker",
    ANTHROPIC_API_KEY: require("./stub.cjs").GENERATED_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_LOG: "off",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
  };
  Object.assign(process.env, PINNED_ENV);
  process.chdir(SERVER);
  require("ts-node/register/transpile-only");

  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  process.env.JWT_PRIVATE_KEY = pair.privateKey;
  process.env.JWT_PUBLIC_KEY = pair.publicKey;

  // The clock: pinned, and moved to a fixed instant before each case.
  const NativeDate = global.Date;
  let clockMs = F.CLOCK_MS;
  class FixtureDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [clockMs]));
    }
    static now() {
      return clockMs;
    }
  }
  global.Date = FixtureDate;
  let rng = 0;
  Math.random = () => {
    rng = (rng + 0x6d2b79f5) | 0;
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const reseed = (id) => {
    rng = crypto.createHash("sha256").update(id).digest().readInt32BE(0);
  };

  const { default: app, appReady } = require(path.join(SERVER, "app.ts"));
  await appReady;
  await require(path.join(SERVER, "src/utils/moderation.ts")).moderationReady;

  // Log capture: every server log line at info and above, per case. The
  // console transport is silenced so the run's own output stays readable.
  const logger = require(path.join(SERVER, "src/utils/logger.ts")).default;
  const Transport = require("winston-transport");
  let logSink = null;
  class Capture extends Transport {
    log(info, done) {
      if (logSink) {
        const meta = {};
        for (const [k, v] of Object.entries(info))
          if (
            !["level", "message", "service", "timestamp", "stack"].includes(k)
          )
            meta[k] = v;
        logSink.push(
          `${info.level}: ${stripStack(info.message)}` +
            (Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "")
        );
      }
      done();
    }
  }
  logger.transports.forEach((t) => (t.silent = true));
  logger.add(new Capture({ level: "info" }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const appPort = server.address().port;

  const names = new Names();
  names.fix(ROOT, "<repo>");
  names.fix(`127.0.0.1:${stub.port}`, "<provider-stub>");
  names.fix(`127.0.0.1:${appPort}`, "<app>");

  const tokenFor = (auth) => {
    const now = Math.floor(clockMs / 1000);
    const oidc = (who, claim, { key = signer, age = 60, life = 3660 } = {}) =>
      key.sign({
        iss: PINNED_ENV.AUTH_ISSUER,
        aud: PINNED_ENV.AUTH_AUDIENCE,
        sub: F.OIDC[who],
        email: `${who}@example.invalid`,
        iat: now - age,
        exp: now - age + life,
        ...(claim === undefined
          ? {}
          : { [`${PINNED_ENV.AUTH_NAMESPACE}delphi_enabled`]: claim }),
      });
    switch (auth) {
      case "none":
        return null;
      case "owner":
        return oidc("owner", true);
      case "other":
        return oidc("other", true);
      case "plain":
        return oidc("plain", undefined);
      case "flaggedOff":
        return oidc("flaggedOff", false);
      case "ownerExpired":
        return oidc("owner", true, { age: 7200, life: 3600 });
      case "ownerBadSignature":
        return oidc("owner", true, { key: rogue });
      case "xid": {
        const { issueXidJWT } = require(path.join(
          SERVER,
          "src/auth/xid-jwt.ts"
        ));
        return issueXidJWT("csrec-xid-1", `csrec${F.ZID.main}`, 11, 2);
      }
      case "standardUser": {
        const { issueStandardUserJWT } = require(path.join(
          SERVER,
          "src/auth/standard-user-jwt.ts"
        ));
        return issueStandardUserJWT(
          F.OIDC.plain,
          `csrec${F.ZID.main}`,
          F.UID.plain,
          3
        );
      }
      case "participant": {
        const { issueAnonymousJWT } = require(path.join(
          SERVER,
          "src/auth/anonymous-jwt.ts"
        ));
        return issueAnonymousJWT(`csrec${F.ZID.main}`, 10, 1);
      }
      default:
        throw new Error(`unknown auth ${auth}`);
    }
  };

  function send(method, p, auth, body) {
    let req;
    let answered = false;
    let closed = false;
    const promise = new Promise((resolve, reject) => {
      const token = tokenFor(auth);
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      req = http.request(
        {
          host: "127.0.0.1",
          port: appPort,
          path: p,
          method,
          agent: false,
          headers,
        },
        (res) => {
          answered = true;
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            closed = true;
            const h = [];
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              const name = res.rawHeaders[i].toLowerCase();
              if (!EXCLUDED_HEADERS.has(name))
                h.push([name, res.rawHeaders[i + 1]]);
            }
            resolve({
              status: res.statusCode,
              headers: h,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", reject);
        }
      );
      req.setTimeout(60000, () => req.destroy(new Error(`timeout on ${p}`)));
      req.on("error", (e) => {
        closed = true;
        if (e.code === "CALLER_ABORT") resolve({ aborted: true });
        else reject(e);
      });
      req.on("close", () => (closed = true));
      if (payload) req.write(payload);
      req.end();
    });
    return {
      promise,
      answered: () => answered,
      closed: () => closed,
      abort: () =>
        req.destroy(
          Object.assign(new Error("caller gave up"), { code: "CALLER_ABORT" })
        ),
    };
  }

  async function poll(what, test, { orElse = false, deadlineMs = 15000 } = {}) {
    const deadline = NativeDate.now() + deadlineMs;
    for (;;) {
      if (await test()) return true;
      if (NativeDate.now() > deadline) {
        if (orElse) return false;
        throw new Error(`polled ${deadlineMs} ms for: ${what}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  let snapshot = null;
  const runResetStep = (zid) => {
    const r = spawnSync(
      PYTHON,
      [path.join(HERE, "reset_step.py"), String(zid)],
      {
        env: {
          PATH: process.env.PATH,
          DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "generatedlocal",
          AWS_SECRET_ACCESS_KEY: "generatedlocal",
          AWS_EC2_METADATA_DISABLED: "true",
        },
        encoding: "utf8",
      }
    );
    if (r.status !== 0)
      throw new Error(
        `reset step failed (${r.status}): ${r.stderr.slice(-2000)}`
      );
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };

  const expectedEntries = JSON.parse(fs.readFileSync(EXPECTED, "utf8")).entries;

  // The server's load-time outbound attempts (the spam filter's key check)
  // were refused above; they are listed in the index, and any refusal from
  // here on, during the cases, fails the run.
  const refusedAtServerLoad = egress.refused.splice(0);

  const { allCases } = require("./cases.cjs");
  const cases = allCases();
  // The committed recordings, and what each case must serve: the recording
  // with its expected difference (if any) applied.
  const committed = {};
  if (mode === "replay")
    for (const c of cases) {
      const f = path.join(RECORDINGS, `${c.id}.json`);
      if (fs.existsSync(f)) committed[c.id] = fs.readFileSync(f, "utf8");
    }
  const ed = applyExpectedDifferences(
    committed,
    mode === "replay" ? expectedEntries : []
  );
  const index = {
    format: FORMAT,
    clock: `${F.CLOCK_MS} + 60000 * case index`,
    randomSeed: "mulberry32(sha256(case id)[0..4]) per case",
    pinnedEnv: Object.keys(PINNED_ENV).sort(),
    egress: {
      selfTest,
      allowedHosts: "loopback + the Postgres and DynamoDB hosts",
      refusedAtServerLoad,
    },
    postgres: pg,
    caseCount: cases.length,
    cases: [],
  };
  const failures = [];
  const failedIds = new Set();
  const notes = [];
  for (const p of ed.problems) {
    failures.push(`expected differences: ${p}`);
    const id = p.split(": ")[0];
    if (cases.some((c) => c.id === id)) failedIds.add(id);
  }
  let providerRecorded = 0;
  const providerTotalBefore = stub.state.total;

  for (const [i, c] of cases.entries()) {
    clockMs = F.CLOCK_MS + 60000 * (i + 1);
    reseed(c.id);
    const rec = {
      format: FORMAT,
      case: c.id,
      about: c.about,
      requests: [],
      responses: [],
      notes: {},
    };
    const ctx = {
      stub,
      arm: (script) => stub.arm(script),
      poll,
      note: (k, v) => (rec.notes[k] = v),
      storedCount: async () => (await db.scan(STATEMENTS)).length,
      dropTable: async (name) => {
        snapshot = { name, rows: await db.scan(name) };
        await db.drop(name);
      },
      restoreTable: async () => {
        await db.recreate(snapshot.name);
        await db.writeRaw(snapshot.name, snapshot.rows);
        snapshot = null;
      },
      runReset: (zid) => runResetStep(zid),
      postAsync(body, auth) {
        const at = rec.requests.length;
        rec.requests.push({
          method: "POST",
          path: "/api/v3/collectiveStatement",
          auth,
          body,
        });
        rec.responses.push(null);
        const s = send("POST", "/api/v3/collectiveStatement", auth, body);
        return s.promise.then((r) => (rec.responses[at] = r));
      },
      post(body, auth) {
        return ctx.postAsync(body, auth);
      },
      postAbortable(body, auth) {
        const at = rec.requests.length;
        rec.requests.push({
          method: "POST",
          path: "/api/v3/collectiveStatement",
          auth,
          body,
        });
        rec.responses.push(null);
        const s = send("POST", "/api/v3/collectiveStatement", auth, body);
        s.promise.then((r) => (rec.responses[at] = r));
        return s;
      },
      async get(p, auth) {
        const at = rec.requests.length;
        rec.requests.push({ method: "GET", path: p, auth });
        rec.responses.push(null);
        rec.responses[at] = await send("GET", p, auth).promise;
      },
    };

    const before = new Map(
      (await db.scan(STATEMENTS)).map((x) => [keyOf(x), x])
    );
    if (c.before) await c.before(ctx);
    const logs = [];
    logSink = logs;
    await c.run(ctx);
    logSink = null;
    if (c.after) await c.after(ctx);
    const after = new Map(
      (await db.scan(STATEMENTS)).map((x) => [keyOf(x), x])
    );
    const added = [...after].filter(([k]) => !before.has(k)).map(([, v]) => v);
    const removed = [...before]
      .filter(([k]) => !after.has(k))
      .map(([, v]) => v);
    const changed = [...after]
      .filter(
        ([k, v]) =>
          before.has(k) && JSON.stringify(before.get(k)) !== JSON.stringify(v)
      )
      .map(([, v]) => v);

    rec.provider = stub.state.calls.map((call) => splitLines(call));
    rec.unusedProviderReplies = stub.leftover();
    stub.arm([]);
    providerRecorded += rec.provider.length;
    rec.stored = { added, removed, changed };
    rec.logs = logs;
    if (!Object.keys(rec.notes).length) delete rec.notes;

    // Name the uuids this case minted: responses first, then stored rows.
    const counter = { n: 0, either: (c.unordered || []).includes("uuids") };
    for (const r of rec.responses)
      if (r && r.body) names.register(r.body, c.id, counter);
    const unseenStored = names.unseen(JSON.stringify(added));
    if (unseenStored.length > 1 && !counter.either)
      throw new Error(
        `${c.id}: ${unseenStored.length} stored keys no response showed; cannot name them in a stable order`
      );
    names.register(JSON.stringify(added), c.id, counter);
    if (counter.either)
      rec.notes = {
        ...(rec.notes || {}),
        "distinct statement keys minted": new Set(
          JSON.stringify(rec).match(V4) || []
        ).size,
      };

    // Order exemptions, applied after naming.
    const unordered = new Set(c.unordered || []);
    let text = names.text(JSON.stringify(rec));
    const n = JSON.parse(text);
    for (const r of n.responses) {
      if (!r || !r.body || !unordered.has("statement-ties")) continue;
      const parsed = JSON.parse(r.body);
      if (JSON.stringify(parsed) !== r.body)
        throw new Error(`${c.id}: not compact JSON, cannot reorder exactly`);
      if (Array.isArray(parsed.statements))
        parsed.statements = sortTies(parsed.statements);
      r.body = JSON.stringify(parsed);
    }
    const byText = (a, b) => {
      const x = JSON.stringify(a);
      const y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    if (unordered.has("provider")) n.provider.sort(byText);
    if (unordered.has("logs")) n.logs.sort(byText);
    for (const k of ["added", "removed", "changed"])
      n.stored[k].sort((a, b) =>
        byText(a.zid_topic_jobid.S, b.zid_topic_jobid.S)
      );
    if (c.unordered) n.orderExemptions = [...c.unordered];
    text = JSON.stringify(n, null, 1) + "\n";

    const file = path.join(RECORDINGS, `${c.id}.json`);
    const digest = sha256(text);
    index.cases.push({ id: c.id, sha256: digest });
    const fail = (why) => {
      failures.push(`${c.id}: ${why}`);
      failedIds.add(c.id);
    };
    if (mode === "record") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    } else if (!(c.id in committed)) fail("no recording");
    else {
      const want = ed.expected[c.id];
      const ruling = ed.rulings[c.id];
      if (text !== want)
        fail(
          ruling
            ? `differs from the recording with its expected difference applied (${ruling}): ${firstDifference(
                text,
                want
              )}`
            : firstDifference(text, want)
        );
      else if (ruling)
        notes.push(`${c.id}: expected difference applied (${ruling})`);
    }
  }

  // Egress proof: nothing left loopback and the stack; the stub saw exactly
  // the provider requests the recordings hold.
  index.egress.refusedDuringCases = egress.refused;
  index.egress.providerStubRequests = stub.state.total - providerTotalBefore;
  index.egress.providerRequestsRecorded = providerRecorded;
  if (egress.refused.length)
    failures.push(
      `egress outside the stack was attempted during the cases: ${egress.refused.join(
        ", "
      )}`
    );
  if (index.egress.providerStubRequests !== providerRecorded)
    failures.push("the provider stub saw requests no case recorded");

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
    const recordedIndex = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    const strip = (x) => ({ ...x, cases: x.cases.map((c) => c.id) });
    if (JSON.stringify(strip(recordedIndex)) !== JSON.stringify(strip(index)))
      failures.push(
        "index.json differs (case list, pins, egress or fixture counts changed)"
      );
  }
  server.close();
  stub.server.close();
  console.log(
    `${mode}: ${cases.length} cases; provider requests ${providerRecorded}; egress refused ${egress.refused.length}`
  );
  for (const n of notes) console.log(`  ${n}`);
  if (failuresOut)
    fs.writeFileSync(
      failuresOut,
      JSON.stringify([...failedIds].sort(), null, 1) + "\n"
    );
  if (failures.length) {
    console.error(`${failures.length} difference(s):`);
    for (const f of failures.slice(0, 80)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    mode === "record"
      ? "recorded"
      : notes.length
      ? `replay matches every recording byte for byte, except ${notes.length} case(s) through ruled expected differences`
      : "replay matches every recording byte for byte"
  );
  process.exit(0);
}

function firstDifference(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i])
      return `line ${i + 1}: recorded ${JSON.stringify(
        (y[i] || "").slice(0, 160)
      )} served ${JSON.stringify((x[i] || "").slice(0, 160))}`;
  return "differs";
}

main().catch((err) => {
  if (err instanceof SafetyRefusal) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
