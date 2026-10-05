"use strict";
/**
 * The local stand-in for everything the server reaches over HTTP during the
 * collective-statement recordings, on 127.0.0.1 only:
 *
 *   GET  /.well-known/jwks.json   the OIDC key set for tokens the harness signs
 *   POST /v1/messages             the model provider (Anthropic Messages API).
 *                                 The server's unchanged SDK reaches it through
 *                                 ANTHROPIC_BASE_URL. Each request is recorded
 *                                 exactly (headers that carry behaviour, and
 *                                 the full JSON body: model, max_tokens, the
 *                                 system and user prompt text) and answered by
 *                                 the next scripted behaviour of the case.
 *
 * Behaviours (one per expected provider request, consumed in order):
 *   { kind: "message", content, stop_reason }  200 with a Messages API body
 *   { kind: "status", status, error }          an API error status and body
 *   { kind: "reset" }                          the socket is destroyed, no reply
 *   { kind: "hold", then }                     held until release(), then `then`
 * A request with no behaviour left is answered 599 and marked unexpected, so a
 * case that calls the provider more often than scripted fails by name.
 */
const http = require("node:http");

const GENERATED_KEY = "generated-local-key-not-a-credential";

// Request headers that carry behaviour (API version, retry count, the SDK's
// timeout). Platform and package-version headers describe the SDK build, not
// the server, and are left out.
const RECORDED_HEADERS = [
  "anthropic-version",
  "content-type",
  "x-stainless-retry-count",
  "x-stainless-timeout",
];

function messageBody(b) {
  return {
    id: "msg_generated_fixture",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: b.content,
    stop_reason: b.stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1234, output_tokens: 567 },
  };
}

function start(jwks) {
  const state = {
    script: [],
    calls: [],
    pending: [],
    total: 0,
    unexpected: 0,
  };

  function answer(res, b) {
    if (b.kind === "message") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(messageBody(b)));
    }
    if (b.kind === "status") {
      res.statusCode = b.status;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ type: "error", error: b.error }));
    }
    if (b.kind === "reset") return res.socket.destroy();
    throw new Error(`unknown provider behaviour ${b.kind}`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    if (url.pathname === "/.well-known/jwks.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(jwks));
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.total++;
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { $unparsed: text };
      }
      const headers = {};
      for (const h of RECORDED_HEADERS)
        if (req.headers[h] !== undefined) headers[h] = req.headers[h];
      headers["x-api-key"] =
        req.headers["x-api-key"] === GENERATED_KEY
          ? "<generated key>"
          : req.headers["x-api-key"] === undefined
          ? "<absent>"
          : "<OTHER KEY>";
      const call = { method: req.method, path: url.pathname, headers, body };
      state.calls.push(call);
      const b = state.script.shift();
      if (!b) {
        state.unexpected++;
        call.unexpected = true;
        res.statusCode = 599;
        return res.end("unexpected provider call");
      }
      if (b.kind === "hold") {
        state.pending.push(() => answer(res, b.then));
        return;
      }
      answer(res, b);
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        state,
        /** Set the behaviours for the next case and clear its calls. */
        arm(script) {
          if (state.pending.length)
            throw new Error("provider stub still holds a request");
          state.script = [...script];
          state.calls = [];
        },
        /** Release every held request with its scripted reply. */
        release() {
          const p = state.pending.splice(0);
          p.forEach((f) => f());
          return p.length;
        },
        leftover() {
          return state.script.length;
        },
      })
    )
  );
}

module.exports = { start, GENERATED_KEY };
