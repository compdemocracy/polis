"use strict";
// The refusal of stores that are not the harness's own (safety.cjs), and the
// harness refusing a developer's dev stores before opening any connection.
//   node --test characterization/collective-statement/expected.test.cjs characterization/collective-statement/safety.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const s = require("./safety.cjs");

const OWN_PG = "postgres://postgres:generatedlocal@127.0.0.1:5481/postgres";
const OWN_DY = "http://127.0.0.1:8481";

test("the harness's own ports on loopback pass", () => {
  assert.deepEqual(s.checkUrls(OWN_PG, OWN_DY), []);
});

test("a developer's dev DynamoDB (localhost:8000) and dev Postgres (5432) are refused", () => {
  assert.deepEqual(s.checkUrls(OWN_PG, "http://localhost:8000"), [
    "DynamoDB port 8000 is not the harness's 8481",
  ]);
  assert.deepEqual(
    s.checkUrls("postgres://postgres:x@localhost:5432/polis-dev", OWN_DY),
    ["Postgres port 5432 is not the harness's 5481"]
  );
  assert.equal(
    s.checkUrls(OWN_PG, "http://dynamodb.us-east-1.amazonaws.com").length,
    2
  );
});

test("a Postgres server holding other databases is refused", () => {
  assert.deepEqual(
    s.checkPgDatabases(["postgres", "template0", "template1", "csrec"]),
    []
  );
  assert.equal(s.checkPgDatabases(["postgres", "polis-dev"]).length, 1);
});

test("DynamoDB: empty is claimed, the sentinel passes, data without the sentinel is refused", () => {
  assert.deepEqual(s.checkDynamoTables([]), { claim: true, problems: [] });
  assert.deepEqual(s.checkDynamoTables([s.SENTINEL, "Delphi_JobQueue"]), {
    claim: false,
    problems: [],
  });
  const dev = s.checkDynamoTables([
    "Delphi_JobQueue",
    "Delphi_CollectiveStatement",
  ]);
  assert.equal(dev.claim, false);
  assert.equal(dev.problems.length, 1);
});

test("main.cjs refuses DYNAMODB_ENDPOINT=http://localhost:8000 before connecting to anything", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, "main.cjs"), "replay"],
    {
      env: {
        PATH: process.env.PATH,
        CSREC_PG_ADMIN_URL: OWN_PG,
        DYNAMODB_ENDPOINT: "http://localhost:8000",
      },
      encoding: "utf8",
    }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to run/);
  assert.match(r.stderr, /DynamoDB port 8000/);
});
