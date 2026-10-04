"use strict";
// Local stand-ins the server reaches over HTTP during recording, both fed from
// generated fixtures: the OIDC JWKS document (for owner/other credentials the
// harness signs itself) and an S3 ListObjectsV2 listing of the visualization
// objects in fixtures/s3-objects.json. A listing stub rather than an object
// store keeps LastModified fixed, so the recorded bytes are reproducible.
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

const OBJECTS = require(path.join(__dirname, "fixtures", "s3-objects.json"));

function xml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function listing(bucket, prefix, maxKeys) {
  const hits = OBJECTS.filter((o) => o.Key.startsWith(prefix)).slice(
    0,
    maxKeys
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    `<Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix>` +
    `<KeyCount>${hits.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
    "<IsTruncated>false</IsTruncated>" +
    hits
      .map(
        (o) =>
          `<Contents><Key>${xml(o.Key)}</Key><LastModified>${
            o.LastModified
          }</LastModified>` +
          `<ETag>&quot;${crypto
            .createHash("md5")
            .update(o.Key)
            .digest("hex")}&quot;</ETag>` +
          `<Size>${o.Size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
      )
      .join("") +
    "</ListBucketResult>"
  );
}

function start(port, jwks) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    seen.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/.well-known/jwks.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(jwks));
    }
    const bucket = url.pathname.split("/")[1];
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      res.setHeader("content-type", "application/xml");
      return res.end(
        listing(
          bucket,
          url.searchParams.get("prefix") || "",
          Number(url.searchParams.get("max-keys") || 1000)
        )
      );
    }
    res.statusCode = 404;
    res.end("not served by the fixture stub");
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, seen }))
  );
}

module.exports = { start };
