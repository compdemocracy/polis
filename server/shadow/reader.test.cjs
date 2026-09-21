const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { admitQuery, install } = require("./snapshot-pool.cjs");
const { BUILD_ROOTS, RUNTIME_ASSETS, projectAssets, canonical, handler, privateFile, verifyFiles, census, admitClosure, fenceModules, settingsFor } = require("./reader.cjs");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

test("read SQL admits parameters, quoted punctuation and comments without changing bytes", () => {
  for (const text of ["SELECT * FROM math_main WHERE zid=$1;", "WITH rows AS (SELECT 1) SELECT * FROM rows",
    "/* public */ SELECT ';COMMIT', \"value\" FROM comments -- public\n"])
    assert.equal(admitQuery(text), text);
});

test("transaction changes and writes refuse before reaching the database", () => {
  for (const text of ["COMMIT", "SELECT 1; ROLLBACK", "BEGIN READ WRITE", "SET ROLE writer",
    "WITH changed AS (DELETE FROM comments RETURNING *) SELECT * FROM changed", "COPY comments TO STDOUT",
    "SELECT $$unparsed$$", "SELECT 'unterminated", "/* nested /* */ SELECT 1"])
    assert.throws(() => admitQuery(text), /SHADOW_QUERY/);
});

test("query objects and cursor objects retain the same SQL gate", () => {
  assert.equal(admitQuery({ text: "SELECT $1" }), "SELECT $1");
  assert.throws(() => admitQuery({ cursor: { text: "SELECT $1" } }), /SHADOW_QUERY/);
  assert.throws(() => admitQuery({ submit() {} }), /SHADOW_QUERY/);
});

test("a pool connection is not exposed until its read-only snapshot is imported", async () => {
  const calls = [];
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const client = { release() {}, async query(sql) {
    calls.push(sql);
    if (sql.startsWith("SET TRANSACTION SNAPSHOT")) await ready;
    return { rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] };
  } };
  const pg = { Pool: class { async connect() { return client; } }, Client: class {} };
  const Pool = install(pg, "00000003-00000004-1");
  let exposed = false;
  const pending = new Pool().connect().then((value) => { exposed = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exposed, false);
  release();
  const admitted = await pending;
  assert.notEqual(admitted, client);
  assert.equal(admitted.connection, undefined);
  assert.match(calls[0], /REPEATABLE READ READ ONLY/);
  await assert.rejects(admitted.query("COMMIT"), /SHADOW_QUERY/);
  assert.throws(() => new pg.Client(), /SHADOW_DIRECT_CLIENT/);
});

test("snapshot import failure destroys the client without exposing it", async () => {
  const releases = [];
  const pg = { Pool: class { async connect() { return {
    query: async () => { throw Error("public connection refusal"); },
    release: (destroy) => releases.push(destroy),
  }; } } };
  const Pool = install(pg, "00000003-00000004-1");
  await assert.rejects(new Pool().connect(), /SHADOW_SNAPSHOT_IMPORT/);
  assert.deepEqual(releases, [true]);
});

test("callback callers also wait for imported snapshot admission", async () => {
  const pg = { Pool: class { async connect() { return {
    query: async () => ({ rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] }), release() {},
  }; } } };
  const Pool = install(pg, "00000003-00000004-1");
  await new Promise((resolve, reject) => new Pool().connect((error, client, release) => {
    if (error) return reject(error);
    assert.equal(client.connection, undefined);
    assert.equal(typeof client.query, "function");
    assert.equal(typeof release, "function");
    resolve();
  }));
});

test("request admission passes the original request to the unchanged app", () => {
  const req = { method: "GET", url: "/api/v3/pca2?conversation_id=7Public", headers: { accept: "application/json" } };
  const digest = hash(canonical({ method: "GET", path: req.url, headers: req.headers }));
  let actual;
  handler((request) => { actual = request; }, [digest])(req, {});
  assert.equal(actual, req);
});

test("unknown request, method, credential or body refuses before app entry", () => {
  let calls = 0;
  const route = handler(() => { calls++; }, ["0".repeat(64)]);
  for (const req of [
    { method: "GET", url: "/api/v3/pca2", headers: {} },
    { method: "POST", url: "/api/v3/pca2", headers: {} },
    { method: "GET", url: "/api/v3/pca2", headers: { authorization: "Bearer other-public-fixture" } },
    { method: "GET", url: "/api/v3/pca2", headers: { "content-length": "1" } },
  ]) {
    let status, body;
    route(req, { writeHead(value) { status = value; }, end(value) { body = value; } });
    assert.equal(status, 403);
    assert.equal(body, '{"code":"SHADOW_ROUTE"}');
  }
  assert.equal(calls, 0);
});

