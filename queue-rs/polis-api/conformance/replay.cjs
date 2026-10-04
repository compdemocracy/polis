"use strict";
// Byte-for-byte conformance replay for GET /api/v3/math/pca2.
//
// Sends every recorded pca2 request in the pinned public-fixture archive
// (server/characterization/artifacts/baseline.json.gz), in recorded order, to
// the Node server and to polis-api, as identical raw HTTP/1.1 bytes on fresh
// connections, and compares the two raw responses: status line, every header
// (name, casing, order, value) and every body byte, chunk framing included.
// Nothing is normalised. When the only difference is the Date line (the two
// answers straddled a second boundary), the pair is sent again; those retries
// are counted. A list of extra generated requests (labelled entity tags, HEAD,
// OPTIONS, gzip/deflate subsets, redirects, malformed parameters) follows.
//
// Runs inside the conformance stack's driver container (conformance/run.sh),
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

// The archived response as raw HTTP/1.1, so Node's current answer can also be
// set against what was recorded (informational: Node has changed since).
function archivedBytes(response) {
  let text = `HTTP/1.1 ${response.status} ${require("node:http").STATUS_CODES[response.status]}\r\n`;
  for (const h of response.headers) text += `${h.name}: ${h.value}\r\n`;
  const body = Buffer.concat(response.body.map((c) => Buffer.from(c.bytes.base64, "base64")));
  return Buffer.concat([Buffer.from(text + "\r\n", "latin1"), body]);
}
function rawBody(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, headEnd).toString("latin1").toLowerCase();
  let body = buf.subarray(headEnd + 4);
  if (head.includes("transfer-encoding: chunked")) {
    const parts = [];
    let at = 0;
    for (;;) {
      const lineEnd = body.indexOf("\r\n", at);
      const size = parseInt(body.subarray(at, lineEnd).toString("latin1"), 16);
      if (!size) break;
      parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return body;
}

async function main() {
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(ARCHIVE)));
  const tokens = await fetch("http://server:5001/tokens").then((r) => r.json());
  tokens.moderator = tokens.admin;
  const cases = Object.keys(archive)
    .filter((k) => /^case-\d+\/request\.json$/.test(k))
    .sort()
    .map((k) => k.split("/")[0])
    .map((c) => ({
      c,
      request: JSON.parse(archive[`${c}/request.json`]),
      response: JSON.parse(archive[`${c}/response.json`]),
    }))
    .filter(({ request }) =>
      Buffer.from(request.target.base64, "base64").toString("latin1").startsWith("/api/v3/math/pca2")
    );

  const recorded = [];
  let archiveSame = 0;
  for (const { request, response } of cases) {
    const target = Buffer.from(request.target.base64, "base64").toString("latin1");
    const headers = request.headers.map((h) => {
      if (!h.credential_ref) return [h.name, h.value];
      const token = tokens[h.credential_ref.replace(/^\$auth:/, "")];
      if (!token) throw new Error(`no generated credential for ${h.credential_ref}`);
      return [h.name, `Bearer ${token}`];
    });
    const body = Buffer.concat(request.body.map((c) => Buffer.from(c.bytes.base64, "base64")));
    const result = await compare(request.request_id, requestBytes(request.method, target, headers, body), request.method === "HEAD");
    // Node now versus the archive: status, header names and values (Date
    // aside), and decoded body. The archive predates the labelled entity tag.
    const live = result.equal ? result.node : result.nodeRaw;
    const archived = archivedBytes(response);
    const strip = (b) =>
      b.subarray(0, b.indexOf("\r\n\r\n")).toString("latin1").replace(/\r\nDate: [^\r]*/, "");
    if (strip(live) === strip(archived) && rawBody(live).equals(rawBody(archived))) archiveSame++;
    delete result.node;
    delete result.nodeRaw;
    recorded.push(result);
  }

  // Extra generated requests: paths the recording does not exercise.
  const base = [
    ["host", "localhost:5000"],
    ["accept", "application/json"],
    ["x-forwarded-proto", "https"],
    ["Connection", "keep-alive"],
  ];
  const q = (cid, extra = "") => `/api/v3/math/pca2?conversation_id=${cid}${extra}`;
  const json = (s) => [
    [["content-type", "application/json"], ["content-length", String(Buffer.byteLength(s))]],
    Buffer.from(s),
  ];
  const extras = [
    ["labelled-tag-equal", "GET", q("2p027r4101"), [["if-none-match", '"p027-1"']]],
    ["labelled-tag-weak", "GET", q("2p027r4101"), [["if-none-match", 'W/"p027-1"']]],
    ["labelled-tag-weak-lower", "GET", q("2p027r4101"), [["if-none-match", 'w/"p027-1"']]],
    ["labelled-tag-in-list", "GET", q("2p027r4101"), [["if-none-match", '"x" , W/"p027-1"']]],
    ["labelled-tag-other-label", "GET", q("2p027r4101"), [["if-none-match", '"python-1"']]],
    ["legacy-numeric-tag", "GET", q("2p027r4101"), [["if-none-match", '"1"']]],
    ["two-if-none-match-headers", "GET", q("2p027r4101"), [["if-none-match", '"x"'], ["If-None-Match", '"p027-1"']]],
    ["star-populated", "GET", q("2p027r4101"), [["if-none-match", "*"]]],
    ["star-with-no-cache", "GET", q("2p027r4101"), [["if-none-match", "*"], ["cache-control", "no-cache"]]],
    ["star-with-if-modified-since", "GET", q("2p027r4101"), [["if-none-match", "*"], ["if-modified-since", "Tue, 14 Nov 2023 22:13:20 GMT"]]],
    ["star-inside-tag", "GET", q("2p027r4101"), [["if-none-match", '"a*b"']]],
    ["blank-if-none-match", "GET", q("2p027r4101"), [["if-none-match", "   "]]],
    ["long-if-none-match", "GET", q("2p027r4101"), [["if-none-match", '"' + "x".repeat(1001) + '"']]],
    ["tick-equal", "GET", q("2p027r4101", "&math_tick=1"), []],
    ["tick-older", "GET", q("2p027r4101", "&math_tick=0"), []],
    ["tick-negative", "GET", q("2p027r4101", "&math_tick=-5"), []],
    ["tick-text", "GET", q("2p027r4101", "&math_tick=abc"), []],
    ["tick-prefix", "GET", q("2p027r4101", "&math_tick=0abc"), []],
    ["tick-array", "GET", q("2p027r4101", "&math_tick[]=1"), []],
    ["head-populated", "HEAD", q("2p027r4101"), []],
    ["head-subset", "HEAD", q("2p027r4101", "&keys=tids"), []],
    ["options", "OPTIONS", q("2p027r4101"), []],
    ["post", "POST", q("2p027r4101"), []],
    ["subset-gzip-large", "GET", q("2p027r4101", "&keys=pca,base-clusters,group-clusters,repness,group-votes,tids,in-conv,user-vote-counts,votes-base,consensus"), [["accept-encoding", "gzip"]]],
    ["subset-deflate", "GET", q("2p027r4101", "&keys=pca,base-clusters,group-clusters,repness,group-votes,tids"), [["accept-encoding", "deflate"]]],
    ["subset-browser-encodings", "GET", q("2p027r4101", "&keys=pca,base-clusters,repness"), [["accept-encoding", "gzip, deflate, br"]]],
    ["subset-identity-only", "GET", q("2p027r4101", "&keys=pca,base-clusters,repness"), [["accept-encoding", "identity"]]],
    ["full-with-gzip-accept", "GET", q("2p027r4101"), [["accept-encoding", "gzip"]]],
    ["keys-bracket-array", "GET", q("2p027r4101", "&keys[]=tids&keys[]=n"), []],
    ["keys-indexed", "GET", q("2p027r4101", "&keys[1]=n&keys[0]=tids"), []],
    ["keys-object", "GET", q("2p027r4101", "&keys[a]=tids"), []],
    ["keys-repeated", "GET", q("2p027r4101", "&keys=tids&keys=n"), []],
    ["keys-spaces", "GET", q("2p027r4101", "&keys=%20tids%20,%20n"), []],
    ["keys-json-mixed", "GET", q("2p027r4101"), ...json('{"keys":[["tids"],1,null,true,"n"]}')],
    ["keys-json-number", "GET", q("2p027r4101"), ...json('{"keys":5}')],
    ["math-tick-json-number", "GET", q("2p027r4101"), ...json('{"math_tick":0}')],
    ["conversation-id-in-body", "GET", "/api/v3/math/pca2", ...json('{"conversation_id":"2p027r4101"}')],
    ["invalid-json-body", "GET", q("2p027r4101"), ...json("{nope")],
    ["json-scalar-body", "GET", q("2p027r4101"), ...json('"text"')],
    ["zid-redirect", "GET", "/api/v3/math/pca2?zid=101", []],
    ["zid-redirect-gzip", "GET", "/api/v3/math/pca2?zid=101", [["accept-encoding", "gzip"]]],
    ["conversation-id-too-long", "GET", q("x".repeat(101)), []],
    ["conversation-id-padded", "GET", q("%202p027r4101%20"), []],
    ["conversation-id-array", "GET", "/api/v3/math/pca2?conversation_id[]=2p027r4101", []],
    ["conversation-id-empty", "GET", q(""), []],
    ["no-math-latest", "GET", q("2p027r4103"), []],
    ["no-math-weak-tag", "GET", q("2p027r4103"), [["if-none-match", 'W/"x"']]],
    ["zero-approved-subset", "GET", q("2p027r4100", "&keys=tids,n-cmts,pca"), []],
    ["env-mismatch-subset", "GET", q("2p027r4102", "&keys=tids,pca"), []],
    ["origin-header", "GET", q("2p027r4101"), [["origin", "https://embed.example"]]],
    ["percent-malformed-query", "GET", q("2p027r4101", "&keys=%zz,tids"), []],
    ["subset-matching-tag", "GET", q("2p027r4101", "&keys=tids"), [["if-none-match", '"p027-1"']]],
    ["subset-star", "GET", q("2p027r4101", "&keys=tids"), [["if-none-match", "*"]]],
    ["subset-weak-etag-of-body", "GET", q("2p027r4103", "&keys=tids"), [["if-none-match", 'W/"a-x"']]],
    ["head-not-ready", "HEAD", q("2p027r4103", "&math_tick=0"), []],
    ["tick-zero-row", "GET", q("2p027r4100", "&math_tick=0"), []],
    ["tick-zero-row-tag", "GET", q("2p027r4100"), [["if-none-match", '"p027-0"']]],
  ];
  const extra = [];
  for (const [id, method, target, headers, body = Buffer.alloc(0)] of extras) {
    const bytes = requestBytes(method, target, [...base, ...headers], body);
    const result = await compare(`extra/${id}`, bytes, method === "HEAD");
    delete result.node;
    delete result.nodeRaw;
    extra.push(result);
  }
  // Requests whose framing is written by hand.
  for (const [id, text] of [
    ["no-host-header", `GET ${q("2p027r4101")} HTTP/1.1\r\nx-forwarded-proto: https\r\n\r\n`],
    ["zid-redirect-plain-http", `GET /api/v3/math/pca2?zid=101 HTTP/1.1\r\nhost: localhost:5000\r\n\r\n`],
    ["http-1.0-gzip-subset", `GET ${q("2p027r4101", "&keys=pca,base-clusters,repness,tids")} HTTP/1.0\r\nhost: localhost:5000\r\nx-forwarded-proto: https\r\naccept-encoding: gzip\r\n\r\n`],
    ["http-1.0-keep-alive", `GET ${q("2p027r4101", "&keys=tids")} HTTP/1.0\r\nhost: localhost:5000\r\nx-forwarded-proto: https\r\nconnection: keep-alive\r\n\r\n`],
    ["http-1.0-redirect", `GET /api/v3/math/pca2?zid=101 HTTP/1.0\r\nhost: localhost:5000\r\nx-forwarded-proto: https\r\n\r\n`],
    ["http-1.0-invalid-json", `GET ${q("2p027r4101")} HTTP/1.0\r\nhost: localhost:5000\r\nx-forwarded-proto: https\r\ncontent-type: application/json\r\ncontent-length: 5\r\n\r\n{nope`],
  ]) {
    const result = await compare(`extra/${id}`, Buffer.from(text, "latin1"), false);
    delete result.node;
    delete result.nodeRaw;
    extra.push(result);
  }
  // An HTTP/1.0 request, written by hand.
  {
    const bytes = Buffer.from(`GET ${q("2p027r4101", "&keys=tids")} HTTP/1.0\r\nhost: localhost:5000\r\nx-forwarded-proto: https\r\n\r\n`, "latin1");
    const result = await compare("extra/http-1.0", bytes, false);
    delete result.node;
    delete result.nodeRaw;
    extra.push(result);
  }

  const summary = {
    recorded: {
      total: recorded.length,
      equal: recorded.filter((r) => r.equal).length,
      statuses: cases.reduce((a, { response }) => ((a[response.status] = (a[response.status] || 0) + 1), a), {}),
      nodeUnchangedSinceArchive: archiveSame,
    },
    extra: { total: extra.length, equal: extra.filter((r) => r.equal).length },
    dateRetries,
    differences: [...recorded, ...extra].filter((r) => !r.equal),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.differences.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 2;
});
