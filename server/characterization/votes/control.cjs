"use strict";
// Harness-only SQL failure injection. The real route, auth, convention module
// and database statements remain unchanged. Each fault is explicit in evidence.
exports.install = (state, pair) => {
  const { Client } = require("pg");
  const query = Client.prototype.query;
  let fault = null, fired = 0, providerTokens = {};
  Client.prototype.query = function (...args) {
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
    const matches = {
      next: /get_visible_comments/i,
      star: /insert into stars/i,
      vote: /insert into votes \(/i,
      duplicate: /insert into votes \(/i,
      account: /SELECT uid FROM oidc_user_mappings WHERE oidc_sub/i,
      "account-conflict": /SELECT uid FROM oidc_user_mappings WHERE oidc_sub/i,
      "account-load": /SELECT uid FROM oidc_user_mappings WHERE oidc_sub/i,
      "translation-read": /select \* from comment_translations/i,
      "deferred-conversation": /update conversations set modified/i,
      "deferred-participant": /update participants set last_interaction/i,
      "deferred-count": /update participants set vote_count/i,
    };
    if (fault && matches[fault].test(sql)) {
      const kind = fault;
      fault = null;
      fired++;
      const error = Object.assign(new Error(kind === "account-load" ? "generated high concurrency" : "generated recording SQL failure"), {
        code: ["duplicate", "account-conflict"].includes(kind) ? "23505" : "XX000",
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
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/votes-provider-tokens" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      providerTokens = JSON.parse(Buffer.concat(chunks).toString());
      if (!Object.keys(providerTokens).every(key => key.startsWith("oidc-")))
        throw Error("unexpected provider fixture name");
      res.end("{}");
      return true;
    }
    if (url.pathname === "/votes-mode") {
      process.env.TOPICAL_COMMENT_RATIO = url.searchParams.get("topical") === "1" ? "1" : "0";
      res.end("{}");
      return true;
    }
    if (url.pathname === "/votes-fault") {
      const kind = url.searchParams.get("kind");
      if (!["next", "star", "vote", "duplicate", "account", "account-conflict", "account-load", "translation-read", "deferred-conversation", "deferred-participant", "deferred-count", "none"].includes(kind))
        throw Error("unknown vote recording fault");
      fault = kind === "none" ? null : kind;
      fired = 0;
      res.end("{}");
      return true;
    }
    if (url.pathname === "/votes-fault-state") {
      res.end(JSON.stringify({ armed: fault, fired }));
      return true;
    }
    if (url.pathname !== "/votes-tokens") return false;
    const anon = require("../../src/auth/anonymous-jwt.ts").issueAnonymousJWT;
    const xid = require("../../src/auth/xid-jwt.ts").issueXidJWT;
    const standard = require("../../src/auth/standard-user-jwt.ts").issueStandardUserJWT;
    const token = anon("2p027generated", 3, 2);
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    claims.iat -= 31536001;
    claims.exp -= 31536001;
    const signed = (original, changes) => require("jsonwebtoken").sign({
      ...JSON.parse(Buffer.from(original.split(".")[1], "base64url")),
      ...changes,
    }, pair.privateKey, { algorithm: "RS256" });
    const localTokens = {
      anonymous: token,
      standard: standard("generated-standard", "2p027generated", 3, 2),
      xid: xid("generated-member", "2p027generated", 3, 2),
    };
    const invalid = Object.fromEntries(Object.entries(localTokens).flatMap(([kind, value]) => [
      [kind + "-expired", signed(value, { exp: 1 })],
      [kind + "-issuer", signed(value, { iss: "https://invalid.example/" })],
      [kind + "-audience", signed(value, { aud: "generated-other" })],
      [kind + "-signature", value.slice(0, value.lastIndexOf(".") + 1) + "generated"],
    ]));
    res.end(JSON.stringify({
      ...providerTokens,
      ...invalid,
      "site-moderator": standard("generated-moderator", "2p027generated", 100004, Number(url.searchParams.get("moderatorPid") || 80)),
      "revoked-member": anon("2p027generated", 100006, Number(url.searchParams.get("removedPid") || 70)),
      "standard-no-pid": signed(localTokens.standard, { pid: undefined }),
      "foreign-standard": standard("generated-standard", "2p027foreign", 3, 2),
      "foreign-xid": xid("generated-member", "2p027foreign", 3, 2),
      "foreign-xid-other-owner": xid("generated-member", "2generatedotherowner", 100004, 0),
      "standard-nonmember": standard("generated-nonmember", "2p027generated", 100005, -1),
      "missing-member": anon("2p027generated", 100006, 70),
      "missing-member-zero": anon("2generatedempty", 100006, 0),
      pid0: anon("2p027generated", 1, 0),
      participant: token,
      standard: standard("generated-standard", "2p027generated", 3, 2),
      xid: xid("generated-member", "2p027generated", 3, 2),
      foreign: anon("2p027foreign", 3, 2),
      expired: require("jsonwebtoken").sign(claims, pair.privateKey, { algorithm: "RS256" }),
      bad: "generated-invalid-token",
      signature: token.slice(0, token.lastIndexOf(".") + 1) + "generated",
      publicKey: pair.publicKey,
    }));
    return true;
  };
};
