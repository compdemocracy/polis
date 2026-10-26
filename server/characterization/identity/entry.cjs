"use strict";
// Test-only control wrapper around the sealed characterization entrypoint.
const http = require("node:http");
const createServer = http.createServer;
let fault = null,
  fired = 0,
  last = null;
require("ts-node/register/transpile-only");
const { Client } = require("pg");
const query = Client.prototype.query;
Client.prototype.query = function (...args) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
  const match =
    fault === "load"
      ? /INSERT INTO oidc_user_mappings/i
      : fault === "xid"
      ? /INSERT INTO xids/i
      : /SELECT uid FROM oidc_user_mappings WHERE oidc_sub/i;
  if (fault && fault !== "extraction" && match.test(sql)) {
    const kind = fault;
    fired++;
    if (kind !== "load" || fired === 4) fault = null;
    const error = Object.assign(new Error("generated identity SQL failure"), {
      code: ["conflict", "load"].includes(kind) ? "23505" : "XX000",
      ...(kind === "load" ? { constraint: "oidc_user_mappings_pkey" } : {}),
    });
    const callback = args.at(-1);
    if (typeof callback === "function") {
      queueMicrotask(() => callback(error));
      return;
    }
    return Promise.reject(error);
  }
  return query.apply(this, args);
};
http.createServer = function (...args) {
  const i = args.findIndex((a) => typeof a === "function");
  if (i >= 0) {
    const listener = args[i];
    args[i] = async function (req, res) {
      const url = new URL(req.url, "http://localhost");
      if (
        req.socket.localPort === 5001 &&
        url.pathname.startsWith("/identity-")
      ) {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/identity-fault") {
          const kind = url.searchParams.get("kind");
          if (
            ![
              "none",
              "xid",
              "load",
              "conflict",
              "account",
              "extraction",
            ].includes(kind)
          ) {
            res.statusCode = 400;
            return res.end("{}");
          }
          fault = kind === "none" ? null : kind;
          fired = 0;
          last = null;
          return res.end("{}");
        }
        if (url.pathname === "/identity-last")
          return res.end(
            JSON.stringify({ ...last, fault: { armed: fault, fired } })
          );
      }
      if (req.socket.localPort === 5000) {
        if (fault === "extraction") {
          let payload;
          // The outer extraction catch cannot be reached by an ordinary JSON
          // claim. A one-shot property failure exercises the real middleware.
          Object.defineProperty(req, "jwtPayload", {
            configurable: true,
            set(value) {
              payload = value;
            },
            get() {
              if (fault === "extraction" && payload) {
                fault = null;
                fired++;
                throw new Error("generated identity extraction failure");
              }
              return payload;
            },
          });
        }
        const chunks = [];
        for (const method of ["write", "end"]) {
          const original = res[method];
          res[method] = function (chunk, encoding, ...rest) {
            if (chunk)
              chunks.push(
                Buffer.isBuffer(chunk)
                  ? chunk
                  : Buffer.from(
                      chunk,
                      typeof encoding === "string" ? encoding : undefined
                    )
              );
            return original.call(this, chunk, encoding, ...rest);
          };
        }
        res.once("finish", () => {
          last = {
            status: res.statusCode,
            headers: res.getHeaders(),
            body_base64: Buffer.concat(chunks).toString("base64"),
          };
        });
      }
      return listener(req, res);
    };
  }
  return createServer.apply(this, args);
};
require("../entry.cjs");
