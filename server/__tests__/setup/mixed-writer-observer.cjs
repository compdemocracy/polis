/* Pool diagnostics only: preserve callbacks, queries, releases and limits. */
const { Pool } = require("pg");
const seen = new Set();
const waits = [];
const original = Pool.prototype.connect;
Pool.prototype.connect = function (callback) {
  seen.add(this);
  const started = performance.now();
  const queued = this.waitingCount;
  const record = () => waits.push({ ms: performance.now() - started, queued });
  if (callback)
    return original.call(this, (error, client, release) => {
      record();
      callback(error, client, release);
    });
  return original.call(this).then((client) => {
    record();
    return client;
  });
};
exports.snapshot = () => {
  const { poolRole } = require("../../src/db/pg-query");
  return {
    pools: [...seen].map((pool) => ({
      role: poolRole(pool),
      max: pool.options.max,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      backendPids: pool._clients.map((client) => client.processID),
    })),
    acquisitions: waits.splice(0),
  };
};
exports.close = () => Promise.all([...seen].map((pool) => pool.end()));
