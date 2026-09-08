"use strict";
const { hash } = require("./core.cjs");
const plan = require("./comments-plan.json");
// Fixtures may be reused across actors, never across the three replicas in a cell.
const fixtureKey = (c) =>
  `${c.family}/${c.shape || c.codingProfile || c.mode}/${c.replicate || 1}`;
const fixtureMap = new Map();
for (const c of plan.cases) {
  const key = fixtureKey(c);
  if (!fixtureMap.has(key)) {
    const zid = 1000 + fixtureMap.size,
      replicate = c.replicate || 1;
    fixtureMap.set(key, {
      key,
      zid,
      capability: `2p027r6${zid}`,
      report: `r2p027r6${zid}`,
      owner: 200000 + replicate,
      replicate,
      participantPid: ["empty", "content-edges"].includes(c.shape) ? 0 : 1,
      family: c.family,
      shape: c.shape || c.codingProfile || "mix-strict-off",
      strict: c.shape?.endsWith("strict-on") || false,
      usage: c.usage,
    });
  }
}
const fixtures = [...fixtureMap.values()];
const actors = [
  {
    ref: "comments-owner-1",
    uid: 200001,
    username: "test.user.1@polis.test",
    site: "p027r6-shared",
  },
  {
    ref: "comments-owner-2",
    uid: 200002,
    username: "test.user.2@polis.test",
    site: "p027r6-shared",
  },
  {
    ref: "comments-owner-3",
    uid: 200003,
    username: "test.user.3@polis.test",
    site: "p027r6-shared",
  },
  {
    ref: "comments-moderator",
    uid: 200004,
    username: "moderator@polis.test",
    site: "p027r6-shared",
  },
  {
    ref: "comments-foreign",
    uid: 4,
    username: "test.user.4@polis.test",
    site: "p027r4-foreign",
  },
];
function commentsCases(seed = "p027-v1") {
  return plan.cases.map((c) => {
    const f = fixtureMap.get(fixtureKey(c));
    const actor =
      c.actor ||
      (c.mode.includes("jwt")
        ? "bound-participant"
        : c.mode === "valid-foreign-capability"
        ? "foreign-owner"
        : "anonymous");
    const auth = {
      anonymous: "unauthenticated",
      "bound-participant": "comments-participant",
      owner: "comments-owner",
      "site-sharing-moderator": "comments-moderator",
      "foreign-owner": "comments-foreign",
      admin: "admin",
    }[actor];
    if (!auth) throw Error(`unknown actor ${actor}`);
    let credential =
      {
        "comments-participant": `comments-participant-${f.zid}`,
        "comments-owner": `comments-owner-${f.replicate}`,
      }[auth] || auth;
    let query = { conversation_id: f.capability },
      body = null;
    const modes = {
      "limit-zero": { limit: 0 },
      "limit-negative": { limit: -1 },
      "limit-positive": { limit: 2 },
      "offset-only": { offset: 1 },
      "tids-empty": { tids: [] },
      "tids-list": { tids: "0,2" },
      "report-id": { report_id: f.report },
      "moderation-true": { moderation: true },
      "moderation-false": { moderation: false },
      mod: { mod: 0 },
      "modIn-true": { modIn: true },
      "modIn-false": { modIn: false },
      mod_gt: { mod_gt: 0 },
      "voting-patterns": { include_voting_patterns: true },
      "unknown-param": { p027_unknown: "generated" },
    };
    if (c.family === "dispatch") {
      if (c.mode === "tids-empty") body = { tids: [] };
      else if (c.mode === "repeated-param")
        query = [
          ["conversation_id", f.capability],
          ["limit", "1"],
          ["limit", "2"],
        ];
      else if (c.mode === "query-body-precedence") {
        query.limit = 1;
        body = { limit: 2 };
      } else Object.assign(query, modes[c.mode]);
    }
    if (c.mode === "missing-capability") delete query.conversation_id;
    if (c.mode === "malformed-capability")
      query.conversation_id = "!generated-invalid";
    if (c.mode === "nonexistent-capability")
      query.conversation_id = "2p027r6missing";
    if (c.mode === "expired-participant-jwt")
      credential = `comments-expired-${f.zid}`;
    if (c.mode === "cross-conversation-jwt")
      credential = `comments-participant-${fixtures[0].zid}`;
    return {
      caseId: c.id,
      routeId: 42,
      auth,
      case: c.family + "/" + (c.shape || c.codingProfile || c.mode),
      seed: hash(`${seed}/${c.id}`).slice(0, 12),
      request: {
        method: "GET",
        path: "/api/v3/comments",
        query,
        headers: {
          accept: "application/json",
          "x-forwarded-proto": "https",
          origin: "https://example.invalid",
          ...(actor === "anonymous"
            ? {}
            : { authorization: `$auth:${credential}` }),
          ...(c.negotiation === "gzip" ||
          c.codingProfile?.includes("accept-gzip")
            ? { "accept-encoding": "gzip" }
            : {}),
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        body,
      },
    };
  });
}
module.exports = {
  plan,
  fixtures,
  actors,
  fixtureKey,
  fixtureMap,
  commentsCases,
};
if (require.main === module)
  console.log(
    commentsCases()
      .map((c) => c.caseId)
      .join(",")
  );