test("private files refuse shared modes and symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-reader-"));
  try {
    const file = path.join(root, "profile.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    assert.equal(privateFile(file).toString(), "{}");
    fs.chmodSync(file, 0o644);
    assert.throws(() => privateFile(file), /SHADOW_PRIVATE_FILE/);
    fs.symlinkSync(file, path.join(root, "alias"));
    assert.throws(() => privateFile(path.join(root, "alias")), /SHADOW_PRIVATE_FILE/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("build manifests compare exact file bytes and refuse traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-build-"));
  try {
    fs.writeFileSync(path.join(root, "app.js"), "public bytes");
    const manifest = { "app.js": hash("public bytes") };
    assert.equal(verifyFiles(root, manifest), hash(canonical(manifest)));
    fs.appendFileSync(path.join(root, "app.js"), "changed");
    assert.throws(() => verifyFiles(root, manifest), /SHADOW_BUILD/);
    assert.throws(() => verifyFiles(root, { "../outside": hash("public bytes") }), /SHADOW_BUILD/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("canonical string maps match Python ASCII escaping and code point ordering", () => {
  assert.equal(canonical({ "😀": "café\u007f", "\ue000": "line\n" }),
    '{"\\ue000":"line\\n","\\ud83d\\ude00":"caf\\u00e9\\u007f"}');
});

test("session-changing functions refuse even through quoted identifiers", () => {
  for (const sql of ["SELECT set_config('transaction_read_only','off',false)",
    'SELECT "set_config"($1,$2,$3)', "SELECT pg_notify($1,$2)", "SELECT lo_export(1,$1)",
    "SELECT pg_advisory_lock(1)", "SELECT dblink($1,$2)"])
    assert.throws(() => admitQuery(sql), /SHADOW_QUERY/);
});

function tree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shadow-closure-")));
  for (const [relative, bytes] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
  function modes(directory, writable) {
    fs.chmodSync(directory, writable ? 0o700 : 0o500);
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name), info = fs.lstatSync(filename);
      if (info.isDirectory()) modes(filename, writable);
      else if (!info.isSymbolicLink()) fs.chmodSync(filename, writable ? 0o600 : 0o400);
    }
  }
  return { root, freeze: () => modes(root, false), thaw: () => modes(root, true),
    remove() { modes(root, true); fs.rmSync(root, { recursive: true }); } };
}
function closureProfile(root) {
  const build_manifest = census(root, BUILD_ROOTS);
  const dependency_manifest = census(root, ["node_modules"]);
  return { app_root: root, app_entry: "dist/app.js", build_manifest, dependency_manifest,
    node_build: hash(canonical(build_manifest)), node_dependencies: hash(canonical(dependency_manifest)) };
}
const minimalFiles = { "dist/app.js": "module.exports = {};", "package.json": "{}",
  "package-lock.json": "{}", "node_modules/library/index.js": "module.exports = 1;",
  "src/prompts/moderation/script.xml": "<script>public prompt</script>\n",
  "src/prompts/report_experimental/system.xml": "<system>public lore</system>\n" };

test("closure requires every build and dependency file, not just listed hashes", () => {
  const fixture = tree(minimalFiles);
  try {
    const profile = closureProfile(fixture.root);
    fixture.freeze();
    assert.equal(admitClosure(profile).build, profile.node_build);
    for (const key of ["build_manifest", "dependency_manifest"]) {
      const changed = { ...profile, [key]: { ...profile[key] } };
      delete changed[key][Object.keys(changed[key])[0]];
      assert.throws(() => admitClosure(changed), /SHADOW_BUILD/);
    }
    fixture.thaw();
    fs.writeFileSync(path.join(fixture.root, "node_modules/library/hidden.js"), "unlisted");
    fixture.freeze();
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
  } finally { fixture.remove(); }
});

test("closure refuses writable files, directories and mismatched aggregate bindings", () => {
  const fixture = tree(minimalFiles);
  try {
    const profile = closureProfile(fixture.root);
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
    fixture.freeze();
    fs.chmodSync(path.join(fixture.root, "dist/app.js"), 0o600);
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
    fixture.freeze();
    fs.chmodSync(path.join(fixture.root, "node_modules/library"), 0o700);
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
    fixture.freeze();
    assert.throws(() => admitClosure({ ...profile, node_dependencies: "0".repeat(64) }), /SHADOW_BUILD/);
  } finally { fixture.remove(); }
});

test("internal file links bind link text; directory and escaping links refuse", () => {
  const fixture = tree(minimalFiles), outside = tree({ "outside.js": "public bytes" });
  try {
    fs.symlinkSync("index.js", path.join(fixture.root, "node_modules/library/alias.js"));
    const profile = closureProfile(fixture.root);
    assert.equal(profile.dependency_manifest["node_modules/library/alias.js"], hash(canonical({ symlink: "index.js" })));
    fixture.freeze();
    admitClosure(profile);
    fixture.thaw();
    fs.symlinkSync("library", path.join(fixture.root, "node_modules/alias"));
    assert.throws(() => census(fixture.root, ["node_modules"]), /SHADOW_BUILD/);
    assert.throws(() => verifyFiles(fixture.root, { "node_modules/alias/index.js": hash(minimalFiles["node_modules/library/index.js"]) }), /SHADOW_BUILD/);
    fs.unlinkSync(path.join(fixture.root, "node_modules/alias"));
    fs.symlinkSync(path.join(outside.root, "outside.js"), path.join(fixture.root, "node_modules/library/escape"));
    assert.throws(() => census(fixture.root, ["node_modules"]), /SHADOW_BUILD/);
  } finally { fixture.remove(); outside.remove(); }
});

test("module resolution refuses undeclared, modified and explicitly denied code", () => {
  const fixture = tree(minimalFiles);
  let restore;
  try {
    const profile = closureProfile(fixture.root);
    fixture.freeze();
    restore = fenceModules(fixture.root, { ...profile.build_manifest, ...profile.dependency_manifest },
      new Set([path.join(fixture.root, "node_modules/library/index.js")]));
    assert.equal(require.resolve("node:fs"), "node:fs");
    assert.throws(() => require.resolve(path.join(fixture.root, "node_modules/library/index.js")), /SHADOW_MODULE/);
    assert.throws(() => require.resolve(__filename), /SHADOW_MODULE/);
    fs.chmodSync(path.join(fixture.root, "dist/app.js"), 0o600);
    fs.writeFileSync(path.join(fixture.root, "dist/app.js"), "changed");
    fs.chmodSync(path.join(fixture.root, "dist/app.js"), 0o400);
    assert.throws(() => require.resolve(path.join(fixture.root, "dist/app.js")), /SHADOW_MODULE/);
  } finally { restore?.(); fixture.remove(); }
});

test("settings bind actual values and refuse runtime injection and background work", () => {
  const admitted = { NODE_ENV: "production", SERVER_LOG_LEVEL: "error", SERVER_LOG_TO_FILE: "false", PUBLIC_LABEL: "café" };
  assert.deepEqual(settingsFor({ settings: admitted, node_settings: hash(canonical(admitted)) }), admitted);
  for (const settings of [{ NODE_OPTIONS: "--require=other" }, { DATABASE_URL: "public" },
    { RUN_PERIODIC_EXPORT_TESTS: "true" }, { SERVER_LOG_TO_FILE: "yes" }, { PGHOST: "other" }, { HOME: "/tmp" }])
    assert.throws(() => settingsFor({ settings, node_settings: hash(canonical(settings)) }), /SHADOW_(SETTINGS|BACKGROUND_WORK)/);
  assert.throws(() => settingsFor({ settings: admitted, node_settings: "0".repeat(64) }), /SHADOW_SETTINGS/);
});

test("a known request still refuses changed transport authority and duplicate headers", () => {
  const request = { method: "GET", path: "/api/v3/math/pca2", headers: { accept: "application/json" } };
  const route = handler(() => assert.fail("app entered"), [hash(canonical(request))]);
  for (const extra of [{ headers: { ...request.headers, host: "other" } },
    { headers: request.headers, rawHeaders: ["Accept", "application/json", "accept", "application/json"] },
    { headers: { ...request.headers, "transfer-encoding": "chunked" } },
    { headers: { ...request.headers, "x-forwarded-host": "other" } }]) {
    route({ method: "GET", url: request.path, ...extra }, { writeHead(status) { assert.equal(status, 403); }, end() {} });
  }
});

test("pool overrides cannot replace TLS, credentials, Client or imported snapshot", async () => {
  let received, imports = 0, destroyed = 0;
  const rawClient = { connection: { secret: true }, release(value) { if (value) destroyed++; },
    async query(sql) { if (sql.startsWith("SET TRANSACTION SNAPSHOT")) imports++; return { rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] }; } };
  const bound = { host: "reader.example", password: "public-test-value", ssl: { rejectUnauthorized: true, ca: "public-test-ca" } };
  const Pool = install({ Pool: class { constructor(config) { received = config; } async connect() { return rawClient; } async end() {} } },
    "00000003-00000004-1", bound);
  const pool = new Pool({ host: "other", ssl: false, Client: class { constructor() { assert.fail("custom Client"); } } });
  const first = await pool.connect(); first.release();
  const second = await pool.connect();
  assert.equal(imports, 1);
  assert.equal(received.host, bound.host);
  assert.deepEqual(received.ssl, bound.ssl);
  assert.equal(received.Client, undefined);
  assert.equal(second.connection, undefined);
  assert.equal(pool._clients, undefined);
  await assert.rejects(first.query("SELECT 1"), /SHADOW_QUERY/);
  await pool.end();
  assert.equal(destroyed, 1);
  await assert.rejects(second.query("SELECT 1"), /SHADOW_QUERY/);
  await assert.rejects(pool.connect(), /SHADOW_SNAPSHOT_IMPORT/);
});

test("custom query submit and accessors cannot acquire a raw client", async () => {
  let submitted = 0, accessor = 0;
  const Pool = install({ Pool: class { async connect() { return {
    release() {}, async query() { return { rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] }; },
  }; } } }, "00000003-00000004-1");
  const client = await new Pool().connect();
  await assert.rejects(client.query({ text: "SELECT 1", submit() { submitted++; } }), /SHADOW_QUERY/);
  const getter = { text: "SELECT 1", get callback() { accessor++; return () => {}; } };
  await assert.rejects(client.query(getter), /SHADOW_QUERY/);
  assert.equal(submitted, 0); assert.equal(accessor, 0);
  await new Promise((resolve) => client.query("COMMIT", (error) => {
    assert.match(error.message, /SHADOW_QUERY/); resolve();
  }));
});

