"use strict";
const crypto = require("node:crypto");
const canonical = (x) => JSON.stringify(sort(x));
function sort(x) {
  if (Array.isArray(x)) return x.map(sort);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, sort(x[k])])
    );
  return x;
}
const hash = (x) =>
  crypto
    .createHash("sha256")
    .update(typeof x === "string" || Buffer.isBuffer(x) ? x : canonical(x))
    .digest("hex");
function firstDiff(a, b, path = "$") {
  if (Object.is(a, b)) return null;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== "object"
  )
    return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (!Object.hasOwn(a, k) || !Object.hasOwn(b, k)) return `${path}.${k}`;
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
function delta(before, after) {
  const result = {};
  for (const table of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const b = new Map(),
      a = new Map();
    for (const row of before[table] || []) {
      const k = canonical(row);
      b.set(k, (b.get(k) || 0) + 1);
    }
    for (const row of after[table] || []) {
      const k = canonical(row);
      a.set(k, (a.get(k) || 0) + 1);
    }
    const removed = [],
      added = [];
    for (const k of [...new Set([...b.keys(), ...a.keys()])].sort()) {
      for (let n = 0; n < (b.get(k) || 0) - (a.get(k) || 0); n++)
        removed.push(JSON.parse(k));
      for (let n = 0; n < (a.get(k) || 0) - (b.get(k) || 0); n++)
        added.push(JSON.parse(k));
    }
    if (removed.length || added.length) result[table] = { removed, added };
  }
  return result;
}
const allMethods =
  "ACL BIND CHECKOUT CONNECT COPY DELETE GET HEAD LINK LOCK M-SEARCH MERGE MKACTIVITY MKCALENDAR MKCOL MOVE NOTIFY OPTIONS PATCH POST PROPFIND PROPPATCH PURGE PUT QUERY REBIND REPORT SEARCH SOURCE SUBSCRIBE TRACE UNBIND UNLINK UNLOCK UNSUBSCRIBE".split(
    " "
  );
function normalizeDump(dump, inventory) {
  if (!dump.ready) throw Error("route readiness barrier not satisfied");
  const groups = new Map();
  for (const r of dump.routes) {
    if (!groups.has(r.registrationIndex)) groups.set(r.registrationIndex, []);
    groups.get(r.registrationIndex).push(r);
  }
  const normalized = [...groups]
    .sort((a, b) => a[0] - b[0])
    .map(([registrationIndex, rs]) => {
      const r = rs[0];
      if (r.declaredMethod === "ALL") {
        if (
          rs.length !== 35 ||
          new Set(rs.map((x) => x.method)).size !== 35 ||
          rs.some((x) => x.path !== r.path || !allMethods.includes(x.method))
        )
          throw Error(`invalid ALL fan-out at ${registrationIndex}`);
      } else if (rs.length !== 1)
        throw Error(`duplicate runtime registration ${registrationIndex}`);
      return { method: r.declaredMethod, path: r.path, registrationIndex };
    });
  const expected = inventory.routes
    .filter((r) => r.registered_in_default_config)
    .map((r, i) => ({ method: r.method, path: r.path, registrationIndex: i }));
  const difference = firstDiff(expected, normalized);
  if (inventory.routes.length !== 201 || difference)
    throw Error(
      `route inventory mismatch: ${
        difference || "expected 201 source registrations"
      }`
    );
  return normalized.map((r, i) => ({ ...r, ...groups.get(i)[0] }));
}
function coverage(inventory, scope, cases) {
  const exclusions = new Map(scope.exclusions.map((x) => [x.id, x]));
  for (const e of exclusions.values()) {
    const r = inventory.routes.find((x) => x.id === e.id);
    if (!r || r.path !== e.path || r.method !== e.method || !e.reason)
      throw Error("invalid scope allowlist");
  }
  const rows = inventory.routes.map((r) => {
    const cs = cases.filter(
      (c) => c.routeId === r.id || c.routeHits?.includes(r.id)
    );
    const missingAuth =
      r.method === "ALL"
        ? []
        : ["unauthenticated", "participant", "owner", "admin"].filter(
            (a) => !cs.some((c) => c.auth === a)
          );
    return {
      id: r.id,
      route: `${r.method} ${r.path}`,
      cases: cs.length,
      status: exclusions.has(r.id)
        ? "OUT"
        : cs.length && !missingAuth.length
        ? "RECORDED"
        : "MISSING",
      reason:
        exclusions.get(r.id)?.reason ||
        (missingAuth.length ? `missing auth: ${missingAuth.join(", ")}` : ""),
    };
  });
  return {
    rows,
    recorded: rows.filter((r) => r.status === "RECORDED").length,
    excluded: exclusions.size,
    missing: rows.filter((r) => r.status === "MISSING").length,
  };
}
const readRecording = (...args) =>
  require("./recording.cjs").readRecording(...args);
