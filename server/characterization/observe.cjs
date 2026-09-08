'use strict';
// Load before ANY application imports. Defense in depth; Docker internal network is the security boundary.
const fs = require('node:fs'),
  http = require('node:http'),
  https = require('node:https'),
  net = require('node:net');
if (process.env.P027_OBSERVE !== '1' || process.env.P027_NETWORK_INTERNAL !== '1')
  throw Error('P027 requires asserted internal network');
const allowed = new Set([
  'postgres',
  'dynamodb',
  'oidc-simulator',
  'file-server',
  'localhost',
  '127.0.0.1',
  '::1',
]);
const state = (global.__p027 = {
  outbound: [],
  process: [],
  hits: [],
  jwtIssues: 0,
  registrations: [],
  ready: false,
});
// A portable entropy stream. Installed before imports so cached Math.random references
// see the same per-case stream. Cryptographic randomness remains untouched.
const random=require('./entropy.cjs').entropy();
state.setSeed=hex=>random.seed(hex);
Math.random=()=>random.next();
const processLedger = '/artifacts/process-events.jsonl';
fs.writeFileSync(processLedger, '');
function recordProcess(event) {
  state.process.push(event);
  fs.appendFileSync(processLedger, JSON.stringify(event) + '\n');
}
function check(host, port, protocol, method, path) {
  host = String(host || 'localhost').replace(/^\[|\]$/g, '');
  const blocked = !allowed.has(host);
  const attempt = {
    host,
    port: Number(port),
    protocol,
    method: method || null,
    path: path || null,
    blocked,
  };
  state.outbound.push(attempt);
  if (blocked) {
    const e = Error(`P027_EGRESS_BLOCKED ${host}:${port}`);
    e.code = 'P027_EGRESS_BLOCKED';
    e.attempt = attempt;
    throw e;
  }
  return attempt;
}
function captureBody(req, attempt) {
  const chunks = [];
  function capture(chunk, encoding) {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
    );
    const raw = Buffer.concat(chunks).toString('utf8');
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
  return req;
}
for (const [mod, protocol] of [
  [http, 'http'],
  [https, 'https'],
]) {
  const orig = mod.request;
  mod.request = function (...args) {
    let o =
      typeof args[0] === 'string' || args[0] instanceof URL
        ? Object.assign(
            {},
            Object.fromEntries(
              ['hostname', 'port', 'pathname', 'search'].map((k) => [k, new URL(args[0])[k]])
            ),
            typeof args[1] === 'object' ? args[1] : {}
          )
        : args[0];
    let attempt;
    try {
      attempt = check(
        o.hostname || o.host,
        o.port || (protocol === 'https' ? 443 : 80),
        protocol,
        o.method || 'GET',
        o.path || (o.pathname || '/') + (o.search || '')
      );
    } catch (error) {
      const req = new (require('node:stream').Writable)({
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
    typeof a[0] === 'object'
      ? a[0]
      : { port: a[0], host: typeof a[1] === 'string' ? a[1] : 'localhost' };
  if (o.path) throw Error('P027 Unix sockets forbidden in application process');
  // Raw TCP, including fetch/undici and SDK transports, cannot bypass the host allowlist.
  const host = o.host || 'localhost';
  if (!allowed.has(host)) check(host, o.port, 'tcp');
  return connect.apply(this, args);
};
for (const event of ['unhandledRejection', 'uncaughtExceptionMonitor'])
  process.on(event, (e) =>
    recordProcess({
      event: event === 'uncaughtExceptionMonitor' ? 'uncaughtException' : event,
      message: String(e?.message || e),
      code: e?.code || null,
    })
  );
// Also catch explicit logger lines; do not store general logs (tokens may be logged by the app).
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  let tail = '';
  stream.write = function (chunk, ...args) {
    tail += String(chunk);
    const lines = tail.split('\n');
    tail = lines.pop();
    for (const line of lines)
      if (/unhandled.*rejection|uncaught.*exception/i.test(line))
        recordProcess({
          event: 'process-error-log',
          message: line.replace(/\u001b\[[0-9;]*m/g, ''),
          code: null,
        });
    return write(chunk, ...args);
  };
}
// Count successful token minting even if the request fails before returning the token.
const jwt = require('jsonwebtoken'), originalSign = jwt.sign;
jwt.sign = function(...args) {
  const callback=args[args.length-1];
  if(typeof callback==='function') {
    args[args.length-1]=function(error,token){if(!error&&token)state.jwtIssues++;return callback(error,token);};
    return originalSign.apply(this,args);
  }
  const token=originalSign.apply(this,args);if(typeof token==='string')state.jwtIssues++;return token;
};
// SDK command inputs preserve attempted effects even when the transport is blocked.
for (const [moduleName, clientName, service] of [
  ['@aws-sdk/client-sesv2', 'SESv2Client', 'SESv2'],
  ['@aws-sdk/client-s3', 'S3Client', 'S3'],
  ['@aws-sdk/client-sqs', 'SQSClient', 'SQS'],
  ['@aws-sdk/client-dynamodb', 'DynamoDBClient', 'DynamoDB'],
  ['@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient', 'CloudWatchLogs'],
]) {
  const Client = require(moduleName)[clientName],
    send = Client.prototype.send;
  Client.prototype.send = function (command, ...args) {
    state.outbound.push({ service, command: command.constructor.name, input: command.input });
    return send.call(this, command, ...args);
  };
}
const express = require('express');
let depth = 0;
for (const method of [...new Set([...require('methods'), 'all'])]) {
  const original = express.application[method];
  if (!original) continue;
  express.application[method] = function (path, ...handlers) {
    if (!handlers.length || depth) return original.call(this, path, ...handlers);
    const registrationIndex = state.registrations.length;
    const registration = {
      registrationIndex,
      declaredMethod: method.toUpperCase(),
      path: String(path),
    };
    state.registrations.push(registration);
    const hit = (req, res, next) => {
      state.hits.push(registrationIndex);
      next();
    };
    depth++;
    try {
      return original.call(this, path, hit, ...handlers);
    } finally {
      depth--;
      // app.routes is authoritative; attach identity to new route objects, never infer fan-out by path.
      for (const [verb, rs] of Object.entries(this.routes || {}))
        for (const r of rs)
          if (r.callbacks?.includes(hit))
            r.__p027 = { ...registration, method: verb.toUpperCase() };
    }
  };
}
module.exports = state;
