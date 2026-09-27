"use strict";
// Load before ANY application imports. Defense in depth; Docker internal network is the security boundary.
const fs = require("node:fs"),
  http = require("node:http"),
  https = require("node:https"),
  net = require("node:net");
if (
  process.env.P027_OBSERVE !== "1" ||
  process.env.P027_NETWORK_INTERNAL !== "1"
)
  throw Error("P027 requires asserted internal network");
const allowed = new Set([
  "postgres",
  "dynamodb",
  "oidc-simulator",
  "file-server",
  "localhost",
  "127.0.0.1",
  "::1",
]);
const state = (global.__p027 = {
  outbound: [],
  process: [],
  hits: [],
  jwtIssues: 0,
  registrations: [],
  ready: false,
  middleware: [],
  currentCase: null,
});
// Bluebird's shared callback queue otherwise drops AsyncLocalStorage ownership.
require("bluebird").config({ asyncHooks: true });
const barrier = (state.barrier = require("./barrier.cjs").createBarrier(
  () => state.currentCase !== null
));
const { AsyncResource } = require("node:async_hooks");
const pgPool = require("pg").Pool,
  originalConnect = pgPool.prototype.connect;
pgPool.prototype.connect = function (...args) {
  const finish = barrier.start("postgres");
  if (typeof args[0] === "function") {
    const cb = AsyncResource.bind(args[0]);
    args[0] = (...values) => {
      finish();
      return cb(...values);
    };
  }
  try {
    const result = originalConnect.apply(this, args);
    if (result?.then) result.then(finish, finish);
    return result;
  } catch (e) {
    finish();
    throw e;
  }
};
const pgClient = require("pg").Client,
  originalQuery = pgClient.prototype.query;