function oracle(response, processErrors, proxyTail = false) {
  const failures = [];
  if (response.ttlbMs > 2000 || response.ttfbMs > 2000)
    failures.push("response timing bound exceeded");
  if (!response.completed) failures.push("completion deadline exceeded");
  if (processErrors.length) failures.push("process error during case");
  if (
    proxyTail &&
    !(
      response.headers["content-type"]?.includes("text/html") &&
      typeof response.body === "string" &&
      /<html/i.test(response.body)
    )
  )
    failures.push("proxy tail did not return proxied HTML");
  return {
    pass: !failures.length,
    failures,
    flag: proxyTail
      ? "proxied HTML: unmatched /api/v3 GET routed to static server"
      : null,
  };
}
module.exports = {
  canonical,
  sort,
  hash,
  firstDiff,
  delta,
  normalizeDump,
  allMethods,
  coverage,
  readRecording,
  oracle,
};

function coverageStats(cases) {
  const groups = new Map();
  for (const c of cases)
    if (c.routeId !== null) {
      if (!groups.has(c.routeId)) groups.set(c.routeId, []);
      groups.get(c.routeId).push(c);
    }
  const rows = [...groups].map(([routeId, cs]) => {
    const scenarios = [...new Set(cs.map((c) => c.case))];
    return {
      routeId,
      cases: cs.length,
      responses2xx: cs.filter(
        (c) => c.response.status >= 200 && c.response.status < 300
      ).length,
      roleInvariant: scenarios.every((s) => {
        const subset = cs.filter((c) => c.case === s);
        return (
          new Set(subset.map((c) => c.auth)).size === 4 &&
          new Set(
            subset.map((c) =>
              canonical({ status: c.response.status, body: c.response.body })
            )
          ).size === 1
        );
      }),
      dbEffectCases: cs.filter((c) => Object.keys(c.effects.db).length).length,
      participantEffectCases: cs.filter((c) => c.effects.participantCreated > 0)
        .length,
      jwtEffectCases: cs.filter((c) => c.effects.jwtIssued > 0).length,
      scenarios,
    };
  });
  return {
    cases: cases.length,
    statuses: cases.reduce((out, c) => {
      out[c.response.status] = (out[c.response.status] || 0) + 1;
      return out;
    }, {}),
    targetRegistrations: rows.length,
    registrationsWith2xx: rows.filter((r) => r.responses2xx).length,
    roleInvariantRegistrations: rows.filter((r) => r.roleInvariant).length,
    dbEffectCases: rows.reduce((n, r) => n + r.dbEffectCases, 0),
    participantEffectCases: rows.reduce(
      (n, r) => n + r.participantEffectCases,
      0
    ),
    jwtEffectCases: rows.reduce((n, r) => n + r.jwtEffectCases, 0),
    participantsCreated: cases.reduce(
      (n, c) => n + c.effects.participantCreated,
      0
    ),
    jwtsIssued: cases.reduce((n, c) => n + c.effects.jwtIssued, 0),
    rows,
  };
}
module.exports.coverageStats = coverageStats;
