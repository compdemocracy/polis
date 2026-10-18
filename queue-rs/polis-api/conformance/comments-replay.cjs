"use strict";
// Byte conformance for the public GET /api/v3/comments slice.
// Authenticated/moderation/report cases are counted separately as Node handoffs.
//
// Sends every recorded comments request in the pinned public-fixture archive
// (server/characterization/artifacts/baseline.json.gz), in recorded order, to
// the Node server and to polis-api, as identical raw HTTP/1.1 bytes on fresh
// connections, and compares the two raw responses: status line, every header
// (name, casing, order, value) and every body byte, chunk framing included.
// Nothing is normalised. When the only difference is the Date line (the two
// answers straddled a second boundary), the pair is sent again; those retries
// are counted. Unmoved requests are reported separately as Node handoffs.
//
// Runs inside the conformance stack's driver container (conformance/comments-run.sh),
// which can reach server:5000, server:5001 (the harness control port that
// mints the generated credentials) and polis-api:5100.
const fs = require("node:fs");
const net = require("node:net");
const zlib = require("node:zlib");

const NODE = { host: "server", port: 5000 };
const RUST = { host: "polis-api", port: 5100 };
const ARCHIVE = "/app/characterization/artifacts/baseline.json.gz";

function exchange(target, bytes, headOnly) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("response deadline")), 10000);
    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (b) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      const end = complete(all, headOnly);
      if (end !== null) finish(null, all.subarray(0, end));
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (e) => finish(e));
  });
}

// Offset just past one complete response in `buf`, or null if more is needed.
function complete(buf, headOnly) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString("latin1");
  const status = Number(head.split(" ")[1]);
  const header = (name) => {
    const line = head
      .split("\r\n")
      .slice(1)
      .find((l) => l.toLowerCase().startsWith(name + ":"));
    return line === undefined ? undefined : line.slice(name.length + 1).trim();
  };
  let at = headEnd + 4;
  if (headOnly || status === 204 || status === 304 || (status >= 100 && status < 200)) return at;
  if ((header("transfer-encoding") || "").toLowerCase() === "chunked") {
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", at);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(at, lineEnd).toString("latin1"), 16);
      at = lineEnd + 2 + size + 2;
      if (at > buf.length) return null;
      if (size === 0) return at;
    }
  }
  const length = header("content-length");
  if (length !== undefined) {
    const end = at + Number(length);
    return end <= buf.length ? end : null;
  }
  return null; // delimited by close
}

function requestBytes(method, target, headers, body) {
  let text = `${method} ${target} HTTP/1.1\r\n`;
  for (const [name, value] of headers) text += `${name}: ${value}\r\n`;
  return Buffer.concat([Buffer.from(text + "\r\n", "latin1"), body]);
}

const dateLine = /\r\nDate: [^\r]*\r\n/;
function sameButDate(a, b) {
  const ma = a.toString("latin1").match(dateLine);
  const mb = b.toString("latin1").match(dateLine);
  if (!ma || !mb || ma[0] === mb[0]) return false;
  return a.toString("latin1").replace(dateLine, "\r\n") === b.toString("latin1").replace(dateLine, "\r\n");
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function show(buf) {
  const head = buf.subarray(0, Math.max(0, buf.indexOf("\r\n\r\n"))).toString("latin1");
  return { head: head.split("\r\n"), bodyBytes: buf.length - head.length - 4 };
}

let dateRetries = 0;
async function compare(id, bytes, headOnly) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const node = await exchange(NODE, bytes, headOnly);
    const rust = await exchange(RUST, bytes, headOnly);
    if (rust.subarray(0, 16).toString("latin1").startsWith("HTTP/1.1 502")) {
      return { id, fallback: true, nodeStatus: Number(node.toString("latin1").split(" ")[1]) };
    }
    if (node.equals(rust)) return { id, equal: true, node };
    if (sameButDate(node, rust)) {
      dateRetries++;
      continue;
    }
    const at = firstDifference(node, rust);
    return {
      id,
      equal: false,
      firstDifferentByte: at,
      node: show(node),
      rust: show(rust),
      nodeContext: node.subarray(Math.max(0, at - 40), at + 40).toString("latin1"),
      rustContext: rust.subarray(Math.max(0, at - 40), at + 40).toString("latin1"),
      nodeRaw: node,
    };
  }
  throw new Error(`${id}: Date kept differing across five attempts`);
}

async function main() {
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(ARCHIVE)));
  const tokens = await fetch("http://server:5001/tokens").then(r => r.json());
  const cases = Object.keys(archive).filter(k => /^case-\d+\/request\.json$/.test(k)).sort().map(k => JSON.parse(archive[k])).filter(r => r.request_id.startsWith("comments-read/"));
  if (cases.length !== 396) throw Error(`expected 396 comment recordings, got ${cases.length}`);
  const results = [];
  for (const request of cases) {
    const target = Buffer.from(request.target.base64, "base64").toString("latin1");
    const headers = request.headers.map(h => {
      if (!h.credential_ref) return [h.name, h.value];
      const token = tokens[h.credential_ref.replace(/^\$auth:/, "")];
      if (!token) throw Error(`missing fixture ${h.credential_ref}`);
      return [h.name, `Bearer ${token}`];
    });
    const body = Buffer.concat(request.body.map(c => Buffer.from(c.bytes.base64, "base64")));
    const result = await compare(request.request_id, requestBytes(request.method, target, headers, body), request.method === "HEAD");
    if (result.fallback) {
      const query = new URL(target, "http://localhost").searchParams;
      const moved = result.nodeStatus === 200 && !headers.some(([n]) => ["authorization","cookie","content-length","transfer-encoding"].includes(n.toLowerCase())) && !query.has("report_id") && !["true","t","1","on"].includes((query.get("moderation") || "").toLowerCase());
      if (moved) result.unexpectedFallback = true;
    }
    delete result.node; delete result.nodeRaw;
    results.push(result);
  }
  const differences = results.filter(r => !r.equal && (!r.fallback || r.unexpectedFallback));
  const summary = {recorded: cases.length, servedByRust: results.filter(r=>r.equal).length, handedToNode: results.filter(r=>r.fallback && !r.unexpectedFallback).length, dateRetries, differences};
  console.log(JSON.stringify(summary,null,2));
  if (differences.length || summary.servedByRust === 0) process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=2;});
