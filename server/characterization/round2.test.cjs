"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { pack, testBaseline } = require("./baseline.cjs");
const { readRecording, writeRecording, blob } = require("./recording.cjs");
const { comparable } = require("./compare.cjs");
const {
  bytes,
  strings,
  comparableBody,
  comparableHeaders,
} = require("./wire.cjs");
const { firstDiff } = require("./core.cjs");
const root = testBaseline(),
  baseline = readRecording(root);
const by = (id) => baseline.cases.find((c) => c.caseId === id);
test("N2: production coverage counts the 307 identical opaque 400 bodies per registration", () => {
  const { coverageStats, coverageTable } = require("./core.cjs");
  const legacy = baseline.cases.filter((c) => !c.caseId.includes("/pca2/"));
  const stats = coverageStats(legacy);
  assert.equal(stats.cases, 533);
  assert.equal(stats.opaque400Cases, 307);
  assert.equal(stats.statuses[400], 339);
  assert.equal(
    stats.rows.reduce((n, r) => n + r.opaque400Cases, 0),
    307
  );
  for (const row of stats.rows) {
    const opaque = legacy.filter(
      (c) =>
        c.routeId === row.routeId &&
        c.response.status === 400 &&
        bytes(c).equals(Buffer.from("Bad Request\n"))
    );
    assert.equal(row.opaque400Cases, opaque.length, `r${row.routeId}`);
  }
  assert.match(coverageTable(stats), /Cases \| Opaque 400 \| 2xx/);
  assert.equal(coverageTable(stats).trim().split("\n").length, 130);
});
test("R1: every manifest pins production-compact settings and all plain JSON bodies are compact", () => {
  require("./serialization.cjs").assertProfile(baseline.manifest.serialization);
  assert.match(baseline.manifest.runtime.node, /^v22\./);
  let plain = 0;
  for (const c of baseline.cases) {
    const b = bytes(c);
    if (
      !b.length ||
      b[0] === 31 ||
      !c.response.headers["content-type"]?.includes("application/json")
    )
      continue;
    assert.equal(b.toString(), JSON.stringify(JSON.parse(b)), c.caseId);
    if (!c.caseId.includes("/pca2/")) plain++;
  }
  assert.equal(plain, 176);
  for (const role of ["participant", "owner"])
    assert(!Object.hasOwn(by(`r54/${role}/boundary`).response.body, "details"));
  for (const entry of baseline.index.cases) {
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, entry.path, "settings.json"))
    );
    assert.deepEqual(settings, {
      serialization: baseline.manifest.serialization,
      runtime: baseline.manifest.runtime,
    });
  }
  assert.throws(
    () =>
      require("./serialization.cjs").assertProfile({
        ...baseline.manifest.serialization,
        jsonSpaces: 2,
      }),
    /production-compact/
  );
});
test("R3: pack after unpack reproduces the committed archive digest twice", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-pack-"));
  try {
    const pin = fs
      .readFileSync(path.join(__dirname, "artifacts/baseline.sha256"), "utf8")
      .trim();
    assert.equal(pack(root, path.join(tmp, "one.gz")), pin);
    assert.equal(pack(root, path.join(tmp, "two.gz")), pin);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
for (const mutation of ["key-order", "whitespace", "numeric-spelling"])
  test(`R2: admitted ${mutation} mutation fails the replay comparator while semantic body agrees`, () => {
    const c = by("r75/owner/effects"),
      mutant = structuredClone(c);
    const text = bytes(c).toString();
    let changed;
    if (mutation === "key-order")
      changed = JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(text)).reverse())
      );
    if (mutation === "whitespace")
      changed = JSON.stringify(JSON.parse(text), null, 2);
    if (mutation === "numeric-spelling")
      changed = text.replace(/(:)(\d+)([,}])/, "$1$2.0$3");
    assert.notEqual(changed, text);
    assert.deepEqual(JSON.parse(changed), JSON.parse(text));
    mutant.wire.response.body = [
      {
        sequence: 0,
        at_ms: mutant.wire.response.last_byte_ms,
        bytes: blob(changed),
      },
    ];
    // Repin all records so integrity validation cannot be the failure mechanism.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p027-wire-mutant-"));
    try {
      writeRecording(
        tmp,
        baseline.manifest,
        baseline.cases.map((x) => (x.caseId === c.caseId ? mutant : x)),
        Object.fromEntries(
          baseline.index.files.map((f) => [
            f.path,
            fs.readFileSync(path.join(root, f.path), "utf8"),
          ])
        )
      );
      const admitted = readRecording(tmp).cases.find(
        (x) => x.caseId === c.caseId
      );
      assert.equal(
        firstDiff(comparable(c), comparable(admitted)),
        "$.wireBody"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
test("R2: transport chunk segmentation is evidence only; truncation remains a byte difference", () => {
  const c = by("r55/owner/effects"),
    m = structuredClone(c),
    body = bytes(c);
  assert(c.wire.response.body.length > 1);
  m.wire.response.body = [{ sequence: 0, at_ms: 0, bytes: blob(body) }];
  assert.equal(firstDiff(comparable(c), comparable(m)), null);
  m.wire.response.body[0].bytes = blob(body.subarray(0, body.length - 1));
  assert.throws(() => comparable(m), /JSON|position|end|Expected/);
});
test("R2: only typed capability and bound URL values change; derived headers are checked", () => {
  for (const route of [106, 107])
    for (const role of ["participant", "owner", "admin"]) {
      const c = by(`r${route}/${role}/boundary`),
        m = structuredClone(c);
      const raw = bytes(c),
        text = raw.toString(),
        parsed = JSON.parse(text);
      assert(parsed.conversation_id);
      const changed = strings(text, (v, p, k) =>
        k === "conversation_id"
          ? "newcapability"
          : k === "url"
          ? v.replace(parsed.conversation_id, "newcapability")
          : v
      );
      m.wire.response.body = [{ sequence: 0, at_ms: 0, bytes: blob(changed) }];
      for (const h of m.wire.response.headers) {
        if (h.name.toLowerCase() === "content-length")
          h.value = String(Buffer.byteLength(changed));
        if (h.name.toLowerCase() === "etag")
          h.value = require("express/lib/utils").wetag(Buffer.from(changed));
      }
      assert.equal(comparableBody(c), comparableBody(m));
      assert.deepEqual(comparableHeaders(c), comparableHeaders(m));
      const length = m.wire.response.headers.find(
        (h) => h.name.toLowerCase() === "content-length"
      );
      length.value = "1";
      assert.throws(() => comparableHeaders(m), /Content-Length/);
    }
  assert.equal(
    strings('{"text":"cap","conversation_id":"cap"}', (v, p, k) =>
      k === "conversation_id" ? "$conversation_id:1" : v
    ),
    '{"text":"cap","conversation_id":"$conversation_id:1"}'
  );
});
test("R2: ordinary Content-Length and ETag mutations fail equality", () => {
  const c = by("r75/owner/effects");
  for (const name of ["content-length", "etag"]) {
    const m = structuredClone(c),
      h = m.wire.response.headers.find((x) => x.name.toLowerCase() === name);
    assert(h);
    h.value += "wrong";
    assert.match(firstDiff(comparable(c), comparable(m)), /orderedHeaders/);
  }
});
test("P-032 C6 evidence: admitted participationInit PCA encodings agree before and after normalization", () => {
  let count = 0;
  for (const c of baseline.cases) {
    if (c.routeId !== 75) continue;
    const pca = JSON.parse(bytes(c)).pca;
    if (!pca) continue;
    assert.deepEqual(pca.asPOJO, JSON.parse(pca.asJSON));
    assert.deepEqual(
      pca.asPOJO,
      JSON.parse(
        require("node:zlib").gunzipSync(
          Buffer.from(pca.asBufferOfGzippedJson.data)
        )
      )
    );
    assert.deepEqual(
      c.response.body.pca.asPOJO,
      c.response.body.pca.asJSON.value
    );
    assert.deepEqual(
      c.response.body.pca.asPOJO,
      c.response.body.pca.asBufferOfGzippedJson.value
    );
    count++;
  }
  assert.equal(count, 5);
});
test("R6: cookie behavior is explicitly uncharacterized by this corpus", () => {
  assert.equal(
    baseline.cases.filter((c) =>
      c.wire.response.headers.some((h) => h.name.toLowerCase() === "set-cookie")
    ).length,
    0
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "README.md"), "utf8"),
    /Cookie behavior is uncharacterized/
  );
});