test("trusted query streams are reconstructed and pool-level streams refuse", async () => {
  class QueryStream { constructor(text, values, options = {}) { this.cursor = { text, values }; this.readableHighWaterMark = options.highWaterMark; } }
  let received;
  const Pool = install({ Pool: class { async connect() { return { release() {}, query(input) {
    if (input instanceof QueryStream) { received = input; return input; }
    return Promise.resolve({ rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] });
  } }; } } }, "00000003-00000004-1", {}, { QueryStream });
  const pool = new Pool(), client = await pool.connect();
  const input = new QueryStream("SELECT $1", [1], { highWaterMark: 16 });
  input.submit = () => assert.fail("caller submit");
  const stream = client.query(input);
  assert.equal(stream, received); assert.notEqual(stream, input);
  assert.equal(stream.submit, undefined); assert.deepEqual(stream.cursor.values, [1]);
  await assert.rejects(pool.query(input), /SHADOW_QUERY/);
});

test("failed callback connect provides safe release and elevated roles refuse", async () => {
  for (const rows of [[], [{ readonly: false, elevated: false }], [{ readonly: true, elevated: true }],
    [{ readonly: true, elevated: false, table_write: true, control_execute: false }],
    [{ readonly: true, elevated: false, table_write: false, control_execute: true }],
    [{ readonly: true, elevated: false }]]) {
    let destroyed = 0;
    const Pool = install({ Pool: class { async connect() { return { release(value) { if (value) destroyed++; },
      async query() { return { rows }; } }; } } }, "00000003-00000004-1");
    await new Promise((resolve) => new Pool().connect((error, client, release) => {
      assert.equal(error.message, "SHADOW_SNAPSHOT_IMPORT"); assert.equal(client, undefined);
      release(error); resolve();
    }));
    assert.equal(destroyed, 1);
  }
});

