"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { retryRead } = require("./read-retry.cjs");
const {
  ScanCommand,
  ListTablesCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
for (const Command of [ScanCommand, ListTablesCommand]) {
  test(
    Command.name + " repeats only the same failed read after completed request",
    async () => {
      const command = new Command({
        TableName: "fixture",
        ExclusiveStartKey: { id: { S: "page2" } },
      });
      const input = JSON.stringify(command.input),
        events = [],
        delays = [],
        seen = [];
      let sends = 0,
        effect = 0;
      // The request has already completed. Retrying the observation cannot replay it.
      const request = () => {
        sends++;
        effect++;
      };
      request();
      const result = await retryRead(
        command,
        async (c) => {
          seen.push(c);
          assert.equal(JSON.stringify(c.input), input);
          if (seen.length < 3)
            throw Object.assign(Error("fixture DNS text"), {
              code: "EAI_AGAIN",
            });
          return { Items: [effect] };
        },
        (e) => events.push(e),
        { enabled: true, pause: async (ms) => delays.push(ms) }
      );
      assert.equal(sends, 1);
      assert.equal(effect, 1);
      assert.deepEqual(result.Items, [1]);
      assert.ok(seen.every((c) => c === command));
      assert.deepEqual(delays, [100, 500]);
      assert.deepEqual(
        events.map((e) => e.outcome),
        ["EAI_AGAIN", "EAI_AGAIN", "recovered"]
      );
      assert.ok(!JSON.stringify(events).includes("fixture DNS text"));
    }
  );
}
test("exhausted read fails after exactly three calls with visible attempts", async () => {
  let calls = 0;
  const events = [];
  await assert.rejects(
    retryRead(
      new ScanCommand({}),
      async () => {
        calls++;
        throw Object.assign(Error(), { cause: { code: "EAI_AGAIN" } });
      },
      (e) => events.push(e),
      { enabled: true, pause: async () => {} }
    ),
    /SNAPSHOT_DNS_RETRY_EXHAUSTED/
  );
  assert.equal(calls, 3);
  assert.deepEqual(
    events.map((x) => x.attempt),
    [1, 2, 3]
  );
  assert.equal(events[2].outcome, "exhausted");
});
for (const code of ["AccessDeniedException", "ECONNRESET", "ENOTFOUND"])
  test(code + " is not retried", async () => {
    let calls = 0;
    await assert.rejects(
      retryRead(
        new ScanCommand({}),
        async () => {
          calls++;
          throw Object.assign(Error(code), { code });
        },
        () => assert.fail(),
        { enabled: true }
      ),
      new RegExp(code)
    );
    assert.equal(calls, 1);
  });
test("mutating commands are refused before send", async () => {
  await assert.rejects(
    retryRead(
      new PutItemCommand({}),
      () => assert.fail(),
      () => {},
      { enabled: true }
    ),
    /OPERATION_REFUSED/
  );
});
test("changed paging input cannot be retried", async () => {
  const c = new ScanCommand({ TableName: "fixture" });
  let calls = 0;
  await assert.rejects(
    retryRead(
      c,
      async () => {
        calls++;
        c.input.TableName = "changed";
        throw Object.assign(Error(), { code: "EAI_AGAIN" });
      },
      () => {},
      { enabled: true, pause: async () => {} }
    ),
    /INPUT_CHANGED/
  );
  assert.equal(calls, 1);
});
test("record mode keeps its single-attempt behavior", async () => {
  let calls = 0;
  await assert.rejects(
    retryRead(
      new ScanCommand({}),
      async () => {
        calls++;
        throw Object.assign(Error("dns"), { code: "EAI_AGAIN" });
      },
      () => assert.fail(),
      { enabled: false }
    ),
    /dns/
  );
  assert.equal(calls, 1);
});
