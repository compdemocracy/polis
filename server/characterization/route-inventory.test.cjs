"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { migrate, validate } = require("./route-inventory.cjs");
const current = require("./inventory.json");
const route = (id, path) => ({
  id,
  method: "GET",
  path,
  registration: "server/app.ts:1",
  middleware: [],
  auth: "none",
  conditions: [],
  registered_in_default_config: true,
});
test("insert and reorder preserve IDs, retirement never reuses an ID", () => {
  const prior = {
    version: 2,
    routes: [route(1, "/a"), route(2, "/b")],
    retired: [],
  };
  const first = migrate(prior, [route(99, "/b"), route(99, "/c")]);
  assert.deepEqual(
    first.inventory.routes.map((r) => r.id),
    [2, 3]
  );
  assert.deepEqual(first.diff.retired, [1]);
  const again = migrate(first.inventory, [
    route(99, "/c"),
    route(99, "/a"),
    route(99, "/d"),
  ]);
  assert.deepEqual(
    again.inventory.routes.map((r) => r.id),
    [3, 1, 4]
  );
  assert.deepEqual(again.diff.reactivated, [1]);
  assert.deepEqual(
    again.inventory.retired.map((r) => r.id),
    [2]
  );
  const same = migrate(again.inventory, again.inventory.routes);
  assert.deepEqual(same.inventory, again.inventory);
  assert.equal(same.diff.changed.length, 0);
});
test("source line and middleware changes do not change an unambiguous route ID", () => {
  const prior = { version: 2, routes: [route(22, "/a")], retired: [] };
  const result = migrate(prior, [
    {
      ...route(0, "/a"),
      registration: "server/app.ts:999",
      middleware: ["auth()"],
    },
  ]);
  assert.equal(result.inventory.routes[0].id, 22);
  assert.deepEqual(result.diff.changed[0].fields, ["middleware"]);
});
test("duplicate identities and IDs fail closed", () => {
  assert.throws(
    () =>
      migrate({ version: 2, routes: [], retired: [] }, [
        route(1, "/a"),
        route(2, "/a"),
      ]),
    /ambiguous/
  );
  assert.throws(
    () => validate({ routes: [route(1, "/a"), route(1, "/b")] }),
    /identity/
  );
  assert.throws(
    () => validate({ routes: [route(1, "/a")], retired: [route(2, "/a")] }),
    /identity/
  );
  assert.throws(
    () => validate({ routes: [], retired: [route(1, "/a")] }),
    /enabled/
  );
});
test("every historical identity survives migration as live or retired", () => {
  validate(current);
  const all = [...current.routes, ...current.retired];
  for (let id = 1; id <= 201; id++)
    assert.equal(all.filter((r) => r.id === id).length, 1);
  assert.deepEqual(
    current.retired.map((r) => r.id),
    [
      21, 25, 39, 132, 133, 134, 140, 141, 142, 143, 144, 147,
      149, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168,
      169, 170, 171, 172, 173, 190, 192, 2, 127, 128, 136, 137,
      138, 139, 153, 154, 185, 186, 187, 188, 189, 194, 195, 196,
      200, 201, 4, 6, 7, 9, 13, 17, 27, 28, 38, 101,
      125, 130, 131,
    ]
  );
  assert.equal(
    current.routes.filter((r) => r.method === "ALL" && r.path === "/api/v3/*")
      .length,
    2
  );
});
test("retired routes are reported separately and never generated", () => {
  const { coverage } = require("./core.cjs"),
    { generate } = require("./generate.cjs"),
    scope = require("./scope.json");
  const cases = generate(current, scope);
  const retiredIds = new Set(current.retired.map((r) => r.id));
  assert.ok(!cases.some((c) => retiredIds.has(c.routeId)));
  const cov = coverage(current, scope, cases);
  assert.equal(cov.retired.length, current.retired.length);
  assert.ok(cov.retired.every((r) => r.status === "RETIRED"));
  for (const id of [202, 203, 204, 205, 206, 207])
    assert.equal(cases.filter((c) => c.routeId === id).length, 4);
});

test("legacy migration binds every old ID to the same method/path and selector", () => {
  const legacy = require("./inventory-legacy.json");
  const result = migrate(legacy, current.routes);
  for (const old of legacy.routes) {
    const kept = [...result.inventory.routes, ...result.inventory.retired].find(
      (r) => r.id === old.id
    );
    assert.equal(kept.method, old.method);
    assert.equal(kept.path, old.path);
  }
  assert.deepEqual(
    result.inventory.routes.map((r) => r.id),
    current.routes.map((r) => r.id)
  );
});
