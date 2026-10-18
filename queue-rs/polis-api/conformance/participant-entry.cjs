"use strict";
// Fixture control only. Product route handlers and the recorder stay unchanged.
// Tokens come from Node's real issuer; no private key is persisted or exported.
const http = require("node:http");
const original = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex(a => typeof a === "function");
  if (index >= 0) {
    const listener = args[index];
    args[index] = function(req, res) {
      if (req.socket.localPort === 5001 && req.url === "/participant-read-tokens") {
        const { fixtures } = require("/app/characterization/comments-cases.cjs");
        const { issueParticipantJWT, getPrivateKey } = require("/app/src/auth/jwt-utils.ts");
        const sign = require("/app/node_modules/jsonwebtoken").sign;
        const tokens = {};
        for (const f of fixtures) {
          tokens[`anonymous-${f.zid}`] = issueParticipantJWT("anonymous",f.capability,3,f.participantPid);
          tokens[`standard-${f.zid}`] = issueParticipantJWT("standard_user",f.capability,3,f.participantPid,"fixture|participant");
          tokens[`xid-${f.zid}`] = issueParticipantJWT("xid",f.capability,3,f.participantPid,"fixture-xid");
          // seed-comments already creates uid 2 at pid 2 without voting.
          tokens[`unvoted-anonymous-${f.zid}`] = issueParticipantJWT("anonymous",f.capability,2,2);
          tokens[`unvoted-standard-${f.zid}`] = issueParticipantJWT("standard_user",f.capability,2,2,"fixture|unvoted");
        }
        const f = fixtures.find(f => f.shape === "content-edges");
        const normal = tokens[`anonymous-${f.zid}`];
        const claims = JSON.parse(Buffer.from(normal.split(".")[1],"base64url"));
        for (const [name, patch] of Object.entries({
          missing:{uid:2147483646,sub:"anon:2147483646"},
          wrongPid:{pid:2147483646}, expired:{exp:1699999999}, future:{nbf:1700000010},
          wrongIssuer:{iss:"https://other.invalid/"}, wrongAudience:{aud:"other"},
        })) tokens[name] = sign({...claims,...patch},getPrivateKey(),{algorithm:"RS256"});
        tokens.tampered=normal.slice(0,-8)+"AAAAAAAA";
        res.setHeader("Content-Type","application/json");
        return res.end(JSON.stringify(tokens));
      }
      return listener(req,res);
    };
  }
  return original.apply(this,args);
};
require("/app/characterization/entry.cjs");
