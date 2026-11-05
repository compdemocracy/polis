"use strict";

// Express keeps each mounted application's routes on that application.
function trackMounts(express) {
  const children = new WeakMap();
  const original = express.application.use;
  express.application.use = function (...args) {
    const result = original.apply(this, args);
    for (const child of args)
      if (typeof child === "function" && child.routes && child.handle) {
        const mounts = children.get(this) || [];
        mounts.push(child);
        children.set(this, mounts);
      }
    return result;
  };
  return function routes(root) {
    const seen = new Set();
    function visit(app) {
      if (seen.has(app)) throw Error("repeated or cyclic application mount");
      seen.add(app);
      return [
        ...Object.values(app.routes).flat(),
        ...(children.get(app) || []).flatMap(visit),
      ];
    }
    return visit(root);
  };
}

function routeIds(hits, inventory) {
  const enabled = inventory.routes.filter((r) => r.registered_in_default_config);
  return [...new Set(hits.map((hit) => {
    let matches = enabled.filter((r) =>
      r.method === hit.method && r.path === hit.path
    );
    if (matches.length > 1)
      matches = matches.filter((r) =>
        r.discriminator === "callback:" + hit.callback
      );
    if (matches.length !== 1)
      throw Error(`route hit has ${matches.length} census matches: ${JSON.stringify(hit)}`);
    return matches[0].id;
  }))].sort((a, b) => a - b);
}

module.exports = { trackMounts, routeIds };
