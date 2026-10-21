"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { createBarrier } = require("../barrier.cjs");
const { install } = require("./idle-tls.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("only an idle completed TLS Agent timer settles; reuse remains pending", async () => {
  const classify = install();
  const barrier = createBarrier(() => false, classify);
  const strict = createBarrier();
  const agent = new https.Agent({ keepAlive: true, timeout: 4000 });
  let timer;
  try {
    await strict.run("strict", () => barrier.run("owner", () =>
      new Promise((resolve, reject) => {
        https.get("https://oidc-simulator:3000/.well-known/jwks.json", { agent }, res => {
          res.resume();
          res.on("end", resolve);
        }).on("error", reject);
      })
    ));
    await tick();
    assert.ok(strict.state("strict").pending.some(x => x.kind === "Timeout"));
    assert.deepEqual(barrier.state("owner").pending, []);
    const socket = Object.values(agent.freeSockets).flat()[0];
    assert.ok(socket);
    // Reuse the actual idle socket; while its next response is paused, its
    // request timeout must be pending even though keepSocketAlive saw it before.
    await barrier.run("second", () => new Promise((resolve, reject) => {
      https.get("https://oidc-simulator:3000/.well-known/jwks.json", { agent }, res => {
        try {
          assert.equal(res.socket, socket);
          assert.ok([...barrier.state("owner").pending, ...barrier.state("second").pending]
            .some(x => x.kind === "Timeout"));
          res.resume();
          res.on("end", resolve);
        } catch (e) { res.resume(); reject(e); }
      }).on("error", reject);
    }));
    await tick();
    assert.deepEqual(barrier.state("second").pending, []);
    barrier.run("ordinary", () => { timer = setTimeout(() => {}, 4000); });
    assert.equal(barrier.state("ordinary").pending.length, 1);
    const finish = barrier.run("sql", () => barrier.start("postgres"));
    assert.equal(barrier.state("sql").pending.length, 1);
    finish();
    assert.equal(barrier.finish("owner"), "request-effects-drained");
    assert.equal(barrier.finish("second"), "request-effects-drained");
  } finally {
    clearTimeout(timer);
    agent.destroy();
    barrier.close();
    strict.close();
    classify.restore();
  }
});
