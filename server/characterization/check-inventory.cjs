"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createTwoFilesPatch } = require("diff");
const { extract, migrate } = require("./route-inventory.cjs");

const regenerate =
  'out="$(mktemp -d)/census" && node server/characterization/route-inventory.cjs . server/characterization/inventory.json "$out" "$(git rev-parse HEAD)" && cp "$out/inventory.json" server/characterization/inventory.json';

function summary(inventory, changes) {
  const rows = new Map(
    [...inventory.routes, ...inventory.retired].map((r) => [r.id, r])
  );
  const labels = new Map();
  const add = (id, label) => labels.set(id, [...(labels.get(id) || []), label]);
  for (const status of ["added", "retired", "reactivated"])
    for (const id of changes[status]) add(id, status);
  for (const route of changes.changed)
    for (const field of route.fields) add(route.id, field);
  const lines = [...labels].map(([id, fields]) => {
    const route = rows.get(id);
    return `${route.method} ${route.path} (id ${id}): ${fields.join(", ")}`;
  });
  if (changes.reordered)
    lines.push(
      `Route order changed: ${changes.oldOrder.join(
        ", "
      )} -> ${changes.newOrder.join(", ")}`
    );
  return lines.length
    ? lines.join("\n")
    : "No route changed; only registration lines, source metadata or JSON formatting differ.";
}

function check(root) {
  const file = path.join(root, "server/characterization/inventory.json");
  const original = fs.readFileSync(file, "utf8");
  const committed = JSON.parse(original);
  const current = extract(root);
  // Keep the recorded extraction commit: a subsequent commit alone is not drift.
  const { inventory, diff: changes } = migrate(committed, current.routes, {
    source_commit: committed.source_commit,
    source_sha256: current.source_sha256,
  });
  const regenerated = JSON.stringify(inventory, null, 2) + "\n";
  if (original === regenerated) return { status: 0, diff: "" };
  return {
    status: 1,
    message: `${summary(
      inventory,
      changes
    )}\n\nRegenerate from the repository root (requires dependencies installed with (cd server && npm ci --ignore-scripts --no-audit --no-fund)):\n${regenerate}\nCommit server/characterization/inventory.json with the app.ts change.\n\n`,
    diff: createTwoFilesPatch(
      "committed route census",
      "regenerated route census",
      original,
      regenerated
    ),
  };
}

module.exports = { check };
if (require.main === module) {
  const result = check(path.resolve(__dirname, "../.."));
  process.stdout.write(
    result.status
      ? result.message + result.diff
      : "PASS: committed route census matches source\n"
  );
  process.exitCode = result.status;
}
