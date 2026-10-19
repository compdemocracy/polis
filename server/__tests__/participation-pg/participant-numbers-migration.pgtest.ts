/** Migration 000043 (the participant-number lock held to the end of the
 * transaction), through the real migration runner:
 *   - over a database that already has participants, `polis-migrate deploy`
 *     (what a deployment runs) applies only 000043, every stored participant
 *     and participant_count is unchanged, and numbering continues from
 *     MAX(pid) + 1;
 *   - the release before it still passes `check` beside it (declared additive);
 *   - its down restores the two triggers exactly as they were, and applying
 *     000043 again gives the same catalog;
 *   - on a fresh database the whole release gives that same catalog;
 *   - at deploy, a transaction still using participants makes the migration
 *     wait at most its 5 s lock_timeout and then fail with nothing changed, and
 *     a join sent while it waits is delayed by that wait, not refused.
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
const NAME = "000043_pid_auto_transaction_lock.sql";
const DOWN = path.join(
  MIGRATIONS,
  "down/000043_restore_pid_auto_session_lock.sql"
);
const DATABASES = ["m000043_upgrade", "m000043_fresh", "m000043_lock"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let admin: Client;
// The release just before 000043, and this release up to and including it.
let before000043: string;
let through000043: string;

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

/** This release with only the numbered migrations `keep` accepts: their
 * files and their release.txt and compat.txt lines. */
function releaseWith(keep: (name: string) => boolean): string {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "release-")),
    "migrations"
  );
  fs.cpSync(MIGRATIONS, dir, { recursive: true });
  const numbered = (name: string) => /^\d{6}_.*\.sql$/.test(name);
  for (const name of fs.readdirSync(dir))
    if (numbered(name) && !keep(name)) fs.rmSync(path.join(dir, name));
  for (const manifest of ["release.txt", "compat.txt"]) {
    const file = path.join(dir, manifest);
    const kept = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        const name = line.split(" ")[0];
        return !numbered(name) || keep(name);
      });
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

/** The participants triggers and the two functions, as the catalog has them. */
async function numberingCatalog(client: Client) {
  const triggers = (
    await client.query(`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgrelid = 'public.participants'::regclass AND NOT tgisinternal ORDER BY tgname`)
  ).rows;
  const functions = (
    await client.query(`SELECT proname, prosrc, proisstrict, provolatile, prorettype::regtype::text AS returns,
      pg_get_userbyid(proowner) AS owner, proacl::text AS acl
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('pid_auto', 'pid_auto_unlock')
    ORDER BY proname`)
  ).rows;
  return { triggers, functions };
}

/** Every participant, and the count pid_auto copies to each conversation. */
async function storedParticipants(client: Client) {
  return {
    participants: (
      await client.query("SELECT * FROM participants ORDER BY zid, pid")
    ).rows,
    counts: (
      await client.query(
        "SELECT zid, participant_count FROM conversations ORDER BY zid"
      )
    ).rows,
  };
}

/** Users for conversation 1 are 1001.., for conversation 2 are 2001..; the
 * caller's next join uses 1900 or 2900. */
async function seedParticipants(client: Client): Promise<void> {
  const owner = (
    await client.query(
      "INSERT INTO users (uid, created) VALUES (1000, default) RETURNING uid"
    )
  ).rows[0].uid;
  for (const zid of [1, 2]) {
    await client.query(
      "INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')",
      [zid, owner]
    );
    for (let i = 0; i < 3 + zid; i++) {
      const uid = (
        await client.query(
          "INSERT INTO users (uid, created) VALUES ($1, default) RETURNING uid",
          [zid * 1000 + 1 + i]
        )
      ).rows[0].uid;
      await client.query(
        "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default)",
        [zid, uid]
      );
    }
  }
  await client.query(
    "INSERT INTO users (uid, created) VALUES (1900, default), (2900, default)"
  );
}

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  for (const db of DATABASES)
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  before000043 = releaseWith((name) => name < NAME);
  through000043 = releaseWith((name) => name <= NAME);
});
afterAll(async () => {
  for (const db of DATABASES)
    await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin?.end();
  for (const release of [before000043, through000043])
    if (release)
      fs.rmSync(path.dirname(release), { recursive: true, force: true });
});

