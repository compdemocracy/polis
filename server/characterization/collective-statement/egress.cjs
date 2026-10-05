"use strict";
/**
 * Egress guard for the collective-statement recordings. Installed before the
 * server is loaded, it sees every TCP connection and every DNS lookup the
 * process makes (pg, the AWS SDK, the Anthropic SDK's fetch all open their
 * sockets through net.Socket#connect). Only the loopback addresses and the
 * hosts named by the Postgres and DynamoDB URLs are allowed; any other target
 * is refused before a packet leaves and is written to the run's index, which
 * fails the run. The guard proves itself live at start-up by refusing a
 * connection to the real provider host.
 */
const net = require("node:net");
const dns = require("node:dns");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

function install(extraHosts) {
  const allowed = new Set([...LOOPBACK, ...extraHosts]);
  const refused = [];
  const lookups = new Set();

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let opts = args[0];
    if (Array.isArray(opts)) opts = opts[0];
    let host;
    let port;
    if (opts && typeof opts === "object") {
      if (opts.path) return connect.apply(this, args); // unix socket
      host = opts.host;
      port = opts.port;
    } else {
      port = args[0];
      host = typeof args[1] === "string" ? args[1] : undefined;
    }
    host = host || "localhost";
    if (!allowed.has(host)) {
      refused.push(`${host}:${port}`);
      const err = new Error(
        `egress refused by the recordings guard: ${host}:${port}`
      );
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return connect.apply(this, args);
  };

  const guard = (orig) =>
    function guardedLookup(hostname, ...rest) {
      lookups.add(hostname);
      if (!allowed.has(hostname)) {
        refused.push(`dns:${hostname}`);
        const cb = rest[rest.length - 1];
        const err = Object.assign(
          new Error(`dns refused by the recordings guard: ${hostname}`),
          { code: "ENOTFOUND" }
        );
        if (typeof cb === "function") return process.nextTick(() => cb(err));
        return Promise.reject(err);
      }
      return orig.call(this, hostname, ...rest);
    };
  dns.lookup = guard(dns.lookup);
  dns.promises.lookup = guard(dns.promises.lookup);

  return {
    refused,
    lookups,
    /** Prove the guard is live: the provider's real host must be refused. */
    async selfTest() {
      const before = refused.length;
      await new Promise((resolve) => {
        const s = net.connect({ host: "api.anthropic.com", port: 443 });
        s.on("error", () => resolve());
        s.on("connect", () => {
          s.destroy();
          resolve();
        });
      });
      const ok = refused.length === before + 1;
      refused.splice(before); // the self-test is not a run violation
      if (!ok)
        throw new Error("egress guard self-test: connection not refused");
      return "api.anthropic.com:443 refused";
    },
  };
}

module.exports = { install };