pgClient.prototype.query = function (...args) {
  const finish = barrier.start("postgres");
  // Cursor protocol callbacks run on a pooled socket created by an earlier request.
  // Bind each submitted stream's callback surface, not the shared socket.
  if (args[0]?.cursor)
    for (const name of [
      "submit",
      "_read",
      "_destroy",
      "handleRowDescription",
      "handleDataRow",
      "handlePortalSuspended",
      "handleCommandComplete",
      "handleReadyForQuery",
      "handleError",
      "handleEmptyQuery",
    ])
      args[0][name] = AsyncResource.bind(args[0][name].bind(args[0]));
  const last = args.length - 1;
  if (typeof args[last] === "function") {
    const cb = AsyncResource.bind(args[last]);
    args[last] = function (...values) {
      finish();
      return cb.apply(this, values);
    };
  }
  try {
    const result = originalQuery.apply(this, args);
    if (result?.then) result.then(finish, finish);
    else if (result?.once)
      result
        .once(result.cursor ? "close" : "end", finish)
        .once("error", finish);
    return result;
  } catch (e) {
    finish();
    throw e;
  }
};
require("./clock.cjs").install();
// A portable entropy stream. Installed before imports so cached Math.random references
// see the same per-case stream. Cryptographic randomness remains untouched.
const random = require("./entropy.cjs").entropy();
state.setSeed = (hex) => random.seed(hex);
Math.random = () => random.next();
const processLedger = "/artifacts/process-events.jsonl";
fs.writeFileSync(processLedger, "");
function recordProcess(event) {
  event.at_ms = Math.max(
    0,
    performance.now() - (state.caseStart || performance.now())
  );
  event.request_id = state.currentCase;
  state.process.push(event);
  fs.appendFileSync(processLedger, JSON.stringify(event) + "\n");
}
function check(host, port, protocol, method, path) {
  host = String(host || "localhost").replace(/^\[|\]$/g, "");
  const blocked = !allowed.has(host);
  const attempt = {
    host,
    port: Number(port),
    protocol,
    method: method || null,
    path: path || null,
    blocked,
    at_ms: Math.max(
      0,
      performance.now() - (state.caseStart || performance.now())
    ),
    termination: blocked ? "connection_error" : null,
  };
  state.outbound.push(attempt);
  if (blocked) {
    const e = Error(`P027_EGRESS_BLOCKED ${host}:${port}`);
    e.code = "P027_EGRESS_BLOCKED";
    e.attempt = attempt;
    throw e;
  }
  return attempt;
}
function captureBody(req, attempt) {
  const finish = barrier.start("provider");
  const chunks = [];
  function capture(chunk, encoding) {
    if (chunk === undefined || chunk === null || typeof chunk === "function")
      return;
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(
            chunk,
            typeof encoding === "string" ? encoding : undefined
          )
    );
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      attempt.body = JSON.parse(raw);
    } catch {
      attempt.body = raw;
    }
  }
  const write = req.write,
    end = req.end;
  req.write = function (chunk, encoding, ...rest) {
    capture(chunk, encoding);
    return write.call(this, chunk, encoding, ...rest);
  };
  req.end = function (chunk, encoding, ...rest) {
    capture(chunk, encoding);
    return end.call(this, chunk, encoding, ...rest);
  };
  require("./transport-observe.cjs").observeResponse(req, attempt, finish);
  return req;
}
for (const [mod, protocol] of [
  [http, "http"],
  [https, "https"],
]) {
  const orig = mod.request;
  mod.request = function (...args) {
    if (typeof args[args.length - 1] === "function")
      args[args.length - 1] = AsyncResource.bind(args[args.length - 1]);
    let o =
      typeof args[0] === "string" || args[0] instanceof URL
        ? Object.assign(
            {},
            Object.fromEntries(
              ["hostname", "port", "pathname", "search"].map((k) => [
                k,
                new URL(args[0])[k],
              ])
            ),
            typeof args[1] === "object" ? args[1] : {}
          )
        : args[0];
    let attempt;
    try {
      attempt = check(
        o.hostname || o.host,
        o.port || (protocol === "https" ? 443 : 80),
        protocol,
        o.method || "GET",
        o.path || (o.pathname || "/") + (o.search || "")
      );
    } catch (error) {
      const req = new (require("node:stream").Writable)({
        write(chunk, encoding, cb) {
          cb();
        },
      });
      req.setTimeout = () => req;
      req.abort = () => req.destroy();
      req.setHeader = () => req;
      req.getHeader = () => undefined;
      process.nextTick(() => req.destroy(error));
      return captureBody(req, error.attempt);
    }
    return captureBody(orig.apply(this, args), attempt);
  };
  mod.get = function (...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const o =
    typeof a[0] === "object"
      ? a[0]
      : { port: a[0], host: typeof a[1] === "string" ? a[1] : "localhost" };
  if (o.path) throw Error("P027 Unix sockets forbidden in application process");
  // Raw TCP, including fetch/undici and SDK transports, cannot bypass the host allowlist.
  const host = o.host || "localhost";
  if (!allowed.has(host)) check(host, o.port, "tcp");
  return connect.apply(this, args);
};
for (const event of ["unhandledRejection", "uncaughtExceptionMonitor"])
  process.on(event, (e) =>
    recordProcess({
      event: event === "uncaughtExceptionMonitor" ? "uncaughtException" : event,
      message: String(e?.message || e),
      code: e?.code || null,
    })
  );
// Also catch explicit logger lines; do not store general logs (tokens may be logged by the app).
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  let tail = "";
  stream.write = function (chunk, ...args) {
    tail += String(chunk);
    const lines = tail.split("\n");
    tail = lines.pop();
    for (const line of lines)
      if (/unhandled.*rejection|uncaught.*exception/i.test(line))
        recordProcess({
          event: "process-error-log",
          // eslint-disable-next-line no-control-regex -- Strip ANSI escapes from diagnostics.
          message: line.replace(/\u001b\[[0-9;]*m/g, ""),
          code: null,
        });
    return write(chunk, ...args);
  };
}
// Count successful token minting even if the request fails before returning the token.
const jwt = require("jsonwebtoken"),
  originalSign = jwt.sign;
jwt.sign = function (...args) {
  const callback = args[args.length - 1];
  if (typeof callback === "function") {
    const finish = barrier.start("jwt-sign");
    args[args.length - 1] = function (error, token) {
      finish();
      if (!error && token) state.jwtIssues++;
      return callback(error, token);
    };
    return originalSign.apply(this, args);
  }
  const token = originalSign.apply(this, args);
  if (typeof token === "string") state.jwtIssues++;
  return token;
};
// SDK command inputs preserve attempted effects even when the transport is blocked.
for (const [moduleName, clientName, service] of [
  ["@aws-sdk/client-sesv2", "SESv2Client", "SESv2"],
  ["@aws-sdk/client-s3", "S3Client", "S3"],
  ["@aws-sdk/client-sqs", "SQSClient", "SQS"],
  ["@aws-sdk/client-dynamodb", "DynamoDBClient", "DynamoDB"],
  ["@aws-sdk/client-cloudwatch-logs", "CloudWatchLogsClient", "CloudWatchLogs"],
]) {
  const Client = require(moduleName)[clientName],
    send = Client.prototype.send;
  Client.prototype.send = function (command, ...args) {
    const attempt = {
      service,
      command: command.constructor.name,
      input: command.input,
      at_ms: Math.max(
        0,
        performance.now() - (state.caseStart || performance.now())
      ),
      termination: null,
    };
    state.outbound.push(attempt);
    const finish = barrier.start("provider");
    try {
      const result = send.call(this, command, ...args);
      result.then(
        (response) => {
          attempt.response = response;
          attempt.termination = "end";
          finish();
        },
        () => {
          attempt.termination = "connection_error";
          finish();
        }
      );
      return result;
    } catch (e) {
      attempt.termination = "connection_error";
      finish();
      throw e;
    }
  };
}
const express = require("express");
const fingerprint = (fn) =>
  require("./core.cjs").hash(Function.prototype.toString.call(fn));
const originalUse = express.application.use;
express.application.use = function (...args) {
  state.middleware.push(
    args
      .flat(Infinity)
      .map((x) => (typeof x === "function" ? fingerprint(x) : String(x)))
  );
  return originalUse.apply(this, args);
};
let depth = 0;
for (const method of [...new Set([...require("methods"), "all"])]) {
  const original = express.application[method];
  if (!original) continue;
  express.application[method] = function (path, ...handlers) {
    if (!handlers.length || depth)
      return original.call(this, path, ...handlers);
    const registrationIndex = state.registrations.length;
    const registration = {
      registrationIndex,
      declaredMethod: method.toUpperCase(),
      path: String(path),
      path_kind: path instanceof RegExp ? "regexp" : "string",
      exact_path_source: path instanceof RegExp ? path.source : path,
      regex_flags: path instanceof RegExp ? path.flags : "",
      condition: "registered_in_default_config",
      ordered_callback_fingerprints: handlers.flat(Infinity).map(fingerprint),
    };
    state.registrations.push(registration);
    const hit = (req, res, next) => {
      state.hits.push(registrationIndex);
      next();
    };
    const previous = new Set(Object.values(this.routes || {}).flat());
    depth++;
    try {
      return original.call(
        this,
        path,
        ...(process.env.P027_MARKERS === "0" ? [] : [hit]),
        ...handlers
      );
    } finally {
      depth--;
      // app.routes is authoritative; attach identity to new route objects, never infer fan-out by path.
      for (const [verb, rs] of Object.entries(this.routes || {}))
        for (const r of rs)
          if (!previous.has(r))
            r.__p027 = { ...registration, method: verb.toUpperCase() };
    }
  };
}
module.exports = state;