test("disabled bootstrap emits only a closed refusal code", () => {
  const { spawnSync } = require("node:child_process");
  const run = spawnSync(process.execPath, [path.join(__dirname, "reader.cjs")], { env: {}, encoding: "utf8" });
  assert.equal(run.status, 2); assert.equal(run.stdout, "");
  assert.equal(run.stderr, "SHADOW_READER_REFUSED\n");
});

test("stand-in app startup binds ready PID and hashes, suppresses logs and removes its socket", async () => {
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const http = require("node:http");
  const fixture = tree({ ...minimalFiles,
    "dist/src/config.js": "exports.default = {};",
    "dist/app.js": `const pg = require('pg'); new pg.Pool({ssl:false});
      if (process.env.AMBIENT_MARKER || process.env.NODE_ENV !== 'production') throw Error('unbound environment');
      console.log('PRIVATE_LOG_TEST'); console.error('PRIVATE_LOG_TEST');
      function app(req,res) { res.end('public-reader-response'); }
      app.routes = {get:[{path:'/api/v3/math/pca2'}]};
      exports.default=app; exports.appReady=(async()=>{
        const fs=require('node:fs');
        if (process.env.HOME !== process.cwd() || fs.existsSync('.env')) throw Error('ambient cwd');
        const values=await Promise.all(${JSON.stringify(RUNTIME_ASSETS)}.map(p=>require('node:fs/promises').readFile(p,'utf8')));
        if (JSON.stringify(values)!==${JSON.stringify(JSON.stringify(RUNTIME_ASSETS.map(p=>minimalFiles[p])))}) throw Error('asset bytes');
      })();`,
    "node_modules/pg/index.js": `exports.Pool=class {async connect(){return {
      async query(){return {rows:[{readonly:true,elevated:false,table_write:false,control_execute:false}]}}, release(){}
      }}; async end(){} }; exports.Client=class {};`,
    "node_modules/pg/lib/client.js": "module.exports = class {};",
    "node_modules/pg/lib/connection.js": "module.exports = class {};",
    "node_modules/pg-pool/index.js": "module.exports = class {};",
    "node_modules/pg-query-stream/index.js": "module.exports = class {};",
  });
  const control = tree({ "password": "public-test-password\n", "ca": "-----BEGIN CERTIFICATE-----\npublic-test-ca\n" });
  control.thaw();
  let child, exited, code;
  try {
    const settings = { NODE_ENV: "production" }, request = { method: "GET", path: "/api/v3/math/pca2", headers: {} };
    const profile = { ...closureProfile(fixture.root), schema: "polis-shadow-reader/1", settings,
      node_settings: hash(canonical(settings)), namespace: "public_namespace", snapshot: "00000003-00000004-1",
      database_host: "reader.example", socket: path.join(control.root, "reader.sock"), requests: [hash(canonical(request))] };
    fs.writeFileSync(path.join(control.root, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
    fixture.freeze();
    child = spawn(process.execPath, [path.join(__dirname, "reader.cjs")], { env: {
      SHADOW_READER_ENABLE: "1", SHADOW_READER_PROFILE: path.join(control.root, "profile.json"),
      SHADOW_READER_DATABASE_URL: "postgresql://reader@reader.example/public_db", AMBIENT_MARKER: "must-clear",
      SHADOW_READER_PASSWORD_FILE: path.join(control.root, "password"), SHADOW_READER_CA_FILE: path.join(control.root, "ca"),
    }, stdio: ["ignore", "pipe", "pipe"] });
    exited = once(child, "exit").then(([value]) => { code = value; });
    let output = "", error = "";
    child.stderr.on("data", (bytes) => { error += bytes; });
    const readyLine = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("ready timeout")), 5000);
      child.stdout.on("data", (bytes) => { output += bytes; if (output.includes("\n")) { clearTimeout(timeout); resolve(output); } });
      child.once("exit", () => { clearTimeout(timeout); reject(Error(`reader exited ${error}`)); });
    });
    const ready = JSON.parse(await readyLine);
    assert.equal(ready.schema, "polis-shadow-reader-ready/1"); assert.equal(ready.pid, child.pid);
    for (const key of ["node_build", "node_dependencies", "node_settings", "namespace", "snapshot"]) assert.equal(ready[key], profile[key]);
    assert.equal(fs.statSync(profile.socket).mode & 0o777, 0o600);
    const response = await new Promise((resolve, reject) => {
      const req = http.get({ socketPath: profile.socket, path: request.path, headers: { host: "localhost" } }, (res) => {
        let body = ""; res.on("data", (bytes) => { body += bytes; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      }); req.on("error", reject);
    });
    assert.deepEqual(response, { status: 200, body: "public-reader-response" });
    child.kill("SIGTERM"); await exited;
    assert.equal(code, 0); assert.equal(fs.existsSync(profile.socket), false);
    assert.equal(output.split("\n").filter(Boolean).length, 1); assert.equal(error, "");
    assert.equal(output.includes("PRIVATE_LOG_TEST"), false);
  } finally {
    if (child && code === undefined) { child.kill("SIGKILL"); await exited; }
    fixture.remove(); control.remove();
  }
});

