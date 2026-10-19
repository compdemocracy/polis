"use strict";
// The run-record route's raw answers on a stack holding real local runs
// (delphi-run-run.sh). Node has no handler for this path, so there is no
// Node answer to compare with: each answer is recorded byte for byte and
// checked against its expected status and body, and every served record is
// checked field by field against pd_run_record's own output for the job.
//
//   node delphi-run-replay.cjs keys <artifacts>    write the OIDC signing key
//                                                  and the JWKS polis-api reads
//   node delphi-run-replay.cjs replay <artifacts>  (DELPHI_RUN_API=host:port)
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ISSUER = "https://oidc.invalid/";
const AUDIENCE = "users";
const KID = "replay";
// delphi-run/1's legacy families: no new run produces one.
const LEGACY = new Set(["Delphi_PCAConversationConfig", "Delphi_PCAResults", "Delphi_KMeansClusters",
  "Delphi_CommentRouting", "Delphi_RepresentativeComments", "Delphi_PCAParticipantProjections",
  "Delphi_CommentExtremity", "Delphi_TopicAgendaSelections", "report_narrative_store"]);

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function keys(dir) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  fs.writeFileSync(path.join(dir, "read-jwks.json"), JSON.stringify({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: KID }] }));
  fs.writeFileSync(path.join(dir, "oidc-private.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
}

function token(dir, claims) {
  const key = fs.readFileSync(path.join(dir, "oidc-private.pem"));
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, ...claims };
  const signing = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }))}.${b64url(JSON.stringify(body))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signing), key).toString("base64url");
  return `Bearer ${signing}.${signature}`;
}

function exchange(target, bytes, headOnly) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("response deadline")), 10000);
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (b) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      const end = complete(all, headOnly);
      if (end !== null) finish(null, all.subarray(0, end));
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (e) => finish(e));
  });
}

// Offset just past one complete response in `buf`, or null if more is needed.
function complete(buf, headOnly) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString("latin1");
  const status = Number(head.split(" ")[1]);
  const length = /\r\ncontent-length: *(\d+)/i.exec(head);
  const at = headEnd + 4;
  if (headOnly || status === 204 || status === 304) return at;
  if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
    let i = at;
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", i);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(i, lineEnd).toString("latin1"), 16);
      i = lineEnd + 2 + size + 2;
      if (i > buf.length) return null;
      if (size === 0) return i;
    }
  }
  if (length) return at + Number(length[1]) <= buf.length ? at + Number(length[1]) : null;
  return null;
}

function split(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, headEnd).toString("latin1").split("\r\n");
  return { status: Number(head[0].split(" ")[1]), head, body: buf.subarray(headEnd + 4) };
}

function header(head, name) {
  const line = head.find((l) => l.toLowerCase().startsWith(name + ":"));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
}

