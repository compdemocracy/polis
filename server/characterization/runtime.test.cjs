"use strict";
// Run inside the isolated driver: exercises actual installed Node/pg resource
// stacks, not copied stack strings. Missing a match is an explicit test failure.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createHook } = require("node:async_hooks");
const { exemption, exemptions } = require("./barrier.cjs");
test("R5: real TLS, pg-pool and HTTP disposal resources match all declared exemptions", async () => {
  const seen = new Set();
  const hook = createHook({
    init(id, type, trigger, resource) {
      const match = exemption(
        type,
        new Error().stack,
        String(resource?._onTimeout)
      );
      if (match) seen.add(match);
    },
  }).enable();
  const http = require("node:http"),
    https = require("node:https");
  const pool = new (require("pg").Pool)({
    connectionString: process.env.DATABASE_URL,
    idleTimeoutMillis: 50,
  });
  const server = http.createServer((req, res) => res.end("fixture"));
  const agent = new http.Agent({ keepAlive: true });
  try {
    await pool.query("select 1");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve, reject) =>
      http
        .get(
          { hostname: "127.0.0.1", port: server.address().port, agent },
          (res) => {
            res.resume();
            res.on("end", resolve);
          }
        )
        .on("error", reject)
    );
    await new Promise((resolve, reject) =>
      https
        .get(
          "https://oidc-simulator:3000/.well-known/jwks.json",
          { agent: false },
          (res) => {
            res.resume();
            res.on("end", resolve);
          }
        )
        .on("error", reject)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      [...seen].sort(),
      [...exemptions].sort(),
      `runtime exemption drift on ${process.version}`
    );
  } finally {
    hook.disable();
    agent.destroy();
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("R1: production SQS SDK resolves only the explicit closed local endpoint", async () => {
  require("ts-node/register/transpile-only");
  const { sqsClient } = require("../src/utils/sqs.ts");
  // Stop before transport; exercise the SDK endpoint resolver under production.
  assert.equal(process.env.NODE_ENV, "production");
  let endpoint;
  sqsClient.middlewareStack.add(
    () => async (args) => {
      endpoint = args.request;
      return { output: { $metadata: {} } };
    },
    { name: "p027EndpointProbe", step: "finalizeRequest", priority: "low" }
  );
  await sqsClient.send(
    new (require("@aws-sdk/client-sqs").ListQueuesCommand)({})
  );
  assert.equal(endpoint.hostname, "server");
  assert.equal(endpoint.port, 4566);
  sqsClient.destroy();
});
