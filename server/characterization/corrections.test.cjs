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
// C7 (engine cutover). The empty-math comment refill moved from getPca's merge
// (src/utils/pca.ts on the old base) to the response boundary
// (src/utils/pcaPresentation.ts `presentPca` / `backfilledTids` on edge). These
// tests drive the ACTUAL source end to end — getPca's merge, then presentPca —
// so the refill is exercised where edge put it and the served empty-math shapes
// come from the real merge + presentation, never a hand-built body.
const ts = require("typescript"),
  vm = require("node:vm"),
  zlib = require("node:zlib");

// Postgres stores `math_main.data` as jsonb, which canonicalizes object keys by
// (length asc, then bytewise) before the server ever sees a blob. The unit path
// here feeds the blob straight in, so reproduce that canonicalization to get
// edge's exact served key order (C7 report, "Revision 2").
function jsonbCanon(x) {
  if (Array.isArray(x)) return x.map(jsonbCanon);
  if (x && typeof x === "object") {
    const out = {};
    for (const k of Object.keys(x).sort(
      (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    ))
      out[k] = jsonbCanon(x[k]);
    return out;
  }
  return x;
}

// Transpile src/utils/pca.ts and src/utils/pcaPresentation.ts into one shared
// context so presentPca reads getPca's real merge mark (the
// `wasMergedWithTemplate` WeakSet). `mutateBackfill` neutralises the C7 comment
// refill in pcaPresentation.ts — the round-7 analogue of removing the old pca.ts
// refill: removing it must still turn the gate red.
function pcaEnv(engineRow, { mutateBackfill = false } = {}) {
  const pg = {
    queryP_readOnly: async (sql) =>
      sql.includes("from comments")
        ? [{ tid: 0 }, { tid: 1 }]
        : engineRow === null
        ? []
        : [
            {
              data: structuredClone(engineRow),
              math_tick: engineRow.math_tick ?? 7,
            },
          ],
  };
  const context = { Buffer, console, setTimeout, process, URL, structuredClone };
  vm.createContext(context);
  const modules = {};
  context.require = (n) =>
    n === "../db/pg-query"
      ? { default: pg, __esModule: true }
      : n === "../config"
      ? {
          default: { mathEnv: "p027", cacheMathResults: false },
          __esModule: true,
        }
      : n === "./logger"
      ? { default: { info() {}, silly() {}, error() {} }, __esModule: true }
      : n === "./metered"
      ? { addInRamMetric() {} }
      : n === "./pca"
      ? modules.pca.exports
      : require(n);
  const build = (rel, key, transform) => {
    const filename = path.resolve(__dirname, rel);
    let source = fs.readFileSync(filename, "utf8");
    if (transform) source = transform(source);
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    modules[key] = module;
    context.module = module;
    context.exports = module.exports;
    vm.runInContext(code, context, { filename });
    return module.exports;
  };
  build("../src/utils/pca.ts", "pca");
  const presentation = build(
    "../src/utils/pcaPresentation.ts",
    "presentation",
    mutateBackfill
      ? (s) => {
          const refill =
            "return commentsQuery.map((row: { tid: number }) => row.tid);";
          assert(
            s.includes(refill),
            "C7 backfill mutation must hit server source"
          );
          return s.replace(refill, "return [];");
        }
      : null
  );
  return {
    getPca: modules.pca.exports.getPca,
    presentPca: presentation.presentPca,
  };
}

// One blob's served empty-math presentation: getPca's merge, then presentPca's
// boundary fill, exactly as /api/v3/math/pca2 (routes/math.ts) and
// /api/v3/participationInit (routes/participation.ts) call them.
async function presentServed(engineRow, opts) {
  const env = pcaEnv(engineRow === null ? null : jsonbCanon(engineRow), opts);
  const item = await env.getPca(1, -1);
  return env.presentPca(1, item);
}
const decodePresented = (item) =>
  JSON.parse(zlib.gunzipSync(item.asBufferOfGzippedJson));
const CORRECTED = {
  ...require("./c7-shapes.json").corrected,
  zid: 1,
  math_tick: 7,
};

test("N1: removing the server C7 refill reports n-cmts before derived headers", async () => {
  const { firstDifference } = require("./compare.cjs");
  const { blob } = require("./recording.cjs");
  const asCase = (item) => {
    const raw = item.asBufferOfGzippedJson;
    return {
      response: {
        body: new Normalizer().normalize(
          JSON.parse(zlib.gunzipSync(raw)),
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
  // The refill now lives in presentPca; drive the real getPca -> presentPca and
  // remove that refill for the negative case.
  const before = asCase(await presentServed(CORRECTED));
  const after = asCase(await presentServed(CORRECTED, { mutateBackfill: true }));
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
  const servedFields = (x) => ({
    tids: x.tids,
    "n-cmts": x["n-cmts"],
    pca: {
      center: x.pca.center,
      "comment-extremity": x.pca["comment-extremity"],
    },
  });
  const n = new Normalizer();
  const baseline = decodePresented(await presentServed(CORRECTED));
  assert.deepEqual(baseline.tids, [0, 1]);
  assert.equal(baseline["n-cmts"], 2);
  assert.deepEqual(baseline.pca["comment-extremity"], [0, 0]);
  assert.deepEqual(baseline.pca.center, [0, 0]);
  // Removing the presentation refill drops the conversation's comments off the
  // wire: the C7 empty-engine regression the cutover was built to prevent.
  const bad = decodePresented(await presentServed(CORRECTED, { mutateBackfill: true }));
  assert.deepEqual(bad.tids, []);
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
  // Each served comment field individually turns the gate red.
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
});

test("C7: engine-cutover key-order-only replacement for the two named empty shapes", async () => {
  // BOARD [488] / DECISIONS.md: Colin approved a NARROW replacement for the
  // empty-math engine cutover. Across the engine change the served body's ONLY
  // permitted difference is the position of the three empty top-level keys
  // `mod-in`, `mod-out`, `meta-tids`; their values stay `[]`, the complete key
  // set and every other key's relative order are unchanged, and the nested JSON
  // is byte-identical. This is the presentation both response shapes emit —
  // /api/v3/math/pca2 (routes/math.ts: `res.send(data.asBufferOfGzippedJson)`)
  // and /api/v3/participationInit (routes/participation.ts:
  // `response.pca = pcaData`, i.e. `$.response.body.pca.asJSON`). It is NOT a
  // global sort: shapes 1/2/5 stay byte-identical below.
  const APPENDED = ["meta-tids", "mod-in", "mod-out"];
  const shapes = require("./c7-shapes.json");
  // legacy[2] = shape 3 (in-conv, mod-out); legacy[3] = shape 4 (in-conv,
  // meta-tids, mod-out): the two that carry mod-out without mod-in and so land
  // those empty arrays in a different position. See the C7 report, Revision 2.
  const NAMED = new Set([2, 3]);
  // POJO / asJSON / gzip are mutually consistent, each verified against its own
  // bytes before the replacement is applied.
  const consistent = (item) => {
    assert.equal(item.asJSON, JSON.stringify(item.asPOJO));
    assert.equal(
      zlib.gunzipSync(item.asBufferOfGzippedJson).toString("utf8"),
      item.asJSON
    );
  };
  const corrected = await presentServed(CORRECTED);
  consistent(corrected);
  const correctedKeys = Object.keys(JSON.parse(corrected.asJSON));
  let named = 0;
  for (let i = 0; i < shapes.legacy.length; i++) {
    const legacy = await presentServed(shapes.legacy[i]);
    consistent(legacy);
    const a = correctedKeys;
    const b = Object.keys(JSON.parse(legacy.asJSON));
    // Complete key sets equal; the three appended values are all [].
    assert.deepEqual([...a].sort(), [...b].sort());
    const dl = decodePresented(legacy);
    for (const k of APPENDED) assert.deepEqual(dl[k], []);
    // Every OTHER key keeps its relative order across the cutover.
    assert.deepEqual(
      a.filter((k) => !APPENDED.includes(k)),
      b.filter((k) => !APPENDED.includes(k))
    );
    // The served comment fields are unchanged (value-exact) — a changed count,
    // list or geometry still fails here.
    assert.deepEqual(dl.tids, [0, 1]);
    assert.equal(dl["n-cmts"], 2);
    assert.deepEqual(dl.pca.center, [0, 0]);
    assert.deepEqual(dl.pca["comment-extremity"], [0, 0]);
    if (NAMED.has(i)) {
      // The two named shapes: the key order differs, and (per the checks above)
      // only in the appended keys.
      assert.notDeepEqual(a, b);
      assert.notEqual(legacy.asJSON, corrected.asJSON);
      named++;
    } else {
      // Every other shape stays byte-identical — the replacement is narrow, not
      // a normalization of all shapes.
      assert.equal(legacy.asJSON, corrected.asJSON);
      assert.ok(
        legacy.asBufferOfGzippedJson.equals(corrected.asBufferOfGzippedJson)
      );
    }
  }
  assert.equal(named, 2);
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
