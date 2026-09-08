"use strict";
const { hash } = require("./core.cjs");
const modes = ["unauthenticated", "participant", "owner", "admin"];
// Shapes mined from setup/api-test-helpers.ts, vote/conversation integration tests,
// e2e/cypress/support/{conversation,auth}-helpers.js and client calls in the inventory.
function generate(inventory, scope, seed = "p027-v1", profile = "boundary") {
  if (profile === "pca2") return require("./pca2-cases.cjs").pca2Cases(seed);
  const excluded = new Set(scope.exclusions.map((e) => e.id)),
    cases = [];
  for (const r of inventory.routes) {
    if (excluded.has(r.id)) continue;
    if (r.method === "ALL") {
      if (r.id === 3)
        for (const auth of modes)
          cases.push({
            caseId: `r3/${auth}/options`,
            routeId: 3,
            auth,
            case: "options",
            seed: hash(`${seed}/3/${auth}/options`).slice(0, 12),
            request: {
              method: "OPTIONS",
              path: "/api/v3/p027-options",
              query: {},
              headers: {
                accept: "application/json",
                origin: "https://example.invalid",
                "x-forwarded-proto": "https",
                ...(auth !== "unauthenticated"
                  ? { authorization: `$auth:${auth}` }
                  : {}),
              },
              body: null,
            },
          });
      continue;
    }
    for (const auth of modes) {
      const routeSeed = hash(`${seed}/${r.id}/${auth}`).slice(0, 12);
      const path = (r.id === 126 ? "/polis_site_id.generated" : r.path).replace(
        /:([\w]+)/g,
        (_, key) =>
          key === "reportId" || key === "report_id"
            ? "r2p027generated"
            : key === "conversation_id"
            ? "2p027generated"
            : key === "report_type"
            ? "comments.csv"
            : key === "xid_report"
            ? "00000000-0000-4000-8000-000000000027-xid.csv"
            : key === "zid" ||
              (profile === "nominal" && ["pmqid", "pmaid"].includes(key))
            ? "1"
            : `generated-${routeSeed}`
      );
      const request = {
        method: r.method,
        path,
        query: {},
        headers: {
          accept: "application/json",
          "x-forwarded-proto": "https",
          ...(auth !== "unauthenticated"
            ? { authorization: `$auth:${auth}` }
            : {}),
        },
        body: null,
      };
      if (!["GET", "HEAD", "OPTIONS"].includes(r.method)) {
        request.body = {};
        request.headers["content-type"] = "application/json";
      }
      // TEMPORARY P-029/r11 invalid UUID, P-029/r88 empty UPDATE, P-029/r102 NULL zid.
      // Retain diagnostic variants until the independently owned fixes land.
      // Explicit valid-shape exceptions: empty user updates produce invalid SQL;
      // admin report creation without a conversation tries to insert a NULL zid.
      if (r.id === 88) request.body = { hname: `Generated ${auth}` };
      if (r.id === 102) request.body = { conversation_id: "2p027generated" };
      if (profile === "nominal") {
        const values = {
          parent_url: "https://example.invalid/generated",
          conversation_id: "2p027generated",
          report_id: "r2p027generated",
          reportId: "r2p027generated",
          zid: 1,
          tid: 0,
          pid: 2,
          txt: `Generated ${routeSeed}`,
          vote: -1,
          topic: `Generated topic ${routeSeed}`,
          hname: `Generated ${auth}`,
          is_active: true,
          is_draft: false,
          profanity_filter: false,
          spam_filter: false,
          active: true,
          mod: 0,
          is_meta: false,
          velocity: 1,
          include: true,
          starred: 1,
          trashed: 1,
          email: "generated@example.invalid",
          emails: ["generated@example.invalid"],
          name: `Generated ${routeSeed}`,
          domain_whitelist: "example.invalid",
          type: 1,
          step: 1,
          pmqid: 1,
          pmaid: 1,
          pmaids: [],
          key: `generated-${routeSeed}`,
          value: "Generated answer",
          gid: 0,
          math_update_type: "recompute",
          filename: "generated-export.csv",
          button: "generated",
          xid_allow_list: [`generated-${routeSeed}`],
          e: "generated",
          einvite: "generated",
          invite_code: "generated",
          login_code: "generated",
          agreement_version: 1,
          github_id: "generated",
          company_name: "Generated",
          types: [1],
          times: [1700000000000],
          durs: [1],
          clientTimestamp: 1700000000000,
          webserver_username: "generated-worker",
          webserver_pass: "generated-worker",
          subject: "Generated subject",
          body: "Generated body",
        };
        const fields = {};
        for (const middleware of r.middleware) {
          const m = middleware.match(/^need\(\s*"([^"]+)"/);
          if (m && !r.path.includes(":" + m[1])) {
            if (!Object.hasOwn(values, m[1]))
              throw Error(`no generated required field ${r.id}/${m[1]}`);
            fields[m[1]] = values[m[1]];
          }
        }
        // Handwritten request shapes supplement the static required-parameter list.
        const extras = {
          18: ["conversation_id"],
          21: ["conversation_id"],
          44: ["conversation_id"],
          46: ["conversation_id"],
          52: ["report_id"],
          54: ["conversation_id"],
          55: ["report_id"],
          56: ["report_id"],
          57: ["conversation_id"],
          64: ["report_id"],
          65: ["report_id"],
          66: ["report_id"],
          75: ["conversation_id"],
          88: ["hname"],
          97: ["conversation_id"],
          99: ["conversation_id"],
          102: ["conversation_id"],
          107: [
            "topic",
            "is_active",
            "is_draft",
            "profanity_filter",
            "spam_filter",
          ],
        };
        for (const k of extras[r.id] || []) fields[k] = values[k];
        if (r.id === 22 || r.id === 23)
          fields.signature = "generated-invalid-signature";
        if (r.id === 9) fields.filename = values.filename;
        if (r.method === "GET") request.query = fields;
        else request.body = fields;
      }
      cases.push({
        caseId: `r${r.id}/${auth}/${profile}`,
        routeId: r.id,
        auth,
        case: profile,
        seed: routeSeed,
        request,
      });
      if (profile === "nominal" && [11, 88, 102].includes(r.id)) {
        const name =
          r.id === 11
            ? "invalid-uuid"
            : r.id === 88
            ? "empty-update"
            : "missing-conversation";
        const bad = structuredClone(request);
        if (r.id === 11)
          bad.path = `/api/v3/xid/generated-${routeSeed}-xid.csv`;
        else bad.body = {};
        cases.push({
          caseId: `r${r.id}/${auth}/${name}`,
          routeId: r.id,
          auth,
          case: name,
          seed: hash(`${seed}/${r.id}/${auth}/${name}`).slice(0, 12),
          request: bad,
        });
      }
    }
  }
  if (profile === "boundary") {
    const extra = generate(inventory, scope, seed, "nominal").filter(
      (c) =>
        [5, 43, 55, 77].includes(c.routeId) ||
        c.request.path === "/api/v3/participationInit"
    );
    for (const c of extra) {
      if (c.routeId === 75) c.request.query.includePCA = true;
      c.caseId = c.caseId.replace("/nominal", "/effects");
      c.case = "effects";
    }
    cases.push(...extra);
    cases.push(...require("./pca2-cases.cjs").pca2Cases(seed));
  }
  cases.push({
    caseId: "proxy-tail/unauthenticated/unmatched",
    routeId: null,
    auth: "unauthenticated",
    case: "proxy-tail",
    seed: hash(seed).slice(0, 12),
    request: {
      method: "GET",
      path: "/api/v3/p027-unmatched",
      query: {},
      headers: { accept: "text/html", "x-forwarded-proto": "https" },
      body: null,
    },
  });
  return cases;
}
module.exports = { generate, modes };
