/* eslint-disable no-restricted-properties -- Bootstrap must read its environment before config.ts and application modules load. */
// Read-only startup gate. Uses the same raw SQL hashes, release-wide hold and
// forward-compatibility rule as polis-migrate (queue-rs/polis-migrate/src/compat.rs);
// no application modules or background loops load before it. A history row this
// release does not list is tolerated only when the release that applied it
// recorded it as additive (public.migrations.compat); otherwise startup refuses.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");
const isTrue = require("boolean");

async function checkMigrations() {
  const dir = process.env.POLIS_MIGRATIONS_DIR || path.resolve("postgres/migrations");
  function manifest(file) {
    const names = new Set();
    for (const name of fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).filter((s) => s && !s.startsWith("#"))) {
      if (name.trim() !== name || !/^\d{6}_[a-zA-Z0-9_]+\.sql$/.test(name) || names.has(name)) throw new Error(`Invalid or duplicate migration in ${file}: ${name}`);
      names.add(name);
    }
    return names;
  }
  const selected = manifest("release.txt");
  const held = manifest("held.txt");
  if ([...selected].some((name) => held.has(name))) throw new Error("Release and held manifests overlap");
  const known = new Set([...selected, ...held]);
  const declared = new Map();
  let compatText = null;
  try { compatText = fs.readFileSync(path.join(dir, "compat.txt"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const line of (compatText ?? "").split(/\r?\n/).filter((s) => s && !s.startsWith("#"))) {
    const fields = line.split(" ");
    if (fields.length !== 2 || !/^\d{6}_[a-zA-Z0-9_]+\.sql$/.test(fields[0]) || !["additive", "breaking"].includes(fields[1])) throw new Error(`Invalid line in compat.txt: ${line}`);
    if (!known.has(fields[0])) throw new Error(`compat.txt declares a migration absent from release/held manifest: ${fields[0]}`);
    if (declared.has(fields[0])) throw new Error(`Duplicate migration in compat.txt: ${fields[0]}`);
    declared.set(fields[0], fields[1]);
  }
  const required = new Map();
  const heldSums = new Map();
  const versions = new Set();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name.trim() !== name || !/^\d{6}_[a-zA-Z0-9_]+\.sql$/.test(name) || versions.has(name.slice(0, 6))) {
      throw new Error(`Invalid or duplicate migration: ${name}`);
    }
    versions.add(name.slice(0, 6));
    if (!fs.lstatSync(path.join(dir, name)).isFile()) throw new Error(`Non-file migration: ${name}`);
    const sum = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    if (held.has(name)) { held.delete(name); heldSums.set(name, sum()); continue; }
    if (!selected.delete(name)) throw new Error(`Migration absent from release/held manifest: ${name}`);
    required.set(name, sum());
  }
  if (held.size || selected.size || !required.has("000000_initial.sql")) throw new Error("Incomplete migration source directory");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migration check");
  const db = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000, application_name: "polis-startup-migrations",
    ssl: isTrue(process.env.DATABASE_SSL) ? { rejectUnauthorized: true } : undefined });
  try {
    await db.connect();
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
    // to_jsonb reads the declaration column when present (an earlier runner's table has none).
    const { rows } = await db.query("SELECT name,checksum,status,to_jsonb(m)->>'compat' AS compat FROM public.migrations m ORDER BY name");
    const numbers = new Map([...required.keys(), ...heldSums.keys()].map((name) => [name.slice(0, 6), name]));
    const tolerated = [];
    for (const row of rows) {
      if (!["APPLIED", "ADOPTED"].includes(row.status)) throw new Error(`Migration history mismatch: ${row.name}`);
      if (row.compat !== null && !["additive", "breaking"].includes(row.compat)) throw new Error(`Migration history mismatch: ${row.name} (invalid forward-compatibility declaration)`);
      if (required.has(row.name)) {
        if (required.get(row.name) !== row.checksum) throw new Error(`Migration history mismatch: ${row.name}`);
        required.delete(row.name);
        continue;
      }
      if (heldSums.has(row.name)) {
        if (heldSums.get(row.name) !== row.checksum) throw new Error(`Migration history mismatch: ${row.name}`);
      } else if (numbers.has(row.name.slice(0, 6))) {
        throw new Error(`Migration history mismatch: ${row.name}; this release numbers ${row.name.slice(0, 6)} as ${numbers.get(row.name.slice(0, 6))}`);
      }
      if (row.compat !== "additive") {
        throw new Error(`Migration history mismatch: ${row.name} is absent from this release and ${row.compat === "breaking" ? "declared breaking by the release that applied it" : "has no forward-compatibility declaration (counts as breaking)"}`);
      }
      tolerated.push(row.name);
    }
    if (required.size) throw new Error(`Pending migrations: ${[...required.keys()].join(", ")}; run polis-migrate apply`);
    await db.query("COMMIT");
    for (const name of tolerated) {
      process.stdout.write(`migration check: tolerating ${name}: applied by a release that declared it additive; this release does not list it\n`);
    }
  } catch (error) {
    // Database DETAIL may contain data. Print only our own errors or SQLSTATE.
    if (error.code) throw new Error(`Migration check failed (SQLSTATE ${error.code}); run polis-migrate check; reconcile legacy databases per docs/migrations.md`);
    throw error;
  } finally { await db.end(); }
}
module.exports = { checkMigrations };
if (require.main === module) checkMigrations().then(() => process.stdout.write("migration check ready\n"))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
