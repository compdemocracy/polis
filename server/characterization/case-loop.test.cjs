"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { executeCases } = require("./case-loop.cjs"),
  { retryRead } = require("./read-retry.cjs");
const path = require("node:path"),
  { createRequire } = require("node:module");
// Dispatch tools run from control; npm ci installs only target/server.
const repo =
  process.env.P027_ACCOUNTING_REPO || path.resolve(__dirname, "../..");
const targetRequire = createRequire(path.resolve(repo, "server/package.json"));
const { ScanCommand } = targetRequire("@aws-sdk/client-dynamodb");
for (const exhausted of [false, true])
  test(
    "post-request DNS " +
      (exhausted ? "exhaustion preserves prefix" : "recovery preserves order"),
    async () => {
      const planned = [1, 2, 3].map((id) => ({
        caseId: String(id),
        request: { method: "POST", body: { id } },
      }));
      const original = JSON.stringify(planned),
        sent = [],
        effects = [],
        visible = [],
        retries = [];
      const result = await executeCases(
        planned,
        async (c) => {
          sent.push(c);
          effects.push(c.request.body.id);
          let attempts = 0;
          if (c.caseId === "2")
            await retryRead(
              new ScanCommand({ TableName: "fixture" }),
              async () => {
                if (++attempts < 3 || exhausted)
                  throw Object.assign(Error(), { code: "EAI_AGAIN" });
                return {};
              },
              (event) => retries.push({ caseId: c.caseId, ...event }),
              { enabled: true, pause: async () => {} }
            );
          return c;
        },
        (c) => {
          visible.push(c.caseId);
          return false;
        },
        () => "after-request"
      );
      assert.equal(JSON.stringify(planned), original);
      assert.deepEqual(effects, exhausted ? [1, 2] : [1, 2, 3]);
      assert.ok(sent.every((c, i) => c === planned[i]));
      assert.deepEqual(visible, exhausted ? ["1"] : ["1", "2", "3"]);
      assert.deepEqual(
        result.results.map((c) => c.caseId),
        visible
      );
      assert.equal(retries.length, 3);
      assert.deepEqual(
        result.fatal,
        exhausted
          ? {
              caseId: "2",
              phase: "after-request",
              code: "SNAPSHOT_DNS_RETRY_EXHAUSTED",
            }
          : null
      );
    }
  );
test("first-case infrastructure failure yields a failed empty prefix", async () => {
  const result = await executeCases(
    [{ caseId: "one" }],
    async () => {
      throw Error("private text");
    },
    () => assert.fail(),
    () => "before-request"
  );
  assert.deepEqual(result, {
    results: [],
    fatal: {
      caseId: "one",
      phase: "before-request",
      code: "CASE_EXECUTION_FAILED",
    },
  });
});
test("requested stop preserves only the completed prefix", async () => {
  const cases = [{ caseId: "one" }, { caseId: "two" }];
  const r = await executeCases(
    cases,
    async (c) => c,
    () => true,
    () => "after-request"
  );
  assert.deepEqual(r.results, cases.slice(0, 1));
  assert.equal(r.fatal, null);
});
