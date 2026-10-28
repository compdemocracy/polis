"use strict";
// Native test process; product middleware and handlers are unchanged.
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const req = require("node:module").createRequire(root + "/server/package.json");
req("ts-node/register/transpile-only");
// Fail before an accidental provider/notification request can leave loopback.
const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts =
    typeof args[0] === "object"
      ? Array.isArray(args[0])
        ? args[0][0]
        : args[0]
      : null;
  const host =
    opts?.host || (typeof args[1] === "string" ? args[1] : "localhost");
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw Error("non-loopback connection refused");
  return connect.apply(this, args);
};
// Match the sealed characterization harness: fail the unconditional legacy
// startup key probe asynchronously, without DNS or opening an external socket.
const http = require("node:http");
const request = http.request;
http.request = function (...args) {
  const o = args[0];
  if (
    (o?.hostname || o?.host) === "rest.akismet.com" &&
    o.path === "/1.1/verify-key"
  ) {
    console.log("MIXED_BLOCKED_STARTUP_KEY_PROBE");
    const stream = new (require("node:stream").Writable)({
      write(_c, _e, done) {
        done();
      },
    });
    stream.setTimeout = () => stream;
    stream.abort = () => stream.destroy();
    process.nextTick(() =>
      stream.destroy(Error("external startup probe blocked"))
    );
    return stream;
  }
  return request.apply(this, args);
};
// Query comments identify the exact caller in test-only audit triggers. They do
// not change statement ordering, transaction boundaries or query results.
req("bluebird").config({ asyncHooks: true });
const context = new (require("node:async_hooks").AsyncLocalStorage)();
const { Client } = req("pg");
const query = Client.prototype.query;
Client.prototype.query = function (...args) {
  const id = context.getStore();
  if (id) {
    const suffix = ` /* mixed-caller:${id} */`;
    if (typeof args[0] === "string") args[0] += suffix;
    else if (args[0]?.text)
      args[0] = { ...args[0], text: args[0].text + suffix };
  }
  return query.apply(this, args);
};
process.on("uncaughtExceptionMonitor", (e) => console.error(e));
const { default: app, appReady } = req(root + "/server/app.ts");
const handle = app.handle;
app.handle = function (request, response, ...rest) {
  const id = request.headers["x-mixed-caller"];
  if (id && !/^[a-z0-9-]+$/.test(id)) throw Error("invalid test caller");
  for (const emitter of [request, response]) {
    const emit = emitter.emit;
    emitter.emit = function (...a) {
      return context.run(id, () => emit.apply(this, a));
    };
  }
  return context.run(id, () => handle.call(this, request, response, ...rest));
};
app.listen(Number(process.env.MIXED_NODE_PORT), "127.0.0.1", () =>
  console.log("MIXED_NODE_LISTENING")
);
appReady.then(() => console.log("MIXED_NODE_READY"));
