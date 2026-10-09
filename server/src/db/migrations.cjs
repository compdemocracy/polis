// Read-only startup gate. Uses the same raw SQL hashes and release-wide hold
// as polis-migrate; no application modules or background loops load before it.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const isTrue = require("boolean");

async function checkMigrations() {
  const dir = process.env.POLIS_MIGRATIONS_DIR || path.resolve("postgres/migrations");
  const held = new Set(fs.readFileSync(path.join(dir, "held.txt"), "utf8")
    .split(/\r?\n/).filter((s) => s && !s.startsWith("#")));
  const required = new Map();
  const versions = new Set();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (!/^\d{6}_[a-zA-Z0-9_]+\.sql$/.test(name) || versions.has(name.slice(0, 6))) {
      throw new Error(`Invalid or duplicate migration: ${name}`);
    }
    versions.add(name.slice(0, 6));
    if (!fs.lstatSync(path.join(dir, name)).isFile()) throw new Error(`Non-file migration: ${name}`);
    if (held.has(name)) { held.delete(name); continue; }
    required.set(name, crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"));
  }
  if (held.size || !required.has("000000_initial.sql")) throw new Error("Incomplete migration source directory");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migration check");
  const db = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000, application_name: "polis-startup-migrations",
    ssl: isTrue(process.env.DATABASE_SSL) ? { rejectUnauthorized: true } : undefined });
  try {
    await db.connect();
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
    const { rows } = await db.query("SELECT name,checksum,status FROM public.migrations ORDER BY name");
    for (const row of rows) {
      if (!required.has(row.name) || required.get(row.name) !== row.checksum || !["APPLIED", "ADOPTED"].includes(row.status)) {
        throw new Error(`Migration history mismatch: ${row.name}`);
      }
      required.delete(row.name);
    }
    if (required.size) throw new Error(`Pending migrations: ${[...required.keys()].join(", ")}; run polis-migrate apply`);
    await db.query("COMMIT");
  } catch (error) {
    // Database DETAIL may contain data. Print only our own errors or SQLSTATE.
    if (error.code) throw new Error(`Migration check failed (SQLSTATE ${error.code}); run polis-migrate check; reconcile legacy databases per docs/migrations.md`);
    throw error;
  } finally { await db.end(); }
}
module.exports = { checkMigrations };
if (require.main === module) checkMigrations().then(() => console.log("migration check ready"))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
