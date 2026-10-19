/** Migration 000042 (the statement-number lock held to the end of the
 * transaction), through the real migration runner:
 *   - over a database that already has statements, `polis-migrate deploy` (what
 *     a deployment runs) applies only 000042, every stored statement is
 *     unchanged, and numbering continues from MAX(tid) + 1;
 *   - the release before it still passes `check` beside it (declared additive);
 *   - its down restores the two triggers exactly as they were, and applying
 *     000042 again gives the same catalog;
 *   - on a fresh database the whole release gives that same catalog;
 *   - at deploy, a transaction still using comments makes the migration wait
 *     at most its 5 s lock_timeout and then fail with nothing changed, and a
 *     statement sent while it waits is delayed by that wait, not refused.
 *
 * Each case makes its own database on the server DATABASE_URL names, and drops
 * it. The runner is the one scripts/test-delphi-result-reads.sh builds
 * (POLIS_MIGRATE_BIN overrides). Generated data only. */
import { Client } from "pg";
import { execFile, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "server/postgres/migrations");
const RUNNER =
  process.env.POLIS_MIGRATE_BIN ||
  path.join(ROOT, "queue-rs/target/debug/polis-migrate");
const NAME = "000042_tid_auto_transaction_lock.sql";
const DOWN = path.join(
  MIGRATIONS,
  "down/000042_restore_tid_auto_session_lock.sql"
);
const DATABASES = ["m000042_upgrade", "m000042_fresh", "m000042_lock"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let admin: Client;
let before000042: string;

function url(db: string): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.pathname = `/${db}`;
  return u.toString();
}

/** The runner's stdout; a refusal throws with its stderr. The DSN goes in the
 * environment, never in argv. */
function runner(db: string, command: string, dir = MIGRATIONS): string {
  return execFileSync(RUNNER, [command, "--dir", dir], {
    env: { ...process.env, DATABASE_URL: url(db) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The runner, without waiting for it: its exit code and output. */
function runnerAsync(
  db: string,
  command: string,
  dir = MIGRATIONS
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      RUNNER,
      [command, "--dir", dir],
      { env: { ...process.env, DATABASE_URL: url(db) }, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        })
    );
  });
}

/** This release without 000042: the release just before it. */
function releaseBefore000042(): string {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "release-")),
    "migrations"
  );
  fs.cpSync(MIGRATIONS, dir, { recursive: true });
  fs.rmSync(path.join(dir, NAME));
  for (const manifest of ["release.txt", "compat.txt"]) {
    const file = path.join(dir, manifest);
    const kept = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.split(" ")[0] !== NAME);
    fs.writeFileSync(file, kept.join("\n"));
  }
  return dir;
}

async function connect(db: string): Promise<Client> {
  const client = new Client({ connectionString: url(db) });
  await client.connect();
  return client;
}

async function withDatabase<T>(
  db: string,
  work: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connect(db);
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The comments triggers and the two functions, as the catalog has them. */
async function numberingCatalog(client: Client) {
  const triggers = (
    await client.query(`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgrelid = 'public.comments'::regclass AND NOT tgisinternal ORDER BY tgname`)
  ).rows;
  const functions = (
    await client.query(`SELECT proname, prosrc, proisstrict, provolatile, prorettype::regtype::text AS returns,
      pg_get_userbyid(proowner) AS owner, proacl::text AS acl
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('tid_auto', 'tid_auto_unlock')
    ORDER BY proname`)
  ).rows;
  return { triggers, functions };
}

async function storedStatements(client: Client) {
  return (await client.query("SELECT * FROM comments ORDER BY zid, tid")).rows;
}

async function seedStatements(client: Client): Promise<void> {
  const owner = (
    await client.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid"
    )
  ).rows[0].uid;
  for (const zid of [1, 2]) {
    await client.query(
      "INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')",
      [zid, owner]
    );
    const pid = (
      await client.query(
        "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
        [zid, owner]
      )
    ).rows[0].pid;
    for (let i = 0; i < 3 + zid; i++) {
      await client.query(
        "INSERT INTO comments (pid, zid, uid, txt, mod, tid) VALUES ($1, $2, $3, $4, $5, null)",
        [
          pid,
          zid,
          owner,
          `generated statement ${i} in conversation ${zid}`,
          i % 2,
        ]
      );
    }
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  for (const db of DATABASES)
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  before000042 = releaseBefore000042();
});
afterAll(async () => {
  for (const db of DATABASES)
    await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin?.end();
  if (before000042)
    fs.rmSync(path.dirname(before000042), { recursive: true, force: true });
});