// Each served record against the function's own document for the same job.
function agrees(record, raw, zinvite) {
  const problems = [];
  const same = (what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  same("contract_version", record.contract_version, "delphi-run/1");
  same("job_id", record.job_id, raw.job_id);
  same("run_id", record.run_id, raw.run_id);
  same("conversation_id", record.conversation_id, zinvite);
  same("report_id", record.report_id, raw.report_id);
  same("kind", record.kind, raw.kind);
  same("stage", record.stage, raw.stage);
  same("state", record.state, raw.state);
  same("pinned", record.pinned, raw.pinned);
  same("created_at", record.created_at, raw.created_at);
  same("completed_at", record.completed_at, raw.completed_at);
  same("config_effective", record.config_effective, raw.config_effective);
  same("code_version", record.code_version, raw.code_version);
  same("manifest_sha256", record.outputs.manifest_sha256, raw.manifest_sha256);
  same("attempt.attempt_id", record.attempt && record.attempt.attempt_id, raw.attempt && raw.attempt.attempt_id);
  same("attempt.started_at", record.attempt && record.attempt.started_at, raw.attempt && raw.attempt.started_at);
  same("attempt.ended_at", record.attempt && record.attempt.ended_at, raw.attempt && raw.attempt.ended_at);
  same("attempt.max_attempts", record.attempt && record.attempt.max_attempts, raw.max_attempts);
  same("inputs.vote_hwm", record.inputs && record.inputs.vote_hwm, raw.manifest && raw.manifest.inputs.vote_hwm);
  same("models.embedding", record.models.embedding, raw.manifest ? raw.manifest.models.embed : null);
  // A queued run's empty copy of a retired math family is the one omission.
  const listed = raw.families.filter((f) => !(f.row_count === 0 && f.origin === "queued" && LEGACY.has(f.family)));
  same("families", record.outputs.families.map((f) => f.family).sort(), listed.map((f) => f.family).sort());
  for (const f of listed) {
    const r = record.outputs.families.find((x) => x.family === f.family);
    if (!r) continue;
    same(`${f.family}.state`, r.state, f.served ? "succeeded" : "superseded");
    same(`${f.family}.batch`, r.batch, { batch_id: f.batch_id, content_sha256: f.content_sha256, row_count: f.row_count });
    same(`${f.family}.publication`, r.publication, { scope: f.scope, generation: f.generation });
    same(`${f.family}.producer`, r.producer, { job_id: f.job_id, run_id: f.run_id });
    for (const u of r.upstream) same(`${f.family}.upstream.${u.family}`, { job_id: u.job_id, run_id: u.run_id }, raw.bundles[f.artifact_id][u.family]);
  }
  return problems;
}

async function replay(dir) {
  const [host, port] = (process.env.DELPHI_RUN_API || "").split(":");
  const target = { host, port: Number(port) };
  const jobs = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
  const raw = (job) => JSON.parse(fs.readFileSync(path.join(dir, `record-${job}.json`), "utf8"));
  const owner = token(dir, { sub: "replay-owner", email: "owner@example.invalid" });
  const participant = token(dir, { sub: "replay-participant", email: "participant@example.invalid" });
  const administrator = token(dir, { sub: "replay-administrator", email: "administrator@example.invalid" });
  const unmapped = token(dir, { sub: "replay-unmapped", email: "unmapped@example.invalid" });
  const expired = token(dir, { sub: "replay-owner", email: "owner@example.invalid", exp: Math.floor(Date.now() / 1000) - 60 });
  const run = (job) => `/api/v3/delphi/run?job_id=${job}`;
  const unauthenticated = '{"error":"No authentication token found"}';
  const cases = [];
  for (const [name, job] of Object.entries(jobs)) {
    cases.push({ id: `moderator-${name}`, target: run(job), auth: owner, status: 200, record: job });
    cases.push({ id: `moderator-head-${name}`, method: "HEAD", target: run(job), auth: owner, status: 200 });
    cases.push({ id: `administrator-${name}`, target: run(job), auth: administrator, status: 200, record: job });
    cases.push({ id: `participant-${name}`, target: run(job), auth: participant, status: 403, body: '{"status":"error","message":"polis_err_delphi_run_auth"}' });
    cases.push({ id: `anonymous-${name}`, target: run(job), status: 401, body: unauthenticated });
  }
  cases.push(
    { id: "anonymous-without-job", target: "/api/v3/delphi/run", status: 401, body: unauthenticated },
    { id: "basic-scheme", target: run(jobs.first), auth: "Basic cmVwbGF5OnJlcGxheQ==", status: 401, body: unauthenticated },
    { id: "missing-job", target: "/api/v3/delphi/run", auth: owner, status: 400, body: '{"status":"error","message":"job_id is required"}' },
    { id: "empty-job", target: "/api/v3/delphi/run?job_id=", auth: owner, status: 400, body: '{"status":"error","message":"job_id is required"}' },
    { id: "not-a-uuid", target: "/api/v3/delphi/run?job_id=not-a-job", auth: owner, status: 404, body: '{"status":"error","message":"Job not found"}' },
    { id: "uppercase-uuid", target: run(jobs.first.toUpperCase()), auth: owner, status: 404, body: '{"status":"error","message":"Job not found"}' },
    { id: "unknown-job", target: run("00000000-0000-4000-8000-000000000000"), auth: owner, status: 404, body: '{"status":"error","message":"Job not found"}' },
    // Hand-backs: nginx gives these to Node, which has no handler (404).
    { id: "unmapped-subject", target: run(jobs.first), auth: unmapped, status: 502 },
    { id: "expired-token", target: run(jobs.first), auth: expired, status: 502 },
    { id: "unsigned-token", target: run(jobs.first), auth: "Bearer e30.e30.", status: 502 },
    { id: "extra-parameter", target: `${run(jobs.first)}&report_id=rlocaldynamo1424`, auth: owner, status: 502 },
    { id: "repeated-job", target: `${run(jobs.first)}&job_id=${jobs.first}`, auth: owner, status: 502 },
    { id: "post", method: "POST", target: run(jobs.first), auth: owner, status: 502 },
    { id: "body", target: run(jobs.first), auth: owner, extra: [["Content-Length", "2"]], payload: "{}", status: 502 },
  );
  const results = [];
  let failures = 0;
  for (const c of cases) {
    const headers = [["Host", "localhost"]];
    if (c.auth) headers.push(["Authorization", c.auth]);
    for (const h of c.extra || []) headers.push(h);
    let text = `${c.method || "GET"} ${c.target} HTTP/1.1\r\n`;
    for (const [k, v] of headers) text += `${k}: ${v}\r\n`;
    const bytes = Buffer.concat([Buffer.from(text + "\r\n", "latin1"), Buffer.from(c.payload || "", "latin1")]);
    const answer = await exchange(target, bytes, c.method === "HEAD");
    const { status, head, body } = split(answer);
    const problems = [];
    if (status !== c.status) problems.push(`status ${status}, expected ${c.status}`);
    if (c.body !== undefined && body.toString("utf8") !== c.body) problems.push(`body ${body.toString("utf8")}`);
    if (status !== 502 && header(head, "content-type") !== "application/json; charset=utf-8") problems.push(`content-type ${header(head, "content-type")}`);
    if (c.method === "HEAD" && body.length !== 0) problems.push("HEAD has a body");
    if (c.record) {
      const document = raw(c.record);
      problems.push(...agrees(JSON.parse(body.toString("utf8")), document, "local-dynamo-1424"));
      if (Number(header(head, "content-length")) !== body.length) problems.push("content-length");
      fs.writeFileSync(path.join(dir, `served-${c.record}.json`), body);
    }
    failures += problems.length ? 1 : 0;
    results.push({ id: c.id, method: c.method || "GET", target: c.target, status, ok: problems.length === 0, problems, bytes: answer.toString("base64") });
  }
  const health = await (await fetch(`http://${process.env.DELPHI_RUN_API}/health`)).json();
  const served = results.filter((r) => r.status !== 502).length;
  const handedBack = results.length - served;
  if (health.delphiRunServed !== served || health.delphiRunFallback !== handedBack) {
    failures++;
    results.push({ id: "health-counters", ok: false, problems: [`served ${health.delphiRunServed} vs ${served}, fallback ${health.delphiRunFallback} vs ${handedBack}`] });
  }
  process.stdout.write(JSON.stringify({ jobs, cases: results.length, failures, served, handedBack, results }, null, 2) + "\n");
  if (failures) process.exit(1);
}

const [mode, dir] = process.argv.slice(2);
if (mode === "keys") keys(dir);
else if (mode === "replay") replay(dir).catch((e) => { console.error(e); process.exit(1); });
else { console.error("usage: delphi-run-replay.cjs keys|replay <artifacts>"); process.exit(2); }