test("pool query-config callback waits for query completion before release", async () => {
  let released = 0, complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const Pool = install({ Pool: class { async connect() { return {
    release() { released++; }, query(input) {
      if (typeof input === "object") return pending;
      return Promise.resolve({ rows: [{ readonly: true, elevated: false, table_write: false, control_execute: false }] });
    },
  }; } } }, "00000003-00000004-1");
  const finished = new Promise((resolve, reject) => new Pool().query({ text: "SELECT 1", callback(error, value) {
    if (error) return reject(error); assert.deepEqual(value, { rows: [1] }); resolve();
  } }));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(released, 0);
  complete({ rows: [1] }); await finished; assert.equal(released, 1);
});


test("eager runtime assets require exact bytes, both entries and immutable parents", () => {
  const fixture = tree(minimalFiles);
  try {
    const profile = closureProfile(fixture.root), relative = RUNTIME_ASSETS[0];
    fixture.freeze();
    const missing = { ...profile, build_manifest: { ...profile.build_manifest } };
    delete missing.build_manifest[relative];
    assert.throws(() => admitClosure(missing), /SHADOW_BUILD/);
    fs.chmodSync(path.join(fixture.root, "src/prompts"), 0o700);
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
    fixture.thaw();
    fs.writeFileSync(path.join(fixture.root, relative), "changed prompt"); fixture.freeze();
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
    fixture.thaw(); fs.unlinkSync(path.join(fixture.root, relative)); fixture.freeze();
    assert.throws(() => admitClosure(profile), /SHADOW_BUILD/);
  } finally { fixture.remove(); }
});

