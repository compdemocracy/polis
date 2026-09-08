"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Normalizer } = require("./normalize.cjs"),
  { firstDiff } = require("./core.cjs");
const { verifyToken } = require("./jwt.cjs");
const { assertAttempts } = require("./admission.cjs");
const { createBarrier } = require("./barrier.cjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test("A1: verify local RSA signature, issuer/audience, expiry and actor/conversation before replacement", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const binding = {
    publicKey: pair.publicKey,
    issuer: "https://pol.is/",
    audience: "participants",
    now: 1700000000,
    ttl: 300,
    conversation_id: "2p027generated",
    uid: 3,
    pid: 2,
    sub: "anon:3",
  };
  const claims = {
    iss: binding.issuer,
    aud: binding.audience,
    iat: binding.now,
    exp: binding.now + 300,
    conversation_id: binding.conversation_id,
    uid: 3,
    pid: 2,
    sub: "anon:3",
  };
  const token = (p, h = { alg: "RS256", typ: "JWT" }) => {
    const prefix = [h, p]
      .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
      .join(".");
    return (
      prefix +
      "." +
      crypto
        .sign("RSA-SHA256", Buffer.from(prefix), pair.privateKey)
        .toString("base64url")
    );
  };
  const valid = token(claims);
  assert.equal(verifyToken(valid, binding).ttl, 300);
  const parts = valid.split("."),
    bad = Buffer.from(parts[2], "base64url");
  bad[0] ^= 1;
  parts[2] = bad.toString("base64url");
  assert.throws(
    () => new Normalizer(binding).normalize({ token: parts.join(".") }),
    /signature/
  );
  for (const [key, value] of Object.entries({
    conversation_id: "wrong",
    uid: 4,
    pid: 3,
    sub: "anon:4",
    iss: "wrong",
    aud: "wrong",
    exp: binding.now - 1,
  }))
    assert.throws(
      () => verifyToken(token({ ...claims, [key]: value }), binding),
      /JWT/
    );
  assert.throws(
    () => verifyToken(token(claims, { alg: "HS256" }), binding),
    /algorithm/
  );
  const n = new Normalizer(binding);
  n.normalize({ token: valid });
  n.normalize({ token: valid });
  assert.equal(n.issued.length, 2);
  assert.equal(
    firstDiff({ jwtIssued: 1 }, { jwtIssued: n.issued.length }),
    "$.jwtIssued"
  );
});
test("A2: delayed write beyond stable snapshots stays owned until named drain barrier", async () => {
  const b = createBarrier();
  let writes = 0;
  try {
    b.run("case-a", () =>
      setTimeout(() => {
        writes++;
      }, 450)
    );
    await wait(310);
    assert.equal(writes, 0);
    assert.throws(() => b.finish("case-a"), /INCONCLUSIVE/);
    await wait(180);
    assert.equal(writes, 1);
    assert.equal(b.finish("case-a"), "request-effects-drained");
    b.run("case-a", () => setImmediate(() => {}));
    assert.throws(() => b.finish("case-b"), /INCONCLUSIVE/);
  } finally {
    b.close();
  }
});
test("A2: unfinished provider/DB work cannot be hidden by equal row snapshots", () => {
  const b = createBarrier();
  try {
    let done;
    b.run("a", () => {
      done = b.start("postgres");
    });
    assert.throws(() => b.finish("a"), /INCONCLUSIVE/);
    done();
    assert.equal(b.finish("a"), "request-effects-drained");
  } finally {
    b.close();
  }
});
test("A3: only exact Akismet boot control is exempt; forbidden attempts fail even blocked", () => {
  const a = {
    host: "rest.akismet.com",
    port: 80,
    protocol: "http",
    method: "POST",
    path: "/1.1/verify-key",
    blocked: true,
  };
  assertAttempts([a], true);
  for (const attempts of [
    [{ ...a, host: "169.254.169.254" }],
    [{ ...a, path: "/other" }],
    [a, a],
    [{ service: "SESv2" }],
  ])
    assert.throws(() => assertAttempts(attempts, true), /outbound/);
  assert.throws(() => assertAttempts([a]), /outbound/);
});
test("F7: database timestamp errors remain visible and repeated cookies are in comparison policy", () => {
  const n = new Normalizer();
  assert.equal(
    firstDiff(
      n.normalize({ created: 1 }, "$.effects.db.row"),
      n.normalize({ created: 2 }, "$.effects.db.row")
    ),
    "$.created"
  );
  assert(
    require("./normalize.cjs").policy.responseHeaders.includes("set-cookie")
  );
  assert.notEqual(
    firstDiff(
      { headers: { "set-cookie": ["a=x; Secure", "a=y; HttpOnly"] } },
      { headers: { "set-cookie": ["a=y; HttpOnly", "a=x; Secure"] } }
    ),
    null
  );
});
function pcaModule(engine, removeRefill = false) {
  const vm = require("node:vm"),
    ts = require("typescript");
  const filename = path.resolve(__dirname, "../src/utils/pca.ts");
  let source = fs.readFileSync(filename, "utf8");
  if (removeRefill) {
    const refill =
      "tids = commentsQuery.map((row: { tid: number }) => row.tid);";
    assert(
      source.includes(refill),
      "C7 refill mutation must hit server source"
    );
    source = source.replace(refill, "tids = [];");
  }
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const pg = {
    queryP_readOnly: async (sql) =>
      sql.includes("from comments")
        ? [{ tid: 0 }, { tid: 1 }]
        : engine === null
        ? []
        : [{ data: structuredClone(engine), math_tick: engine.math_tick ?? 0 }],
  };
  const custom = (name) =>
    name === "../db/pg-query"
      ? { default: pg, __esModule: true }
      : name === "../config"
      ? {
          default: { mathEnv: "p027", cacheMathResults: false },
          __esModule: true,
        }
      : name === "./logger"
      ? { default: { info() {}, silly() {}, error() {} }, __esModule: true }
      : name === "./metered"
      ? { addInRamMetric() {} }
      : require(name);
  vm.runInNewContext(
    code,
    {
      require: custom,
      exports: module.exports,
      module,
      Buffer,
      console,
      setTimeout,
    },
    { filename }
  );
  return module.exports;
}
test("N1: removing the server C7 refill reports n-cmts before derived headers", async () => {
  const { firstDifference } = require("./compare.cjs");
  const { blob } = require("./recording.cjs");
  const asCase = (item) => {
    const raw = item.asBufferOfGzippedJson;
    return {
      response: {
        body: new Normalizer().normalize(
          JSON.parse(require("node:zlib").gunzipSync(raw)),
          "$.response.body"
        ),
        status: 200,
        headers: { "content-type": "application/json" },
      },
      effects: { outbound: [] },
      process: [],
      wire: {
        response: {
          body: [{ sequence: 0, at_ms: 0, bytes: blob(raw) }],
          headers: [
            { name: "Content-Type", value: "application/json" },
            { name: "Content-Length", value: String(raw.length) },
            { name: "ETag", value: require("express/lib/utils").wetag(raw) },
          ],
        },
      },
    };
  };
  const before = asCase(await pcaModule(null).getPca(1, -1));
  const after = asCase(await pcaModule(null, true).getPca(1, -1));
  assert.equal(before.response.body["n-cmts"], 2);
  assert.equal(after.response.body["n-cmts"], 0);
  assert.equal(firstDifference(before, structuredClone(before)), null);
  assert.match(
    firstDifference(before, after),
    /^\$\.response\.body\.n-cmts \(body-derived consequences: .*content-length.*etag/
  );
  // Header-only regressions still block and are not described as body effects.
  const headerOnly = structuredClone(before);
  headerOnly.wire.response.headers[1].value = "wrong";
  assert.equal(firstDifference(before, headerOnly), "$.orderedHeaders.1.value");
  after.wire.response.headers[1].value = "wrong";
  assert(!firstDifference(before, after).includes("content-length"));
});
test("F4: actual PCA serializer exposes C7 empty-engine regression against approved-comment no-row baseline", async () => {
  const decode = (item) =>
    JSON.parse(require("node:zlib").gunzipSync(item.asBufferOfGzippedJson));
  const baseline = decode(await pcaModule(null).getPca(1, -1));
  assert.deepEqual(baseline.tids, [0, 1]);
  assert.equal(baseline["n-cmts"], 2);
  assert.deepEqual(baseline.pca["comment-extremity"], [0, 0]);
  assert.deepEqual(baseline.pca.center, [0, 0]);
  const engine = {
    ...baseline,
    tids: [],
    "n-cmts": 0,
    pca: { ...baseline.pca, "comment-extremity": [] },
    math_tick: 0,
  };
  const bad = decode(await pcaModule(engine).getPca(1, -1));
  assert.deepEqual(bad.tids, []);
  const n = new Normalizer();
  const servedFields = (x) => ({
    tids: x.tids,
    "n-cmts": x["n-cmts"],
    pca: {
      center: x.pca.center,
      "comment-extremity": x.pca["comment-extremity"],
    },
  });
  // A retained refill is the positive control: unrelated engine metadata cannot
  // make this gate red. Compare the actual decoded served comment fields.
  const retained = decode(
    await pcaModule({
      ...engine,
      ...servedFields(baseline),
      pca: { ...engine.pca, ...servedFields(baseline).pca },
    }).getPca(1, -1)
  );
  assert.deepEqual(servedFields(retained), servedFields(baseline));
  for (const wrap of [
    (x) => x,
    (x) => ({ pca: { asJSON: JSON.stringify(x) } }),
  ])
    assert.match(
      firstDiff(
        n.normalize(wrap(servedFields(baseline)), "$.response.body"),
        n.normalize(wrap(servedFields(bad)), "$.response.body")
      ),
      /n-cmts|tids|comment-extremity/
    );
  for (const [field, change] of [
    ["tids", (x) => (x.tids = [])],
    ["n-cmts", (x) => (x["n-cmts"] = 0)],
    ["pca.comment-extremity", (x) => (x.pca["comment-extremity"] = [])],
    ["pca.center", (x) => (x.pca.center = [])],
  ]) {
    const mutant = structuredClone(baseline);
    change(mutant);
    assert(firstDiff(baseline, mutant).includes(field));
  }
  // The five reconstructed legacy engine forms and corrected engine golden are
  // generated structural fixtures, independent of production rows/identifiers.
  const shapes = require("./c7-shapes.json");
  const corrected = { ...shapes.corrected, zid: 1, math_tick: 7 };
  const withoutRefill = decode(await pcaModule(corrected).getPca(1, -1));
  for (const shape of shapes.legacy) {
    const before = decode(
      await pcaModule({ ...shape, zid: 1, math_tick: 7 }).getPca(1, -1)
    );
    assert.deepEqual(servedFields(before), servedFields(baseline));
    assert.match(
      firstDiff(servedFields(before), servedFields(withoutRefill)),
      /n-cmts|tids|comment-extremity|center/
    );
    const withRefill = decode(
      await pcaModule({
        ...corrected,
        ...servedFields(before),
        pca: { ...corrected.pca, ...servedFields(before).pca },
      }).getPca(1, -1)
    );
    assert.deepEqual(servedFields(withRefill), servedFields(before));
  }
});

test("A2: unref does not exempt application delayed work", async () => {
  const b = createBarrier();
  try {
    b.run("unref", () => setTimeout(() => {}, 60).unref());
    assert.throws(() => b.finish("unref"), /INCONCLUSIVE/);
    await wait(100);
    assert.equal(b.finish("unref"), "request-effects-drained");
  } finally {
    b.close();
  }
});

test("F7: cookie values require a local fixture; attributes, repetition and order remain asserted", () => {
  const { headers } = require("./headers.cjs"),
    fixtures = {
      session: {
        value: "generated-session",
        attributes: ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"],
      },
    };
  const input = [
    {
      name: "Set-Cookie",
      value:
        "session=generated-session; Path=/; HttpOnly; Secure; SameSite=Lax",
      credential_ref: null,
    },
  ];
  const out = headers([...input, ...input], fixtures);
  assert.equal(out.length, 2);
  assert.equal(out[0].credential_ref, "$cookie:session");
  assert(!JSON.stringify(out).includes("generated-session"));
  assert.throws(() => headers(input), /unclassified cookie/);
  assert.throws(
    () =>
      headers(
        [{ ...input[0], value: input[0].value.replace("; Secure", "") }],
        fixtures
      ),
    /attributes/
  );
});

test("F6: transport observation preserves a deferred consumer and complete multi-chunk body", async () => {
  const { EventEmitter } = require("node:events"),
    { PassThrough } = require("node:stream"),
    { observeResponse } = require("./transport-observe.cjs");
  const req = new EventEmitter(),
    res = new PassThrough(),
    attempt = {};
  let finished = 0;
  observeResponse(req, attempt, () => finished++);
  req.emit("response", res);
  const first = Buffer.alloc(20000, "a"),
    second = Buffer.alloc(20000, "b");
  res.write(first);
  await wait(10);
  assert.equal(res.readableFlowing, null);
  const chunks = [];
  res.on("data", (b) => chunks.push(b));
  const end = new Promise((resolve) => res.on("end", resolve));
  res.end(second);
  await end;
  assert(Buffer.concat(chunks).equals(Buffer.concat([first, second])));
  assert.equal(attempt.response, Buffer.concat(chunks).toString());
  assert.equal(finished, 1);
});
