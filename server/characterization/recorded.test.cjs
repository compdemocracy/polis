"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { readRecording, writeRecording, validate } = require("./recording.cjs"),
  { firstDiff } = require("./core.cjs");
const root = require("./baseline.cjs").testBaseline();
const baseline = readRecording(root);
function shared() {
  return Object.fromEntries(
    baseline.index.files.map((f) => [
      f.path,
      fs.readFileSync(path.join(root, f.path), "utf8"),
    ])
  );
}
test("F1: every live case manifest and all five record artifacts validate under unchanged P-025", () => {
  let records = 0;
  for (const entry of baseline.index.cases) {
    const dir = path.join(root, entry.path);
    validate(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"))));
    records++;
    for (const name of [
      "request.json",
      "response.json",
      "effects.jsonl",
      "external.jsonl",
      "process.jsonl",
    ]) {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      for (const r of name.endsWith("jsonl")
        ? raw.split("\n").filter(Boolean).map(JSON.parse)
        : [JSON.parse(raw)]) {
        validate(r);
        assert.throws(() => validate({ ...r, unknown: true }), /P-025 schema/);
        records++;
      }
    }
  }
  assert(baseline.cases.length > 513);
  console.log(
    JSON.stringify({ cases: baseline.cases.length, validatedRecords: records })
  );
});
for (const name of [
  "boot.json",
  "routes.json",
  "schema.json",
  "normalization.json",
  "run.json",
  "recording-schema.json",
  "generated-policy.json",
  "case-0000/manifest.json",
  "case-0000/request.json",
  "case-0000/response.json",
  "case-0000/effects.jsonl",
  "case-0000/external.jsonl",
  "case-0000/process.jsonl",
])
  test("F1: missing or altered artifact rejected: " + name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-integrity-"));
    try {
      fs.cpSync(root, tmp, { recursive: true });
      const file = path.join(tmp, name);
      fs.appendFileSync(file, " ");
      assert.throws(() => readRecording(tmp), /integrity/);
      fs.unlinkSync(file);
      assert.throws(() => readRecording(tmp), /ENOENT/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
const by = (id) => baseline.cases.find((c) => c.caseId === id);
const mutations = [
  [
    "change auth result",
    "r88/unauthenticated/boundary",
    (c) => assert(c.response.status >= 400),
    (c) => {
      c.response.status = 200;
      c.wire.response.status = 200;
    },
  ],
  [
    "flip vote",
    "r77/unauthenticated/effects",
    (c) => assert(c.effects.db["pg:votes"].added.some((r) => r.vote === -1)),
    (c) => {
      c.effects.db["pg:votes"].added[0].vote = 1;
    },
  ],
  [
    "swap report/job namespace",
    "r55/unauthenticated/effects",
    (c) => assert(c.response.body.current_job_id),
    (c) => {
      c.response.body.current_job_id = "r2p027generated";
    },
  ],
  [
    "remove page two",
    "r55/unauthenticated/effects",
    (c) =>
      assert(
        c.effects.outbound.filter(
          (a) => a.host === "dynamodb" && a.body?.ExclusiveStartKey
        ).length >= 1
      ),
    (c) => {
      for (const attempt of c.effects.outbound.filter(
        (a) => a.body?.ExclusiveStartKey
      ))
        for (const item of JSON.parse(attempt.response).Items) {
          const section = item.rid_section_model.S.split("#")[1];
          assert(c.response.body.reports[section]);
          delete c.response.body.reports[section];
        }
    },
  ],
  [
    "duplicate an external effect",
    "r55/unauthenticated/effects",
    (c) => assert(c.effects.outbound.length > 0),
    (c) => c.effects.outbound.push(structuredClone(c.effects.outbound[0])),
  ],
  [
    "alter only comments/config/runtime",
    "r43/unauthenticated/effects",
    (c) => assert(c.effects.db["pg:comments"].added.length > 0),
    (c) => {
      c.effects.db["pg:comments"].added[0].txt = "Generated mutation";
    },
  ],
  [
    "truncate a stream",
    "r55/unauthenticated/effects",
    (c) => {
      assert(c.wire.response.completed);
      assert(c.wire.response.body.length > 1);
    },
    (c) => {
      c.wire.response.body.pop();
      c.wire.response.completed = false;
      c.wire.response.termination = "aborted";
      c.response.completed = false;
    },
  ],
  [
    "extra issued token",
    "r43/unauthenticated/effects",
    (c) => assert(c.effects.jwtIssued > 0),
    (c) => {
      c.effects.jwts.push(c.effects.jwts[0]);
      c.effects.jwtIssued++;
    },
  ],
];
for (const [name, id, precondition, mutate] of mutations)
  test("F3 recorded gate: " + name + " @ " + id, () => {
    const c = by(id);
    assert(c, "required recorded scenario absent");
    precondition(c);
    const changed = structuredClone(baseline.cases);
    mutate(changed.find((x) => x.caseId === id));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-mutant-"));
    try {
      writeRecording(tmp, baseline.manifest, changed, shared());
      const admitted = readRecording(tmp).cases.find((x) => x.caseId === id);
      const field = firstDiff(c, admitted);
      assert(field);
      console.log(`DIFF ${id} ${field}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
test("F3: delete a recording and regenerate index cannot shrink required scenario inventory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-missing-"));
  try {
    writeRecording(tmp, baseline.manifest, baseline.cases.slice(1), shared());
    assert.throws(() => readRecording(tmp), /inventory mismatch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("F5: ordinary admission refuses an armed corpus", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-armed-"));
  try {
    fs.cpSync(root, tmp, { recursive: true });
    const file = path.join(tmp, "index.json"),
      index = JSON.parse(fs.readFileSync(file));
    index.meta.stack.negativeControls = "1";
    fs.writeFileSync(file, JSON.stringify(index));
    assert.throws(() => readRecording(tmp), /armed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F4: admitted pca2 and participationInit carry approved comments and expose missing refill", () => {
  function pcas(x, out = []) {
    if (x && typeof x === "object") {
      if (Array.isArray(x.tids) && Object.hasOwn(x, "n-cmts")) out.push(x);
      for (const v of Object.values(x)) pcas(v, out);
    }
    return out;
  }
  for (const id of ["r5/unauthenticated/effects", "r75/participant/effects"]) {
    const c = by(id);
    assert(c);
    assert.equal(c.response.status, 200);
    const found = pcas(c.response.body);
    assert(found.length > 0, id + " must decode PCA");
    assert(found.every((x) => x.tids.length >= 2 && x["n-cmts"] >= 2));
    const mutant = structuredClone(c);
    for (const x of pcas(mutant.response.body)) {
      x.tids = [];
      x["n-cmts"] = 0;
      x.pca["comment-extremity"] = [];
    }
    const field = firstDiff(c.response, mutant.response);
    assert(/n-cmts|tids|comment-extremity/.test(field));
    console.log(`DIFF ${id} $.response${field.slice(1)}`);
  }
});
