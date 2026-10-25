"use strict";
// Generated XID tokens for recordings. Product authentication and handlers are unchanged.
const http = require("node:http");
const original = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex(a => typeof a === "function");
  if (index >= 0) {
    const listener = args[index];
    args[index] = function (req, res) {
      if (req.socket.localPort === 5001 && req.url === "/users-read-tokens") {
        const { fixtures } = require("/app/characterization/comments-cases.cjs");
        const { issueParticipantJWT } = require("/app/src/auth/jwt-utils.ts");
        const first = fixtures.find(f => f.shape === "content-edges");
        const second = fixtures.find(f => f.shape === "content-edges" && f.owner !== first.owner);
        const xid = "user-profile-雪";
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          self: issueParticipantJWT("xid", first.capability, 3, first.participantPid, xid),
          other: issueParticipantJWT("xid", second.capability, 4, 4, xid),
        }));
      }
      return listener(req, res);
    };
  }
  return original.apply(this, args);
};
require("/conformance/participant-entry.cjs");
