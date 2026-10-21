"use strict";
// Historical replays retain all their original files and connection-local
// helpers. Only marked index files delegate to the deployment runner.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");

async function applyMigration(db, file, connectionString) {
  const source = fs.readFileSync(file, "utf8");
  const header = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() && !line.trimStart().startsWith("--")) break;
    header.push(line.trim());
  }
  if (!header.includes("-- polis-migrate: concurrent-indexes")) {
    await db.query(source);
    return;
  }
  // The caller must not retain a snapshot or uncommitted DDL while the
  // runner builds from another connection. Check the server's transaction.
  const { rows } = await db.query("SELECT xact_start = query_start AS idle FROM pg_stat_activity WHERE pid=pg_backend_pid()");
  if (rows[0]?.idle !== true) throw new Error("migration harness requires autocommit");
  const runner = process.env.POLIS_MIGRATE_BIN;
  const url = new URL(connectionString);
  if (!db.connectionParameters.ssl) url.searchParams.set("sslmode", "disable");
  execFileSync(runner || "cargo", [
    ...(runner ? [] : ["run", "--quiet", "--locked", "-p", "polis-migrate", "--"]),
    "prepare-indexes", "--file", path.resolve(file),
  ], { cwd: runner ? root : path.join(root, "queue-rs"), stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url.toString() } });
}
module.exports = { applyMigration };
