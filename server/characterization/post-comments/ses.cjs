"use strict";
// Local capture only: no SDK, forwarding, credentials or outbound client.
const http = require("node:http");
const messages = [];
http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/messages") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(messages));
  }
  if (req.method !== "POST" || req.url !== "/v2/email/outbound-emails") {
    res.statusCode = 404; return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    messages.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ MessageId: "generated-local-message" }));
  } catch {
    res.statusCode = 400; res.end("{}");
  }
}).listen(8025, "0.0.0.0");