describe("migration 000043 through the runner", () => {
  let beforeCatalog: Awaited<ReturnType<typeof numberingCatalog>>;
  let afterCatalog: Awaited<ReturnType<typeof numberingCatalog>>;

  test("over a database that already has participants: deploy applies only 000043, every participant is unchanged, numbering continues", async () => {
    await admin.query("CREATE DATABASE m000043_upgrade");
    runner("m000043_upgrade", "deploy", before000043);
    await withDatabase("m000043_upgrade", async (client) => {
      await seedParticipants(client);
      beforeCatalog = await numberingCatalog(client);
      const stored = await storedParticipants(client);

      const out = runner("m000043_upgrade", "deploy", through000043);
      expect(
        out.split("\n").filter((line) => line.startsWith("APPLIED "))
      ).toEqual([`APPLIED ${NAME}`]);
      expect(out).toContain("applied 1 migration(s)");
      expect(runner("m000043_upgrade", "check", through000043)).toMatch(
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
          scenario: "000043 over existing participants",
          participants: stored.participants.length,
          triggers_before: beforeCatalog.triggers.map((t) => t.tgname),
          triggers_after: afterCatalog.triggers.map((t) => t.tgname),
        })}\n`
      );

      // Before: the session lock and its AFTER INSERT partner.
      expect(beforeCatalog.triggers.map((t) => t.tgname)).toEqual([
        "pid_auto",
        "pid_auto_unlock",
      ]);
      expect(beforeCatalog.functions[0].prosrc).toContain(
        "pg_advisory_lock(_magic_id, _conversation_id)"
      );
      // After: one BEFORE INSERT trigger, unchanged, and the transaction lock.
      expect(afterCatalog.triggers).toEqual([beforeCatalog.triggers[0]]);
      expect(afterCatalog.functions.map((f) => f.proname)).toEqual([
        "pid_auto",
      ]);
      const [was, now] = [
        beforeCatalog.functions[0],
        afterCatalog.functions[0],
      ];
      expect(now.prosrc).toContain(
        "pg_advisory_xact_lock(_magic_id, _conversation_id)"
      );
      expect(now.prosrc).not.toContain("pg_advisory_lock(");
      expect(now.prosrc).toContain("SELECT  COALESCE(MAX(pid) + 1, 0)");
      expect(now.prosrc).toContain("SET participant_count = NEW.pid + 1");
      expect({ ...now, prosrc: undefined }).toEqual({
        ...was,
        prosrc: undefined,
      });

      expect(await storedParticipants(client)).toEqual(stored);
      const next = (
        await client.query(
          "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, 2, 2900, default) RETURNING pid"
        )
      ).rows[0].pid;
      const inZid2 = stored.participants.filter((p) => p.zid === 2).length;
      expect(next).toBe(inZid2);
      expect(
        (
          await client.query(
            "SELECT participant_count FROM conversations WHERE zid = 2"
          )
        ).rows[0].participant_count
      ).toBe(inZid2 + 1);
    });
  }, 120000);

  test("the release before 000043 still runs beside it: check tolerates it as additive", () => {
    const out = runner("m000043_upgrade", "check", before000043);
    expect(out).toContain(`migration check: tolerating ${NAME}`);
    expect(out).toMatch(
      new RegExp(
        `^migration check: \\d+ ready; 1 newer additive migration\\(s\\) tolerated: ${NAME}$`,
        "m"
      )
    );
  });

  test("the down restores both triggers exactly as they were, and applying 000043 again gives the same catalog", async () => {
    await withDatabase("m000043_upgrade", async (client) => {
      const stored = await storedParticipants(client);
      await client.query(fs.readFileSync(DOWN, "utf8"));
      expect(await numberingCatalog(client)).toEqual(beforeCatalog);
      expect(await storedParticipants(client)).toEqual(stored);

      // The operator removes the history row in the same sitting; the release
      // then applies 000043 again.
      await client.query("DELETE FROM migrations WHERE name = $1", [NAME]);
      const out = runner("m000043_upgrade", "apply", through000043);
      expect(
        out.split("\n").filter((line) => line.startsWith("APPLIED "))
      ).toEqual([`APPLIED ${NAME}`]);
      expect(await numberingCatalog(client)).toEqual(afterCatalog);
      expect(await storedParticipants(client)).toEqual(stored);
    });
  }, 120000);

  test("at deploy, a transaction still using participants makes 000043 wait at most 5 s and fail with nothing changed; a join sent meanwhile is delayed, then stored", async () => {
    await admin.query("CREATE DATABASE m000043_lock");
    runner("m000043_lock", "deploy", before000043);
    const holder = await connect("m000043_lock");
    const joiner = await connect("m000043_lock");
    try {
      await seedParticipants(holder);
      const before = await numberingCatalog(holder);
      // A long transaction that has read participants (ACCESS SHARE until it
      // ends).
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM participants");

      // Relation oids are per database: read this one's from inside it.
      const participants = (
        await holder.query("SELECT 'public.participants'::regclass::oid AS oid")
      ).rows[0].oid;
      const started = Date.now();
      const deploying = runnerAsync("m000043_lock", "deploy", through000043);
      for (;;) {
        const waiting = (
          await admin.query(
            `SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.datname = 'm000043_lock' AND a.application_name = 'polis-migrate' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = 'm000043_lock') AND l.relation = $1`,
            [participants]
          )
        ).rows;
        if (waiting.length) {
          expect(waiting[0].mode).toBe("AccessExclusiveLock");
          break;
        }
        if (Date.now() - started > 4000)
          throw new Error("the migration never waited on participants");
        await sleep(20);
      }
      // A join sent while the migration waits queues behind its lock request.
      const sentAt = Date.now();
      const sent = joiner
        .query(
          "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, 1, 1900, default) RETURNING pid"
        )
        .then((r) => ({ ms: Date.now() - sentAt, pid: r.rows[0].pid }));

      const deployed = await deploying;
      const migrationMs = Date.now() - started;
      const stored = await sent;
      await holder.query("COMMIT");
      const history = (
        await joiner.query(
          "SELECT count(*)::int AS n FROM migrations WHERE name = $1",
          [NAME]
        )
      ).rows[0].n;
      process.stdout.write(
        `${JSON.stringify({
          scenario: "000043 at deploy behind a transaction using participants",
          migration_exit: deployed.code,
          migration_wait_ms: migrationMs,
          migration_error: deployed.stderr.trim().split("\n").pop(),
          join_sent_meanwhile_ms: stored.ms,
          join_pid: stored.pid,
        })}\n`
      );

      expect(deployed.code).not.toBe(0);
      // lock_not_available: the lock_timeout expired.
      expect(deployed.stderr).toContain("SQLSTATE 55P03");
      expect(migrationMs).toBeLessThan(5000 + 3000);
      expect(history).toBe(0);
      expect(await numberingCatalog(joiner)).toEqual(before);
      // Delayed by the migration's wait (never more than its lock_timeout plus
      // margin), then stored under the old trigger with the next number.
      expect(stored.ms).toBeLessThan(5000 + 3000);
      expect(stored.pid).toBe(4);

      // With the transaction gone, the next deploy applies it.
      expect(runner("m000043_lock", "deploy", through000043)).toContain(
        `APPLIED ${NAME}`
      );
    } finally {
      await holder.end().catch(() => undefined);
      await joiner.end().catch(() => undefined);
    }
  }, 120000);

  test("on a fresh database the whole release gives the same catalog", async () => {
    await admin.query("CREATE DATABASE m000043_fresh");
    const out = runner("m000043_fresh", "deploy");
    expect(out).toContain(`APPLIED ${NAME}`);
    expect(runner("m000043_fresh", "check")).toMatch(
      /^migration check: \d+ ready$/m
    );
    await withDatabase("m000043_fresh", async (client) => {
      expect(await numberingCatalog(client)).toEqual(afterCatalog);
    });
  }, 120000);
});
