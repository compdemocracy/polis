"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fixture = require("./recordings.json");
const { differences } = require("./compare.cjs");
test("fixture compares exactly, including both race responses", () => {
  assert.deepEqual(differences(fixture, structuredClone(fixture)), []);
  const race = fixture.recordings.find((r) => r.case === "race-two-accepts");
  assert.deepEqual(
    race.responses.map((r) => r.status),
    [400, 201]
  );
  assert.equal(race.proof.users, 2);
  assert.equal(race.proof.participants, 2);
  assert.equal(race.proof.loser.member, true);
  assert.equal(race.proof.loser.login, false);
});
for (const [name, mutate] of [
  ["status", (r) => (r.responses[0].status = 418)],
  [
    "surrounding response bytes",
    (r) =>
      (r.responses[0].body_base64 =
        Buffer.from(' {"changed":true}').toString("base64")),
  ],
  ["header order", (r) => r.responses[0].headers.reverse()],
  ["database row", (r) => r.after["pg:participants"].pop()],
  ["loser membership", (r) => (r.proof.loser.member = false)],
])
  test(`comparison refuses changed ${name}`, () => {
    const changed = structuredClone(fixture);
    mutate(changed.recordings.find((r) => r.case === "race-two-accepts"));
    assert.equal(differences(fixture, changed).length, 1);
  });
test("comparison refuses inventory and policy drift", () => {
  const changed = structuredClone(fixture);
  changed.recordings.pop();
  assert.throws(() => differences(fixture, changed), /case inventory/);
  changed.recordings = fixture.recordings;
  changed.comparison.version++;
  assert.throws(() => differences(fixture, changed), /comparison policy/);
});
test("all nine registrations have a success and refusal", () => {
  const routes = new Map();
  for (const r of fixture.recordings) {
    if (r.request.method === "HEAD") continue;
    const key = r.request.method + " " + r.request.path;
    const statuses = routes.get(key) || [];
    statuses.push(...r.responses.map((s) => s.status));
    routes.set(key, statuses);
    for (const response of r.responses) {
      const text = Buffer.from(response.body_base64, "base64").toString();
      if (text.startsWith("{")) {
        const body = JSON.parse(text);
        if (body.login_code) assert.match(body.login_code, /^\$login_code:/);
        if (body.auth) assert.match(body.auth.token, /^\$jwt:/);
      }
    }
  }
  assert.equal(routes.size, 9);
  for (const [route, statuses] of routes) {
    assert.ok(
      statuses.some((s) => s >= 200 && s < 300),
      route + " success"
    );
    assert.ok(
      statuses.some((s) => s >= 400),
      route + " refusal"
    );
  }
});