describe("migration 000042 through the runner", () => {
  let beforeCatalog: Awaited<ReturnType<typeof numberingCatalog>>;
  let afterCatalog: Awaited<ReturnType<typeof numberingCatalog>>;

  test("over a database that already has statements: deploy applies only 000042, every statement is unchanged, numbering continues", async () => {
    await admin.query("CREATE DATABASE m000042_upgrade");
    runner("m000042_upgrade", "deploy", before000042);
    await withDatabase("m000042_upgrade", async (client) => {
      await seedStatements(client);
      beforeCatalog = await numberingCatalog(client);
      const statements = await storedStatements(client);

      const out = runner("m000042_upgrade", "deploy");
      expect(
        out.split("\n").filter((line) => line.startsWith("APPLIED "))
      ).toEqual([`APPLIED ${NAME}`]);
      expect(out).toContain("applied 1 migration(s)");
      expect(runner("m000042_upgrade", "check")).toMatch(
        /^migration check: \d+ ready$/m
      );
      expect(
        (
          await client.query(
            "SELECT status, compat FROM migrations WHERE name = $1",
            [NAME]
          )
        ).rows
      ).toEqual([{ status: "APPLIED", compat: "additive" }]);

      afterCatalog = await numberingCatalog(client);
      process.stdout.write(
        `${JSON.stringify({
          scenario: "000042 over existing statements",
          statements: statements.length,
          triggers_before: beforeCatalog.triggers.map((t) => t.tgname),
          triggers_after: afterCatalog.triggers.map((t) => t.tgname),
        })}\n`
      );

      // Before: the session lock and its AFTER INSERT partner.
      expect(beforeCatalog.triggers.map((t) => t.tgname)).toEqual([
        "tid_auto",
        "tid_auto_unlock",
      ]);
      expect(beforeCatalog.functions[0].prosrc).toContain(
        "pg_advisory_lock(_magic_id, _conversation_id)"
      );
      // After: one BEFORE INSERT trigger, unchanged, and the transaction lock.
      expect(afterCatalog.triggers).toEqual([beforeCatalog.triggers[0]]);
      expect(afterCatalog.functions.map((f) => f.proname)).toEqual([
        "tid_auto",
      ]);
      const [was, now] = [
        beforeCatalog.functions[0],
        afterCatalog.functions[0],
      ];
      expect(now.prosrc).toContain(
        "pg_advisory_xact_lock(_magic_id, _conversation_id)"
      );
      expect(now.prosrc).not.toContain("pg_advisory_lock(");
      expect(now.prosrc).toContain("SELECT  COALESCE(MAX(tid) + 1, 0)");
      expect({ ...now, prosrc: undefined }).toEqual({
        ...was,
        prosrc: undefined,
      });

      expect(await storedStatements(client)).toEqual(statements);
      const owner = statements[0].uid;
      const next = (
        await client.query(
          "INSERT INTO comments (pid, zid, uid, txt, tid) VALUES (0, 2, $1, 'after the migration', null) RETURNING tid",
          [owner]
        )
      ).rows[0].tid;
      expect(next).toBe(statements.filter((s) => s.zid === 2).length);
    });
  }, 120000);

  test("the release before 000042 still runs beside it: check tolerates it as additive", () => {
    const out = runner("m000042_upgrade", "check", before000042);
    expect(out).toContain(`migration check: tolerating ${NAME}`);
    expect(out).toMatch(
      new RegExp(
        `^migration check: \\d+ ready; 1 newer additive migration\\(s\\) tolerated: ${NAME}$`,
        "m"
      )
    );
  });

  test("the down restores both triggers exactly as they were, and applying 000042 again gives the same catalog", async () => {
    await withDatabase("m000042_upgrade", async (client) => {
      const statements = await storedStatements(client);
      await client.query(fs.readFileSync(DOWN, "utf8"));
      expect(await numberingCatalog(client)).toEqual(beforeCatalog);
      expect(await storedStatements(client)).toEqual(statements);

      // The operator removes the history row in the same sitting; the release
      // then applies 000042 again.
      await client.query("DELETE FROM migrations WHERE name = $1", [NAME]);
      const out = runner("m000042_upgrade", "apply");
      expect(
        out.split("\n").filter((line) => line.startsWith("APPLIED "))
      ).toEqual([`APPLIED ${NAME}`]);
      expect(await numberingCatalog(client)).toEqual(afterCatalog);
      expect(await storedStatements(client)).toEqual(statements);
    });
  }, 120000);

  test("at deploy, a transaction still using comments makes 000042 wait at most 5 s and fail with nothing changed; a statement sent meanwhile is delayed, then stored", async () => {
    await admin.query("CREATE DATABASE m000042_lock");
    runner("m000042_lock", "deploy", before000042);
    const holder = await connect("m000042_lock");
    const writer = await connect("m000042_lock");
    try {
      await seedStatements(holder);
      const before = await numberingCatalog(holder);
      // A long transaction that has read comments (ACCESS SHARE until it ends).
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM comments");

      // Relation oids are per database: read this one's from inside it.
      const comments = (
        await holder.query("SELECT 'public.comments'::regclass::oid AS oid")
      ).rows[0].oid;
      const started = Date.now();
      const deploying = runnerAsync("m000042_lock", "deploy");
      for (;;) {
        const waiting = (
          await admin.query(
            `SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.datname = 'm000042_lock' AND a.application_name = 'polis-migrate' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = 'm000042_lock') AND l.relation = $1`,
            [comments]
          )
        ).rows;
        if (waiting.length) {
          expect(waiting[0].mode).toBe("AccessExclusiveLock");
          break;
        }
        if (Date.now() - started > 4000)
          throw new Error("the migration never waited on comments");
        await sleep(20);
      }
      // A statement sent while the migration waits queues behind its lock request.
      const sentAt = Date.now();
      const sent = writer
        .query(
          "INSERT INTO comments (pid, zid, uid, txt, tid) VALUES (0, 1, (SELECT owner FROM conversations WHERE zid = 1), 'sent while the migration waits', null) RETURNING tid"
        )
        .then((r) => ({ ms: Date.now() - sentAt, tid: r.rows[0].tid }));

      const deployed = await deploying;
      const migrationMs = Date.now() - started;
      const stored = await sent;
      await holder.query("COMMIT");
      const history = (
        await writer.query(
          "SELECT count(*)::int AS n FROM migrations WHERE name = $1",
          [NAME]
        )
      ).rows[0].n;
      process.stdout.write(
        `${JSON.stringify({
          scenario: "000042 at deploy behind a transaction using comments",
          migration_exit: deployed.code,
          migration_wait_ms: migrationMs,
          migration_error: deployed.stderr.trim().split("\n").pop(),
          statement_sent_meanwhile_ms: stored.ms,
          statement_tid: stored.tid,
        })}\n`
      );

      expect(deployed.code).not.toBe(0);
      // lock_not_available: the lock_timeout expired.
      expect(deployed.stderr).toContain("SQLSTATE 55P03");
      expect(migrationMs).toBeLessThan(5000 + 3000);
      expect(history).toBe(0);
      expect(await numberingCatalog(writer)).toEqual(before);
      // Delayed by the migration's wait (never more than its lock_timeout plus
      // margin), then stored under the old trigger with the next number.
      expect(stored.ms).toBeLessThan(5000 + 3000);
      expect(stored.tid).toBe(4);

      // With the transaction gone, the next deploy applies it.
      expect(runner("m000042_lock", "deploy")).toContain(`APPLIED ${NAME}`);
    } finally {
      await holder.end().catch(() => undefined);
      await writer.end().catch(() => undefined);
    }
  }, 120000);

  test("on a fresh database the whole release gives the same catalog", async () => {
    await admin.query("CREATE DATABASE m000042_fresh");
    const out = runner("m000042_fresh", "deploy");
    expect(out).toContain(`APPLIED ${NAME}`);
    expect(runner("m000042_fresh", "check")).toMatch(
      /^migration check: \d+ ready$/m
    );
    await withDatabase("m000042_fresh", async (client) => {
      expect(await numberingCatalog(client)).toEqual(afterCatalog);
    });
  }, 120000);
});
