"use strict";
// Isolated recorder controls. Loaded before the application; never in production.
exports.install = (_state) => {
  const { Client } = require("pg");
  const query = Client.prototype.query;
  let fault = null, fired = 0, language = "null-fallback", languageCalls = [];
  // Test dependency control, like comment-stored-first.test.ts. The real
  // detectLanguage validation and timeout run unchanged; no provider network.
  const Translate = require("@google-cloud/translate").v2.Translate;
  Translate.prototype.detect = function (text) {
    languageCalls.push({text, mode: language});
    if (language === "success") return Promise.resolve([{language:"fr",confidence:0.5}]);
    if (language === "timeout") return new Promise(() => {});
    if (language === "error") return Promise.reject(new Error("generated language provider failure"));
    return Promise.resolve([{language:null,confidence:null}]);
  };
  const matches = {
    insert: /INSERT INTO COMMENTS/i,
    participant: /INSERT INTO COMMENTS/i,
    foreign: /INSERT INTO COMMENTS/i,
    duplicate: /INSERT INTO COMMENTS/i,
    allocator: /INSERT INTO COMMENTS/i,
    vote: /INSERT INTO votes \(/i,
    notification: /insert into notification_tasks/i,
    interaction: /update participants set last_interaction/i,
    moderation: /select count\(\*\) from comments/i,
  };
  Client.prototype.query = function (...args) {
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
    if (fault && matches[fault].test(sql)) {
      const kind = fault;
      fault = null;
      fired++;
      const error = Object.assign(new Error("generated comment recording SQL failure"), {
        code: ["participant", "foreign"].includes(kind) ? "23503" : ["duplicate", "allocator"].includes(kind) ? "23505" : "XX000",
        constraint: {participant:"comments_zid_pid_fkey", foreign:"comments_uid_fkey", duplicate:"comments_zid_txt_key", allocator:"comments_zid_tid_key"}[kind],
      });
      const callback = args.at(-1);
      if (typeof callback === "function") { queueMicrotask(() => callback(error)); return; }
      return Promise.reject(error);
    }
    return query.apply(this, args);
  };
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/comments-fault") {
      const kind = url.searchParams.get("kind");
      if (kind !== "none" && !Object.hasOwn(matches, kind)) throw Error("unknown comment fault");
      fault = kind === "none" ? null : kind;
      language = url.searchParams.get("language") || "null-fallback";
      languageCalls = [];
      // Configuration is a test dependency control, never a serving edit.
      const config = require("../../src/config.ts").default;
      if (language !== "disabled" && !config.shouldUseTranslationAPI)
        throw Error("language profile must enable translation at process startup");
      fired = 0;
      res.end("{}"); return true;
    }
    if (url.pathname === "/comments-fault-state") {
      res.end(JSON.stringify({armed:fault,fired,languageCalls})); return true;
    }
    return false;
  };
};
