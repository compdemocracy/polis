"use strict";
// P-025 is the sole persisted record schema. comparison.json is an explicitly
// named normalized projection, pinned alongside transport evidence, never a record.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const digest = (x) => crypto.createHash("sha256").update(x).digest("hex");
const json = (x) => JSON.stringify(x, null, 2) + "\n";
const schema = require("./P-025-recording.schema.json");
const Ajv = require("ajv");
const check = new Ajv({ allErrors: true, strict: false }).compile(schema);
function validate(x) {
  if (!check(x)) throw Error("P-025 schema: " + JSON.stringify(check.errors));
  return x;
}
const record = (kind, x) =>
  validate({ kind, schema_version: "polis-api-recording/1", ...x });
function blob(x) {
  const b = Buffer.isBuffer(x)
    ? x
    : Buffer.from(typeof x === "string" ? x : JSON.stringify(x));
  return {
    base64: b.toString("base64"),
    byte_length: b.length,
    sha256: digest(b),
  };
}
function pin(dir, file) {
  const b = fs.readFileSync(path.join(dir, file));
  return { path: file, byte_length: b.length, sha256: digest(b) };
}
function put(dir, file, x) {
  fs.writeFileSync(path.join(dir, file), typeof x === "string" ? x : json(x));
  return pin(dir, file);
}
function expected(c) {
  return {
    completed_responses: Number(c.response.completed),
    process_errors: c.process.length,
    participants_created: c.effects.participantCreated,
    jwts_issued: c.effects.jwtIssued,
    external_attempts: c.effects.outbound.length,
  };
}
function records(c) {
  const request_id = c.caseId;
  const request = record("request", {
    request_id,
    actor_ref: c.auth,
    auth_fixture_ref: c.auth === "unauthenticated" ? null : c.auth,
    sequence: 0,
    ...c.wire.request,
  });
  const response = record("response", {
    request_id,
    ...c.wire.response,
    normalizations: [
      "p027/3:verified credential-value symbols; lexical capability wire comparison; decoded-json/gzip semantic projection; timing bounds",
    ],
  });
  const effects = [];
  function effect(effect_type, identity, operation, before, after) {
    effects.push(
      record("effect", {
        sequence: effects.length,
        request_id,
        barrier: "request-effects-drained",
        effect_type,
        identity,
        operation,
        field_policy_refs: ["generated-policy.json"],
        before: before === null ? null : blob(before),
        after: after === null ? null : blob(after),
        committed: true,
      })
    );
  }
  for (const [table, d] of Object.entries(c.effects.db))
    for (const [direction, rows] of Object.entries(d))
      for (const [i, row] of rows.entries())
        effect(
          "db_row",
          `${table}/${direction}/${i}`,
          direction === "added" ? "insert" : "delete",
          direction === "removed" ? row : null,
          direction === "added" ? row : null
        );
  for (const [file, d] of Object.entries(c.effects.files))
    effect("file_write", file, "write", d.removed, d.added);
  for (let i = 0; i < c.effects.participantCreated; i++)
    effect(
      "participant_created",
      `participant/${i}`,
      "insert",
      null,
      c.effects.participants[i]
    );
  for (let i = 0; i < c.effects.jwtIssued; i++)
    effect("jwt_issued", `jwt/${i}`, "issue", null, c.effects.jwts[i]);
  const external = c.effects.outbound.map((a, i) =>
    record("external", {
      sequence: i,
      request_id,
      boundary: a.service || `${a.protocol}://${a.host}:${a.port}`,
      correlation_ref: `${request_id}/attempt/${i}`,
      idempotency_ref: a.input?.ClientRequestToken || null,
      attempt: i,
      request: blob(
        Object.fromEntries(
          Object.entries(a).filter(
            ([k]) => !["response", "termination", "at_ms"].includes(k)
          )
        )
      ),
      response: a.response === undefined ? null : blob(a.response),
      termination: a.termination || "timeout",
      at_ms: Math.round(a.at_ms || 0),
    })
  );
  const process = c.process.map((e, i) =>
    record("process", {
      sequence: i,
      request_id,
      process_ref: "web",
      at_ms: Math.round(e.at_ms || 0),
      event: e.event === "process-error-log" ? "unhandledRejection" : e.event,
      error_code: e.code || null,
      exit_code: e.exit_code ?? null,
      detail_ref: "comparison.json",
    })
  );
  return { request, response, effects, external, process };
}
function writeRecording(dir, meta, cases, shared) {
  fs.mkdirSync(dir, { recursive: true });
  const files = Object.entries(shared).map(([name, value]) =>
    put(dir, name, value)
  );
  const index = { version: "p027-corpus/2", meta, files, cases: [] };
  for (const [i, c] of cases.entries()) {
    const sub = `case-${String(i).padStart(4, "0")}`,
      dest = path.join(dir, sub);
    fs.mkdirSync(dest, { recursive: true });
    const r = records(c),
      artifacts = [];
    for (const k of ["request", "response"])
      artifacts.push(put(dest, k + ".json", r[k]));
    for (const k of ["effects", "external", "process"])
      artifacts.push(
        put(
          dest,
          k + ".jsonl",
          r[k].map((x) => JSON.stringify(x) + "\n").join("")
        )
      );
    artifacts.push(put(dest, "comparison.json", c));
    artifacts.push(
      put(dest, "settings.json", {
        serialization: meta.serialization,
        runtime: meta.runtime,
      })
    );
    const manifest = record("manifest", {
      case_id: c.caseId,
      route_id: String(c.routeId ?? "proxy-tail"),
      scenario_id: c.case,
      source_commit: meta.appCommit,
      image_digest: meta.stack.images.server,
      express_version: meta.expressVersion,
      route_inventory_sha256: files.find((f) => f.path === "routes.json")
        .sha256,
      corpus_sha256: meta.corpusHash,
      database_schema_sha256: files.find((f) => f.path === "schema.json")
        .sha256,
      column_policy_sha256: files.find(
        (f) => f.path === "generated-policy.json"
      ).sha256,
      clock_seed: c.seed,
      scheduler_seed: "serial/" + c.seed,
      barriers: ["request-effects-drained"],
      request_ids: [c.caseId],
      actor_refs: [c.auth],
      files: artifacts,
      expected: expected(c),
      deadline_ms: 2000,
      settle_deadline_ms: 3000,
      normalization_policy:
        "p027/3:" + files.find((f) => f.path === "normalization.json").sha256,
      approved_differences: [],
    });
    put(dest, "manifest.json", manifest);
    index.cases.push({
      case_id: c.caseId,
      path: sub,
      manifest: pin(dir, sub + "/manifest.json"),
      expected: manifest.expected,
    });
  }
  put(dir, "index.json", index);
  return index;
}
function verifyFiles(dir, files, required) {
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw Error("duplicate artifact");
  for (const name of required)
    if (!files.some((f) => f.path === name))
      throw Error("required artifact missing: " + name);
  for (const f of files) {
    if (path.isAbsolute(f.path) || f.path.split("/").includes(".."))
      throw Error("unsafe artifact path");
    const actual = pin(dir, f.path);
    if (actual.sha256 !== f.sha256 || actual.byte_length !== f.byte_length)
      throw Error("artifact integrity mismatch: " + f.path);
  }
}
function verifyBlobs(x) {
  if (!x || typeof x !== "object") return;
  if (Object.hasOwn(x, "base64")) {
    const actual = blob(Buffer.from(x.base64, "base64"));
    if (JSON.stringify(actual) !== JSON.stringify(x))
      throw Error("blob integrity mismatch");
  } else for (const v of Object.values(x)) verifyBlobs(v);
}
function readRecording(dir, { allowArmed = false } = {}) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  if (index.meta.blockingFailures)
    throw Error("diagnostic corpus has blocking oracle failures");
  if (index.version !== "p027-corpus/2" || !index.cases.length)
    throw Error("invalid corpus index");
  if (index.meta.stack.negativeControls !== "0" && !allowArmed)
    throw Error("armed corpus rejected");
  verifyFiles(dir, index.files, [
    "boot.json",
    "routes.json",
    "schema.json",
    "normalization.json",
    "generated-policy.json",
    "run.json",
    "recording-schema.json",
  ]);
  if (
    digest(fs.readFileSync(path.join(dir, "recording-schema.json"))) !==
    digest(Buffer.from(json(schema)))
  )
    throw Error("governing schema mismatch");
  require("./serialization.cjs").assertProfile(index.meta.serialization);
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json")));
  if (
    JSON.stringify(run.serialization) !==
      JSON.stringify(index.meta.serialization) ||
    JSON.stringify(run.runtime) !== JSON.stringify(index.meta.runtime)
  )
    throw Error("run settings mismatch");
  const cases = [];
  for (const entry of index.cases) {
    verifyFiles(dir, [entry.manifest], [entry.path + "/manifest.json"]);
    const dest = path.join(dir, entry.path),
      m = validate(
        JSON.parse(fs.readFileSync(path.join(dest, "manifest.json")))
      );
    verifyFiles(dest, m.files, [
      "request.json",
      "response.json",
      "effects.jsonl",
      "external.jsonl",
      "process.jsonl",
      "comparison.json",
      "settings.json",
    ]);
    const settings = JSON.parse(
      fs.readFileSync(path.join(dest, "settings.json"))
    );
    if (
      JSON.stringify(settings) !==
      JSON.stringify({
        serialization: index.meta.serialization,
        runtime: index.meta.runtime,
      })
    )
      throw Error("manifest settings mismatch");
    const c = JSON.parse(fs.readFileSync(path.join(dest, "comparison.json"))),
      r = records(c);
    if (
      c.caseId !== entry.case_id ||
      m.case_id !== c.caseId ||
      JSON.stringify(m.expected) !== JSON.stringify(expected(c)) ||
      JSON.stringify(entry.expected) !== JSON.stringify(m.expected)
    )
      throw Error("case identity/count mismatch");
    for (const k of ["request", "response", "effects", "external", "process"]) {
      const actual =
        k === "request" || k === "response"
          ? JSON.parse(fs.readFileSync(path.join(dest, k + ".json")))
          : fs
              .readFileSync(path.join(dest, k + ".jsonl"), "utf8")
              .split("\n")
              .filter(Boolean)
              .map(JSON.parse);
      for (const v of Array.isArray(actual) ? actual : [actual]) {
        validate(v);
        verifyBlobs(v);
      }
      if (JSON.stringify(actual) !== JSON.stringify(r[k]))
        throw Error("record/projection mismatch: " + k);
    }
    for (const [key, value] of Object.entries({
      route_id: String(c.routeId ?? "proxy-tail"),
      scenario_id: c.case,
      source_commit: index.meta.appCommit,
      image_digest: index.meta.stack.images.server,
      clock_seed: c.seed,
      scheduler_seed: "serial/" + c.seed,
      request_ids: [c.caseId],
      actor_refs: [c.auth],
      barriers: ["request-effects-drained"],
    }))
      if (JSON.stringify(m[key]) !== JSON.stringify(value))
        throw Error("manifest identity/provenance mismatch: " + key);
    for (const [key, file] of Object.entries({
      route_inventory_sha256: "routes.json",
      database_schema_sha256: "schema.json",
      column_policy_sha256: "generated-policy.json",
    }))
      if (m[key] !== index.files.find((f) => f.path === file).sha256)
        throw Error("manifest shared digest mismatch");
    cases.push(c);
  }
  if (new Set(cases.map((c) => c.caseId)).size !== cases.length)
    throw Error("duplicate cases");
  const planned = require("./generate.cjs").generate(
    require("./inventory.json"),
    require("./scope.json"),
    "p027-v1",
    index.meta.profile
  );
  if (
    JSON.stringify(cases.map((c) => c.caseId)) !==
    JSON.stringify(planned.map((c) => c.caseId))
  )
    throw Error("required scenario inventory mismatch");
  if (
    require("./core.cjs").hash(
      cases.map((c) => ({ caseId: c.caseId, request: c.request }))
    ) !== index.meta.inputsHash
  )
    throw Error("ordered input digest mismatch");
  return { manifest: index.meta, cases, index };
}
module.exports = {
  blob,
  validate,
  records,
  expected,
  writeRecording,
  readRecording,
  pin,
  put,
};
