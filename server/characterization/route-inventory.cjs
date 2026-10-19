"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const key = (r) => JSON.stringify([r.method, r.path, r.discriminator || ""]);
const baseKey = (r) => JSON.stringify([r.method, r.path]);
const legacySelectors = new Map([
  [1, "callback:addCorsHeader"],
  [3, "callback:middleware_check_if_options"],
  [200, "condition:missingFilesGet404"],
  [201, "condition:!(missingFilesGet404)"],
]);
function validate(inventory) {
  const ids = new Set(),
    keys = new Set();
  for (const r of [...inventory.routes, ...(inventory.retired || [])]) {
    if (
      !Number.isSafeInteger(r.id) ||
      r.id < 1 ||
      ids.has(r.id) ||
      keys.has(key(r))
    )
      throw Error("duplicate/invalid stable route identity");
    ids.add(r.id);
    keys.add(key(r));
  }
  for (const r of inventory.retired || [])
    if (r.registered_in_default_config)
      throw Error("retired route cannot be enabled");
}
function migrate(previous, current, metadata = {}) {
  const prior = structuredClone(previous);
  if (prior.version === 1) {
    const groups = new Map();
    for (const r of prior.routes)
      groups.set(baseKey(r), (groups.get(baseKey(r)) || 0) + 1);
    for (const r of prior.routes)
      if (groups.get(baseKey(r)) > 1) {
        const selector = legacySelectors.get(r.id);
        if (!selector)
          throw Error("legacy duplicate needs an explicit selector");
        r.discriminator = selector;
      }
  }
  validate(prior);
  const old = [...prior.routes, ...(prior.retired || [])];
  const byKey = new Map(old.map((r) => [key(r), r]));
  const activeKeys = new Set(prior.routes.map(key));
  let next = Math.max(0, ...old.map((r) => r.id)) + 1;
  const seen = new Set();
  const routes = current.map((r) => {
    if (seen.has(key(r))) throw Error("ambiguous source route identity");
    seen.add(key(r));
    const found = byKey.get(key(r));
    return {
      ...r,
      id: found ? found.id : next++,
      consumer_family_inferred: found?.consumer_family_inferred || "operations",
    };
  });
  const retired = old
    .filter((r) => !seen.has(key(r)))
    .map((r) => ({ ...r, registered_in_default_config: false }));
  const inventory = { version: 2, ...metadata, routes, retired };
  validate(inventory);
  const changed = routes.flatMap((r) => {
    const before = byKey.get(key(r));
    if (!before) return [];
    const fields = [
      "middleware",
      "auth",
      "conditions",
      "registered_in_default_config",
    ].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(r[k]));
    return fields.length
      ? [{ id: r.id, method: r.method, path: r.path, fields }]
      : [];
  });
  const diff = {
    added: routes.filter((r) => !byKey.has(key(r))).map((r) => r.id),
    retired: retired.filter((r) => activeKeys.has(key(r))).map((r) => r.id),
    reactivated: routes
      .filter((r) => byKey.has(key(r)) && !activeKeys.has(key(r)))
      .map((r) => r.id),
    changed,
    oldOrder: prior.routes.filter((r) => seen.has(key(r))).map((r) => r.id),
    newOrder: routes.filter((r) => activeKeys.has(key(r))).map((r) => r.id),
    migration: old.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      discriminator: r.discriminator || "",
      status: seen.has(key(r)) ? "active" : "retired",
    })),
  };
  diff.reordered =
    JSON.stringify(diff.oldOrder) !== JSON.stringify(diff.newOrder);
  return { inventory, diff };
}
function extract(root) {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(root, "server/app.ts"), "utf8");
  const sf = ts.createSourceFile(
    "server/app.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const text = (n) => n.getText(sf).replace(/\s+/g, " ");
  const routes = [];
  const enabledConditions = new Map([
    ["missingFilesGet404", false],
    ["!(missingFilesGet404)", true],
    ["opsRoutes.active", false],
  ]);
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.expression.getText(sf) === "app" &&
      [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "all",
        "options",
        "head",
      ].includes(n.expression.name.text) &&
      n.arguments.length > 1
    ) {
      const args = [...n.arguments],
        a = args[0];
      if (
        !ts.isStringLiteral(a) &&
        a.kind !== ts.SyntaxKind.RegularExpressionLiteral
      )
        throw Error("nonliteral route path needs a reviewed identity");
      const method = n.expression.name.text.toUpperCase();
      const routePath = ts.isStringLiteral(a) ? a.text : text(a);
      const middleware = args.slice(1, -1).map(text);
      const conditions = [];
      for (let parent = n.parent; parent; parent = parent.parent)
        if (ts.isIfStatement(parent))
          conditions.push(
            n.pos >= parent.thenStatement.pos &&
              n.end <= parent.thenStatement.end
              ? text(parent.expression)
              : "!(" + text(parent.expression) + ")"
          );
      if (conditions.some((c) => !enabledConditions.has(c)))
        throw Error("unknown fixture route condition");
      const all = args.slice(1).map(text).join(" ");
      let auth = /\bhybridAuth\(/.test(all)
        ? "required hybrid auth"
        : /\bhybridAuthOptional\(/.test(all)
        ? "optional hybrid auth"
        : "no route authentication middleware";
      if (/ensureParticipant\(/.test(all))
        auth += "; participant required/created per middleware";
      else if (/ensureParticipantOptional/.test(all))
        auth += "; optional participant";
      let discriminator;
      if (method === "ALL" && routePath === "/api/v3/*") {
        const callback = text(args.at(-1));
        if (
          !["addCorsHeader", "middleware_check_if_options"].includes(callback)
        )
          throw Error("unknown duplicate callback selector");
        discriminator = "callback:" + callback;
      } else if (
        method === "GET" &&
        conditions.some((c) => c.includes("missingFilesGet404"))
      )
        discriminator = "condition:" + conditions.join(" && ");
      routes.push({
        method,
        path: routePath,
        registration:
          "server/app.ts:" +
          (sf.getLineAndCharacterOfPosition(n.getStart()).line + 1),
        middleware,
        auth,
        conditions,
        registered_in_default_config: conditions.every((c) =>
          enabledConditions.get(c)
        ),
        ...(discriminator ? { discriminator } : {}),
      });
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  // A registration moved into another module must not disappear from the census.
  function inspectDirectory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        inspectDirectory(file);
        continue;
      }
      if (!/\.[jt]s$/.test(file)) continue;
      const other = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      function inspect(n) {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ["app", "router"].includes(n.expression.expression.getText(other)) &&
          [
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "all",
            "options",
            "head",
          ].includes(n.expression.name.text) &&
          n.arguments.length > 1
        )
          throw Error(
            "route registration outside app.ts requires an explicit inventory extension"
          );
        ts.forEachChild(n, inspect);
      }
      inspect(other);
    }
  }
  inspectDirectory(path.join(root, "server/src"));
  return {
    routes,
    source_sha256: crypto.createHash("sha256").update(source).digest("hex"),
  };
}
function main(args) {
  const [root, priorPath, out, sourceCommit] = args;
  if (!root || !priorPath || !out || !/^[a-f0-9]{40}$/.test(sourceCommit || ""))
    throw Error(
      "usage: node route-inventory.cjs ROOT PREVIOUS OUTPUT_DIRECTORY SOURCE_COMMIT"
    );
  if (fs.existsSync(out)) throw Error("output directory must be new");
  const current = extract(root);
  const result = migrate(
    JSON.parse(fs.readFileSync(priorPath)),
    current.routes,
    { source_commit: sourceCommit, source_sha256: current.source_sha256 }
  );
  fs.mkdirSync(out, { recursive: true });
  for (const [name, value] of Object.entries(result))
    fs.writeFileSync(
      path.join(out, name + ".json"),
      JSON.stringify(value, null, 2) + "\n"
    );
  console.log(
    JSON.stringify({
      active: result.inventory.routes.length,
      retired: result.inventory.retired.length,
      added: result.diff.added,
      removed: result.diff.retired,
      changed: result.diff.changed.map((r) => r.id),
    })
  );
}
module.exports = { key, validate, migrate, extract };
if (require.main === module) main(process.argv.slice(2));