test("runtime assets refuse internal symlinks and oversized regular files", () => {
  const fixture = tree(minimalFiles), relative = RUNTIME_ASSETS[0];
  try {
    fs.unlinkSync(path.join(fixture.root, relative));
    fs.symlinkSync("../report_experimental/system.xml", path.join(fixture.root, relative));
    const linked = closureProfile(fixture.root); fixture.freeze();
    assert.throws(() => admitClosure(linked), /SHADOW_BUILD/);
    fixture.thaw(); fs.unlinkSync(path.join(fixture.root, relative));
    fs.writeFileSync(path.join(fixture.root, relative), Buffer.alloc(1024 * 1024 + 1));
    const large = closureProfile(fixture.root); fixture.freeze();
    assert.throws(() => admitClosure(large), /SHADOW_BUILD/);
  } finally { fixture.remove(); }
});

test("private projection contains only copied admitted assets and no ambient dotenv", () => {
  const fixture = tree({ ...minimalFiles, ".env": "AMBIENT_MARKER=must-not-read", "src/unbound.txt": "excluded" });
  const destination = tree({});
  try {
    const profile = closureProfile(fixture.root); fixture.freeze();
    const admitted = admitClosure(profile);
    projectAssets(destination.root, admitted.assets);
    assert.deepEqual(Object.keys(census(destination.root, ["src"])).sort(), [...RUNTIME_ASSETS].sort());
    assert.equal(fs.existsSync(path.join(destination.root, ".env")), false);
    for (const relative of RUNTIME_ASSETS) {
      const target = path.join(destination.root, relative);
      assert.deepEqual(fs.readFileSync(target), Buffer.from(minimalFiles[relative]));
      assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
      assert.equal(fs.statSync(target).mode & 0o777, 0o400);
      assert.notEqual(fs.statSync(target).ino, fs.statSync(path.join(fixture.root, relative)).ino);
    }
    assert.throws(() => projectAssets(destination.root, admitted.assets), /SHADOW_BUILD/);
  } finally { fixture.remove(); destination.remove(); }
});

test("projection refuses extra paths, shared directories and linked destinations", () => {
  const fixture = tree(minimalFiles), destination = tree({}), link = tree({});
  try {
    const profile = closureProfile(fixture.root); fixture.freeze();
    const { assets } = admitClosure(profile);
    assert.throws(() => projectAssets(destination.root, { ...assets, ".env": Buffer.from("unbound") }), /SHADOW_BUILD/);
    fs.chmodSync(destination.root, 0o755);
    assert.throws(() => projectAssets(destination.root, assets), /SHADOW_BUILD/);
    fs.chmodSync(destination.root, 0o700);
    fs.symlinkSync(destination.root, path.join(link.root, "alias"));
    assert.throws(() => projectAssets(path.join(link.root, "alias"), assets), /SHADOW_BUILD/);
    assert.deepEqual(fs.readdirSync(destination.root), []);
  } finally { fixture.remove(); destination.remove(); link.remove(); }
});