test("R2: verified JWT substitution retains surrounding wire JSON and checks derived headers", () => {
  for (const id of [
    "r43/unauthenticated/effects",
    "r77/unauthenticated/effects",
  ]) {
    const c = by(id),
      raw = bytes(c).toString();
    assert.equal(c.credentialWireValidation.count, 1);
    assert.match(raw, /\$jwt:[a-f0-9]{64}/);
    const m = structuredClone(c);
    m.wire.response.body = [
      {
        sequence: 0,
        at_ms: 0,
        bytes: blob(JSON.stringify(JSON.parse(raw), null, 2)),
      },
    ];
    assert(firstDiff(comparable(c), comparable(m)), id);
    const badHeader = structuredClone(c);
    badHeader.wire.response.headers.find(
      (h) => h.name.toLowerCase() === "etag"
    ).value += "wrong";
    assert.throws(() => comparable(badHeader), /changed after verification/);
  }
});

test("R1: production finalhandler hides internal error messages in all 307 generic error bodies", () => {
  const generic = baseline.cases.filter(
    (c) =>
      bytes(c).toString() ===
      require("node:http").STATUS_CODES[c.response.status] + "\n"
  );
  assert.equal(generic.filter((c) => !c.caseId.includes("/pca2/")).length, 307);
  assert.equal(bytes(by("r5/owner/boundary")).toString(), "Bad Request\n");
  assert(generic.every((c) => c.response.status >= 400));
});
