"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express");
const { trackMounts, routeIds } = require("./route-observation.cjs");
const { extract } = require("./route-inventory.cjs");
const mountedRoutes = trackMounts(express);
const inventory = require("./inventory.json");

test("stable hit identities survive census order changes and another mounted app", () => {
  const hits = [
    { method: "ALL", path: "/api/v3/*", callback: "addCorsHeader" },
    { method: "ALL", path: "/api/v3/*", callback: "middleware_check_if_options" },
    { method: "POST", path: "/api/v3/votes", callback: "vote" },
  ];
  const expected = [1, 3, 77];
  assert.deepEqual(routeIds(hits, inventory), expected);
  assert.deepEqual(routeIds(hits, { routes: [
    { id: 10000, method: "POST", path: "/recording-example", registered_in_default_config: true },
    ...inventory.routes.toReversed(),
  ] }), expected);
  assert.deepEqual(routeIds([...hits, hits[2]], inventory), expected);
});

test("unknown, disabled and ambiguous hits cannot silently become missing IDs", () => {
  assert.throws(() => routeIds([{ method: "GET", path: "/absent" }], inventory), /0 census matches/);
  assert.throws(() => routeIds([{ method: "ALL", path: "/api/v3/*", callback: "other" }], inventory), /0 census matches/);
  const hit = { method: "POST", path: "/api/v3/votes" };
  assert.throws(() => routeIds([hit], { routes: inventory.routes.map(r => ({...r, registered_in_default_config: false})) }), /0 census matches/);
  const duplicate = { ...inventory.routes.find(r => r.id === 77), discriminator: "callback:vote" };
  assert.throws(() => routeIds([{...hit, callback:"vote"}], { routes: [duplicate, {...duplicate, id:999}] }), /2 census matches/);
});

test("runtime census includes nested mounted applications but excludes unattached ones", () => {
  const root = express(), child = express(), nested = express(), unattached = express();
  const reply = (req, res) => res.end();
  root.get("/root", reply);
  child.post("/child", reply);
  nested.get("/nested", reply);
  unattached.get("/unused", reply);
  child.use(nested);
  root.use(child);
  assert.deepEqual(mountedRoutes(root).map(r => r.path).sort(), ["/child", "/nested", "/root"]);
  root.use(child);
  assert.throws(() => mountedRoutes(root), /repeated/);
});

test("source census discovers mounted application names and retains registration order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-observation-"));
  try {
    fs.mkdirSync(path.join(root, "server/src"), { recursive: true });
    const file = path.join(root, "server/app.ts");
    const source = 'const app = express(); const extra = express(); const unused = express(); extra.post("/extra", handler); unused.get("/unused", handler); app.use(extra); app.get("/main", handler);';
    fs.writeFileSync(file, source);
    assert.deepEqual(extract(root).routes.map(r => r.path), ["/extra", "/main"]);
    fs.writeFileSync(file, source.replace("app.use(extra)", 'app.use("/prefix", extra)'));
    assert.throws(() => extract(root), /mount prefix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
