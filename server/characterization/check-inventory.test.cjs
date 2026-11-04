"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { applyPatch } = require("diff");
const { extract, migrate } = require("./route-inventory.cjs");
const { check } = require("./check-inventory.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-census-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "server/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "server/characterization"));
  const source = path.join(root, "server/app.ts");
  fs.writeFileSync(
    source,
    'const app = express();\napp.get("/example", authenticate, handler);\n'
  );
  const current = extract(root);
  const inventory = migrate(
    { version: 2, routes: [], retired: [] },
    current.routes,
    {
      source_commit: "a".repeat(40),
      source_sha256: current.source_sha256,
    }
  ).inventory;
  const file = path.join(root, "server/characterization/inventory.json");
  const save = () =>
    fs.writeFileSync(file, JSON.stringify(inventory, null, 2) + "\n");
  save();
  return { root, source, inventory, file, save };
}

test("an exact census passes without Git metadata or rewriting the file", (t) => {
  const f = fixture(t),
    before = fs.readFileSync(f.file);
  assert.equal(check(f.root).status, 0);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("an unlisted source route fails with a unified diff", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.source, 'app.get("/added", handler);\n');
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(
    result.diff,
    /--- committed route census\s+\+\+\+ regenerated route census\s+@@/
  );
  assert.match(result.diff, /\+.*"path": "\/added"/);
  assert.match(result.message, /GET \/added \(id 2\): added/);
});

test("middleware drift fails even when the route identity is unchanged", (t) => {
  const f = fixture(t);
  f.inventory.routes[0].middleware = ["oldAuthentication"];
  f.save();
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(result.diff, /-.*oldAuthentication/);
  assert.match(result.diff, /\+.*authenticate/);
  assert.match(result.message, /GET \/example \(id 1\): middleware/);
});

test("registration positions and source hashes are checked", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "\n" + fs.readFileSync(f.source, "utf8"));
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(result.diff, /\+.*server\/app.ts:3/);
  assert.match(result.diff, /\+.*source_sha256/);
  assert.match(
    result.message,
    /No route changed; only registration lines, source metadata or JSON formatting differ/
  );
});

test("retirement must be recorded and existing IDs remain stable", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "const app = express();\n");
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(result.diff, /\+.*"retired": \[/);
  const regenerated = JSON.parse(
    applyPatch(fs.readFileSync(f.file, "utf8"), result.diff)
  );
  assert.equal(regenerated.retired[0].id, 1);
  assert.match(result.message, /GET \/example \(id 1\): retired/);
});

test("formatting drift also fails the byte comparison", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify(f.inventory));
  assert.equal(check(f.root).status, 1);
});

test("invalid route identities cannot pass by regeneration", (t) => {
  const f = fixture(t);
  f.inventory.routes.push({ ...f.inventory.routes[0] });
  f.save();
  assert.throws(
    () => check(f.root),
    /duplicate\/invalid stable route identity/
  );
});

test("failure explains dependencies and gives the exact regeneration command", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.source, "// comment only\n");
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(result.message, /No route changed/);
  assert.ok(
    result.message.includes("npm ci --ignore-scripts --no-audit --no-fund")
  );
  assert.ok(
    result.message.includes(
      'out="$(mktemp -d)/census" && node server/characterization/route-inventory.cjs . server/characterization/inventory.json "$out" "$(git rev-parse HEAD)" && cp "$out/inventory.json" server/characterization/inventory.json'
    )
  );
});

test("reactivation names the route and its stable ID", (t) => {
  const f = fixture(t);
  f.inventory.retired = [
    { ...f.inventory.routes[0], registered_in_default_config: false },
  ];
  f.inventory.routes = [];
  f.save();
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(
    result.message,
    /GET \/example \(id 1\): reactivated, registered_in_default_config/
  );
});

test("changed route fields are named together", (t) => {
  const f = fixture(t);
  Object.assign(f.inventory.routes[0], {
    auth: "old-auth",
    conditions: ["old-condition"],
    registered_in_default_config: false,
  });
  f.save();
  assert.match(
    check(f.root).message,
    /GET \/example \(id 1\): auth, conditions, registered_in_default_config/
  );
});

test("route reordering is not reported as metadata-only drift", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.source, 'app.get("/second", handler);\n');
  const current = extract(f.root);
  f.inventory.routes = migrate(f.inventory, current.routes).inventory.routes;
  f.inventory.source_sha256 = current.source_sha256;
  f.save();
  fs.writeFileSync(
    f.source,
    'const app = express();\napp.get("/second", handler);\napp.get("/example", authenticate, handler);\n'
  );
  const result = check(f.root);
  assert.equal(result.status, 1);
  assert.match(result.message, /Route order changed: 1, 2 -> 2, 1/);
  assert.doesNotMatch(result.message, /No route changed/);
});
