"use strict";
// The server leg of the two-convention gate (P-078 PR-F).
//
//   node ci/vote_convention/server_leg.cjs --database gate_v0 --out OUT/v0
//
// Boots the real Express app (server/app.ts, through ts-node exactly as the
// characterization harness's entry.cjs does) against one provisioned gate
// database, then records as bytes:
//   pca2/   the 336 characterization requests of server/characterization/
//           pca2-cases.cjs, each sent with its own query, headers and body. The
//           credential placeholder is dropped: route r5 has no auth middleware,
//           so the actor label selects nothing on this route.
//   export/ the CSV exports of server/src/routes/export.ts (summary, comments,
//           votes, participant-votes, participant-importance, comment-groups)
//           for every gate conversation, written by the same report functions.
// No cloud endpoint is reachable: every service URL points at a closed local port.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const SERVER = path.join(ROOT, "server");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw Error(`--${name} is required`);
  return process.argv[i + 1];
}
const database = arg("database");
const out = path.resolve(arg("out"));
const host = process.env.VOTE_GATE_PG_HOST || "127.0.0.1";
const port = process.env.VOTE_GATE_PG_PORT || "5470";
const password = process.env.VOTE_GATE_PG_PASSWORD || "gate";
const closed = "http://127.0.0.1:9";
const pair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.TZ = "UTC"; // export datetimes are rendered in the process zone
Object.assign(process.env, {
  DEV_MODE: "true",
  NODE_ENV: "production",
  SERVER_LOG_LEVEL: "error",
  DATABASE_URL: `postgres://postgres:${password}@${host}:${port}/${database}`,
  READ_ONLY_DATABASE_URL: `postgres://postgres:${password}@${host}:${port}/${database}`,
  DATABASE_SSL: "false",
  DOMAIN_OVERRIDE: "localhost",
  SERVICE_URL: "http://localhost",
  EMBED_SERVICE_HOSTNAME: "localhost",
  STATIC_FILES_HOST: "127.0.0.1",
  STATIC_FILES_PORT: "9",
  MATH_ENV: "p027",
  AUTH_ISSUER: "https://127.0.0.1:9/",
  AUTH_AUDIENCE: "users",
  AUTH_NAMESPACE: "https://pol.is/",
  JWKS_URI: "https://127.0.0.1:9/.well-known/jwks.json",
  POLIS_JWT_ISSUER: "https://pol.is/",
  POLIS_JWT_AUDIENCE: "participants",
  JWT_PRIVATE_KEY: pair.privateKey,
  JWT_PUBLIC_KEY: pair.publicKey,
  DYNAMODB_ENDPOINT: closed,
  AWS_ENDPOINT_URL: closed,
  AWS_ENDPOINT_URL_SQS: closed,
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "generatedlocal",
  AWS_SECRET_ACCESS_KEY: "generatedlocal",
  AWS_EC2_METADATA_DISABLED: "true",
  SES_ENDPOINT: closed,
  POLIS_FROM_ADDRESS: "sender@example.invalid",
  SHOULD_USE_TRANSLATION_API: "false",
  ADMIN_UIDS: "[2]",
  WEBSERVER_USERNAME: "generated-worker",
  WEBSERVER_PASS: "generated-worker",
  TOPICAL_COMMENT_RATIO: "0",
});

function write(rel, bytes) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function request(base, c) {
  const url = new URL(c.request.path, base);
  for (const [k, v] of Object.entries(c.request.query)) url.searchParams.set(k, v);
  const headers = { ...c.request.headers };
  delete headers.authorization;
  const body = c.request.body === null ? null : Buffer.from(JSON.stringify(c.request.body));
  if (body) headers["content-length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: c.request.method, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: Object.fromEntries(
            ["content-type", "content-encoding", "etag", "content-length", "vary"]
              .filter((h) => res.headers[h] !== undefined)
              .map((h) => [h, res.headers[h]])
          ),
          body: Buffer.concat(chunks),
        })
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function fakeResponse() {
  const parts = [];
  let status = 200;
  const headers = {};
  let done;
  const finished = new Promise((r) => (done = r));
  const res = {
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    set: (o) => Object.entries(o).forEach(([k, v]) => (headers[k.toLowerCase()] = v)),
    status(code) {
      status = code;
      return res;
    },
    json(o) {
      parts.push(JSON.stringify(o));
      done();
    },
    send(d) {
      parts.push(String(d));
      done();
    },
    write: (d) => parts.push(String(d)),
    end() {
      done();
    },
  };
  return { res, finished, result: () => ({ status, headers, body: parts.join("") }) };
}

async function main() {
  process.chdir(SERVER);
  // The characterization harness's fixture clock: the empty-math fallback of
  // server/src/utils/pca.ts stamps Date.now(), which must not differ by run.
  require(path.join(SERVER, "characterization/clock.cjs")).install();
  require(path.join(SERVER, "node_modules/ts-node")).register({
    transpileOnly: true,
    project: path.join(SERVER, "tsconfig.json"),
  });
  const { default: app, appReady } = require(path.join(SERVER, "app.ts"));
  await appReady;
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((r) => listener.once("listening", r));
  const base = `http://127.0.0.1:${listener.address().port}`;

  const cases = require(path.join(SERVER, "characterization/pca2-cases.cjs")).pca2Cases();
  const index = [];
  for (const c of cases) {
    const r = await request(base, c);
    const name = `pca2/${c.caseId.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
    write(`${name}.head.json`, JSON.stringify({ caseId: c.caseId, status: r.status, headers: r.headers }, null, 1) + "\n");
    write(`${name}.body`, r.body);
    index.push(c.caseId);
  }

  const report = require(path.join(SERVER, "src/report.ts"));
  const pg = require(path.join(SERVER, "src/db/pg-query.ts")).default;
  const zids = (await pg.queryP_readOnly("SELECT zid FROM conversations WHERE zid > 1 ORDER BY zid", [])).map((r) => r.zid);
  const exports = {
    "summary.csv": (zid, res) => report.sendConversationSummary(zid, "https://localhost", res),
    "comments.csv": report.sendCommentSummary,
    "votes.csv": report.sendVotesSummary,
    "participant-votes.csv": report.sendParticipantVotesSummary,
    "participant-importance.csv": report.sendParticipantImportance,
    "comment-groups.csv": report.sendCommentGroupsSummary,
  };
  let written = 0;
  let failures = 0;
  for (const zid of zids) {
    for (const [name, send] of Object.entries(exports)) {
      const f = fakeResponse();
      let r;
      try {
        await send(zid, f.res);
        await f.finished;
        r = f.result();
      } catch (err) {
        // Recorded, not fatal: the same failure must occur at both conventions.
        r = { status: "error", body: String(err && err.message) };
        failures += 1;
      }
      write(`export/${String(zid).padStart(5, "0")}.${name}`, `status ${r.status}\n${r.body}`);
      written += 1;
    }
  }
  write("_meta/server-leg.json", JSON.stringify({ database, pca2Cases: index.length, exports: written, exportFailures: failures }, null, 1) + "\n");
  console.log(JSON.stringify({ database, pca2Cases: index.length, exports: written, exportFailures: failures }));
  listener.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
