"use strict";
// Test-only schedule barrier. No query result, error, or product SQL is mocked.
require("ts-node/register/transpile-only");
const http = require("node:http");
const { Client } = require("pg");
const originalQuery = Client.prototype.query;
let race = null;
function invoke(client, args) {
  return new Promise((resolve, reject) =>
    originalQuery.call(client, ...args, (err, result) =>
      err ? reject(err) : resolve(result)
    )
  );
}
Client.prototype.query = function (...args) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
  if (
    !race ||
    !(
      /select id, wave_id, parent_invite_id, invite_used_by_pid from treevite_invites/i.test(
        sql
      ) || /update treevite_invites set status = 1/i.test(sql)
    )
  )
    return originalQuery.apply(this, args);
  const callback = typeof args.at(-1) === "function" ? args.pop() : null;
  const current = race;
  const promise = new Promise((resolve, reject) => {
    const task = () => invoke(this, args).then(resolve, reject);
    if (/^select/i.test(sql)) {
      invoke(this, args)
        .then((result) => {
          if (result.rows.length !== 1)
            throw Error("race requires two real unused reads");
          current.reads.push(() => resolve(result));
          current.events.push("unused-read");
          if (current.reads.length === 2) current.reads[0]();
        })
        .catch(reject);
    } else {
      current.updates.push(task);
      current.events.push("member-committed-before-consume");
      if (current.updates.length === 1) current.reads[1]();
      else if (current.updates.length === 2) {
        // Both memberships are committed before either compare-and-set executes.
        race = null;
        invoke(current.first.client, current.first.args).then((result) => {
          current.events.push("winner-consumed");
          current.first.resolve(result);
          task();
        }, current.first.reject);
      }
      if (current.updates.length === 1)
        current.first = { client: this, args, resolve, reject };
    }
  });
  if (callback) {
    promise.then(
      (r) => callback(null, r),
      (e) => callback(e)
    );
    return;
  }
  return promise;
};
let lastRace;
const createServer = http.createServer;
http.createServer = function (...args) {
  const i = args.findIndex((a) => typeof a === "function");
  if (i >= 0) {
    const listener = args[i];
    args[i] = (req, res) => {
      if (
        req.socket.localPort === 5001 &&
        req.url.startsWith("/treevite-race")
      ) {
        res.setHeader("content-type", "application/json");
        if (req.url === "/treevite-race-arm") {
          if (race) throw Error("race already armed");
          lastRace = race = { reads: [], updates: [], events: [] };
        }
        return res.end(
          JSON.stringify({
            armed: !!race,
            reads: lastRace?.reads.length || 0,
            updates: lastRace?.updates.length || 0,
            events: lastRace?.events || [],
          })
        );
      }
      return listener(req, res);
    };
  }
  return createServer.apply(this, args);
};
require("../entry.cjs");
