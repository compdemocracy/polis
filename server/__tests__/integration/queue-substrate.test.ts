/**
 * P-024 Postgres queue substrate, first slice (noop only).
 *
 * The forty checks of cost-reduction/scripts/p024-queue-sql-smoke.py, ported to
 * run against the migrated schema rather than against the uninstalled SQL
 * specification. cost-reduction/scripts/p024-queue-sql-smoke.py stays as the
 * language-neutral spec harness; this file is the repository's regression test
 * for server/postgres/migrations/000019_create_polis_queue.sql.
 *
 * Two databases are used, for the same reason the harness provisions its own:
 *
 *   * The configured test database (DATABASE_URL). The migration is applied
 *     here in setup - a replay when the postgres image already baked it in from
 *     docker-entrypoint-initdb.d, a fresh apply otherwise - and every protocol,
 *     wire, lock and privilege check runs against the REAL public.conversations
 *     shape. Rows are namespaced by a per-run env prefix and removed afterwards.
 *
 *   * A scratch database created for this run, holding the harness's synthetic
 *     parent fixture. The fresh non-superuser apply and the two plan checks at
 *     20,000 rows live there: they insert 20,000 conversations and 20,000 jobs
 *     and delete parent rows, which must not happen in a shared test database.
 *
 * Requirements on the test login: it must be able to SET ROLE to
 * polis_queue_owner and polis_queue_executor, CREATE ROLE and CREATE DATABASE.
 * The repository's test.env and CI both use the postgres superuser, so this
 * holds. If yours does not, set POLIS_QUEUE_TEST_SKIP_ROLE_PROVISIONING=true:
 * the apply/replay and scale suites then report as skipped, with the reason in
 * the suite name, and the protocol suite still runs.
 *
 * Not claimed here: gates A1-A8. In particular no COMMIT has been severed, so
 * check 11 is a successful-function replay and not the A4 lost-acknowledgement
 * certificate, exactly as the harness says.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { Pool, PoolClient } from "pg";

dotenv.config({ override: false });

// The Node adapter's own wire pinning is the oracle for every reply below, so
// the adapter and the migration are checked against each other rather than
// against a second copy of the field list.
type EnqueueModule = typeof import("../../src/queue/enqueue");
type ProtocolModule = typeof import("../../src/queue/protocol");
type PgQueryModule = typeof import("../../src/db/pg-query");
let queue: EnqueueModule;
let protocol: ProtocolModule;
let pgQuery: PgQueryModule;

const MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "..",
  "postgres",
  "migrations",
  "000019_create_polis_queue.sql"
);
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, "utf8");

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/polis-dev";

const SKIP_PROVISIONING =
  String(process.env.POLIS_QUEUE_TEST_SKIP_ROLE_PROVISIONING || "")
    .toLowerCase()
    .trim() === "true";

const PROVISIONING_SKIP_REASON =
  "skipped: POLIS_QUEUE_TEST_SKIP_ROLE_PROVISIONING=true, so this test DB " +
  "login is not assumed to hold CREATE ROLE / CREATE DATABASE / SET ROLE";

const RUN_ID = randomUUID().replace(/-/g, "").slice(0, 10);
const ENV_PREFIX = `test-p024-${RUN_ID}-`;
const SCRATCH_DB = `pq_s1_${RUN_ID}`;
const ROLE_MIGRATOR = `pq_t_mig_${RUN_ID}`;
const ROLE_REPLAYER = `pq_t_rep_${RUN_ID}`;
const ROLE_STRANGER = `pq_t_str_${RUN_ID}`;
// Local, throwaway, never leaves this file or this run's cluster.
const ROLE_PASSWORD = `pq-local-test-${RUN_ID}`;

const H = "1".repeat(64);
const URI = "synthetic-input";
const OWNER = randomUUID();

const describeProvisioned = SKIP_PROVISIONING ? describe.skip : describe;

/* eslint-disable @typescript-eslint/no-explicit-any */
type QueueResult = any;

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = password ?? "";
  }
  return url.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

let mainPool: Pool;
let scratchPool: Pool;
/**
 * Set when role/database provisioning could not be done at all. CI's Postgres
 * login is the superuser, so this stays undefined there; a login that cannot
 * CREATE ROLE or CREATE DATABASE gets a named, actionable failure from the
 * tests that need it instead of an opaque "permission denied" mid-test.
 */
let provisioningFailure: Error | undefined;
/** Only what provisioning actually created is torn down. */
const created = {
  roles: [] as string[],
  scratchDatabase: false,
};
/** Real conversations.zid used by every protocol check. */
let zid = 0;
/** Synthetic parent zid inside the scratch database. */
const SCRATCH_ZID = 1;

// ---------------------------------------------------------------- primitives

async function runMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
  } finally {
    client.release();
  }
}

/** One-statement helper on a fresh pooled connection, as the owning login. */
async function sql(
  pool: { query(text: string, values?: unknown[]): Promise<any> },
  text: string,
  values: unknown[] = []
): Promise<any> {
  const result = await pool.query(text, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
}

async function rows(
  pool: Pool,
  text: string,
  values: unknown[] = []
): Promise<any[]> {
  const result = await pool.query(text, values);
  return result.rows;
}

interface CallOptions {
  timezone?: string;
  lockTimeout?: string;
}

/** Apply the /1 session policy the design document declares. */
async function applySessionPolicy(
  client: PoolClient,
  options: CallOptions = {}
): Promise<void> {
  await client.query("SET LOCAL ROLE polis_queue_executor");
  await client.query("SELECT set_config('TimeZone',$1,true)", [
    options.timezone ?? "UTC",
  ]);
  await client.query("SELECT set_config('lock_timeout',$1,true)", [
    options.lockTimeout ?? "500ms",
  ]);
  await client.query("SELECT set_config('statement_timeout','5s',true)");
  await client.query("SELECT set_config('transaction_timeout','10s',true)");
}

/**
 * Call one granted RPC in its own transaction as polis_queue_executor, with
 * every argument bound and explicitly cast. Nothing is interpolated.
 */
async function call(
  pool: Pool,
  name: string,
  casts: string[],
  args: unknown[],
  options: CallOptions = {}
): Promise<QueueResult> {
  const placeholders = casts.map((cast, i) => `$${i + 1}::${cast}`).join(",");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applySessionPolicy(client, options);
    const result = await client.query(
      `SELECT public.${name}(${placeholders}) AS r`,
      args
    );
    const value = result.rows[0].r;
    wire(value);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Assert the closed wire contract on every reply. Ordinary results are checked
 * by the Node adapter itself (src/queue/enqueue.ts), so the adapter's pinning
 * and the migration's output are verified against each other rather than
 * against a second copy of the field list.
 */
function wire(x: QueueResult): void {
  expect(x.schema_version).toBe("polis-queue/1");
  if (x.outcome === "reap_page") {
    expect(Object.keys(x).sort()).toEqual([
      "next_after_job_id",
      "outcome",
      "schema_version",
      "transitions",
    ]);
    for (const transition of x.transitions) wire(transition);
    return;
  }
  if (x.outcome === "head_status") {
    expect(Object.keys(x).sort()).toEqual([
      "desired_run_id",
      "desired_state",
      "env",
      "found",
      "outcome",
      "product_key",
      "published_generation",
      "published_run_id",
      "published_sha256",
      "schema_version",
    ]);
    expect(typeof x.found).toBe("boolean");
    return;
  }
  protocol.assertOrdinaryResult(x);
  for (const field of ["lease_epoch", "version", "mgmt_version"]) {
    expect(x[field] === null || /^\d+$/.test(x[field])).toBe(true);
  }
  for (const field of [
    "attempt_count",
    "max_attempts",
    "parked_attempt_count",
  ]) {
    expect(x[field] === null || Number.isInteger(x[field])).toBe(true);
  }
  for (const field of ["locked_until", "eligible_at", "first_parked_at"]) {
    expect(x[field] === null || String(x[field]).endsWith("+00:00")).toBe(true);
  }
  for (const field of [
    "env",
    "job_id",
    "run_id",
    "attempt_id",
    "owner_id",
    "state",
    "output_sha256",
    "stage",
    "stage_instance",
    "last_error_code",
  ]) {
    expect(x[field] === null || typeof x[field] === "string").toBe(true);
  }
}

interface EnqueueOptions {
  key?: string;
  product?: string;
  maxAttempts?: number;
  requestSha?: string;
  zid?: number;
}

function enqueue(
  pool: Pool,
  env: string,
  options: EnqueueOptions = {}
): Promise<QueueResult> {
  return call(
    pool,
    "pq_enqueue",
    [
      "text",
      "integer",
      "text",
      "text",
      "text",
      "text",
      "uuid",
      "uuid",
      "text",
      "text",
      "text",
      "text",
      "smallint",
      "integer",
    ],
    [
      env,
      options.zid ?? (pool === scratchPool ? SCRATCH_ZID : zid),
      options.product ?? "product",
      "synthetic-actor",
      options.key ?? "request",
      options.requestSha ?? H,
      randomUUID(),
      randomUUID(),
      URI,
      H,
      H,
      "synthetic-image",
      1,
      options.maxAttempts ?? 3,
    ]
  );
}

function claim(pool: Pool, env: string): Promise<QueueResult> {
  return call(
    pool,
    "pq_claim",
    ["text", "smallint", "uuid", "uuid", "integer"],
    [env, 1, OWNER, randomUUID(), 60]
  );
}

function token(j: QueueResult): unknown[] {
  return [j.env, j.job_id, OWNER, j.attempt_id, j.lease_epoch];
}

const TOKEN_CASTS = ["text", "uuid", "uuid", "uuid", "bigint"];

function finalize(
  pool: Pool,
  j: QueueResult,
  uri = URI,
  sha = H
): Promise<QueueResult> {
  return call(
    pool,
    "pq_finalize",
    [...TOKEN_CASTS, "text", "text"],
    [...token(j), uri, sha]
  );
}

async function due(
  pool: Pool,
  env: string,
  after: string | null = null,
  limit = 100
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE polis_queue_executor");
    const result = await client.query(
      "SELECT job_id FROM public.pq_due($1::text,$2::uuid,$3::integer)",
      [env, after, limit]
    );
    await client.query("COMMIT");
    return result.rows.map((row) => row.job_id);
  } finally {
    client.release();
  }
}

/**
 * The normative reaper loop: discovery commits, then every mutation gets its
 * own transaction, including the ones that return SQL NULL.
 */
async function reap(pool: Pool, env: string): Promise<QueueResult[]> {
  const transitions: QueueResult[] = [];
  for (const job of await due(pool, env)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applySessionPolicy(client);
      const result = await client.query(
        "SELECT public.pq_reap_one($1::text,$2::uuid) AS r",
        [env, job]
      );
      await client.query("COMMIT");
      const value = result.rows[0].r;
      if (value !== null) {
        wire(value);
        transitions.push(value);
      }
    } finally {
      client.release();
    }
  }
  return transitions;
}

/** Run `body` while another session holds `lockSql` in an open transaction. */
async function whileHolding(
  pool: Pool,
  lockSql: string,
  lockArgs: unknown[],
  body: () => Promise<void>
): Promise<void> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, lockArgs);
    await body();
    await holder.query("COMMIT");
  } catch (err) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    holder.release();
  }
}

function nodes(plan: any): any[] {
  const out = [plan];
  for (const child of plan.Plans ?? []) out.push(...nodes(child));
  return out;
}

/**
 * Guard for the tests that need a provisioning-capable login. Deliberately a
 * failure and not a silent pass: a missing capability is a real gap, and the
 * message says exactly how to report these as skipped instead.
 */
function requireProvisioning(): void {
  if (provisioningFailure) {
    throw new Error(
      "this test needs a test database login that can CREATE ROLE and CREATE " +
        "DATABASE; provisioning failed with: " +
        provisioningFailure.message +
        ". Set POLIS_QUEUE_TEST_SKIP_ROLE_PROVISIONING=true to report the " +
        "apply/replay and plans-at-scale suites as skipped instead."
    );
  }
}

/**
 * Drop the roles this run created, leaving nothing behind in a shared cluster.
 *
 * The replayer applies the migration with grant option, so the grants it makes
 * are recorded with it as the grantor and hold a shared dependency on it -
 * DROP ROLE then fails with "privileges for schema public". Only the grantor
 * can revoke those (REVOKE ... GRANTED BY requires the grantor to be the
 * current user), and only while it still holds the grant option, so the revoke
 * happens as that role and BEFORE DROP OWNED BY takes the option away. It
 * removes only the entries that role granted; the ones the migration made as
 * the main login survive.
 */
/** The pool shape dropCreatedRoles needs, so a control can supply a fake one. */
interface CleanupPool {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<any>;
    release(destroy?: boolean): void;
  }>;
}

async function dropCreatedRoles(
  pool: CleanupPool = mainPool,
  roles: { roles: string[] } = created
): Promise<void> {
  const failures: string[] = [];
  const client = await pool.connect();
  // A client whose session principal is not provably the login must not be
  // pooled. This is set BEFORE any identity-changing statement and cleared only
  // by a verified reset, so no path out of the loop can return an unverified
  // session to the pool - including one where the verification query itself
  // fails, which is unknown state rather than evidence that pooling is safe.
  let discard = false;
  let stop = false;
  try {
    const principal = async (): Promise<string> => {
      const answer = await client.query("SELECT current_user AS role");
      return answer.rows[0].role;
    };
    const login = await principal();

    /** Restore the login and prove it. Never throws; false means unknown. */
    const restore = async (role: string): Promise<boolean> => {
      try {
        await client.query("RESET ROLE");
      } catch (err) {
        failures.push(`${role}: RESET ROLE failed (${String(err)})`);
        return false;
      }
      try {
        if ((await principal()) !== login) {
          failures.push(`RESET ROLE did not restore ${login} after ${role}`);
          return false;
        }
      } catch (err) {
        failures.push(
          `${role}: could not verify the session principal after RESET ROLE (${String(
            err
          )})`
        );
        return false;
      }
      return true;
    };

    for (const role of roles.roles) {
      // The two REVOKEs below are grantor-specific: they are correct only while
      // the session actually IS this role. If the switch fails the session is
      // still the main login, and running them would withdraw grants this run
      // never made - the migration's own grants to polis_queue_owner and
      // polis_queue_executor - damaging the shared test schema during cleanup
      // of a faulted run. So a failed switch revokes nothing at all.
      try {
        await client.query(`SET ROLE ${role}`);
      } catch (err) {
        failures.push(
          `${role}: SET ROLE failed (${String(
            err
          )}); its grants were left in place`
        );
        // The session identity did not change, but that has to be established
        // rather than assumed, and the read itself can fail.
        try {
          if ((await principal()) !== login) {
            failures.push(
              `session principal is not ${login} after a failed SET ROLE`
            );
            discard = true;
            break;
          }
        } catch (readErr) {
          failures.push(
            `${role}: could not verify the session principal after a failed SET ROLE (${String(
              readErr
            )})`
          );
          discard = true;
          break;
        }
        continue;
      }

      // Identity changed. Unsafe to pool until a verified reset says otherwise,
      // whatever happens in between.
      discard = true;
      try {
        if ((await principal()) !== role) {
          throw new Error(
            `SET ROLE ${role} reported success without switching`
          );
        }
        try {
          // Only the grantor can revoke what it granted, and only while it
          // still holds the grant option, so this runs before DROP OWNED BY
          // takes the option away. It removes this role's entries and no
          // others.
          await client.query(
            "REVOKE ALL ON SCHEMA public FROM polis_queue_owner, polis_queue_executor CASCADE"
          );
          await client.query(
            "REVOKE ALL ON public.conversations FROM polis_queue_owner CASCADE"
          );
        } catch (err) {
          // A role that granted nothing here holds no privilege to revoke, and
          // PostgreSQL answers that with insufficient_privilege. That is the
          // normal case for the roles which never replayed the migration, not a
          // cleanup failure. If a revoke was genuinely needed and did not
          // happen, the role keeps its grantor dependency and the leaked-role
          // check below catches it.
          if ((err as { code?: string }).code !== "42501") {
            failures.push(
              `${role}: revoking its own grants failed (${String(err)})`
            );
          }
        }
      } catch (err) {
        failures.push(`${role}: cleanup as that role failed (${String(err)})`);
      } finally {
        // Every path out of the switched section restores and re-verifies.
        if (await restore(role)) {
          discard = false;
        } else {
          stop = true;
        }
      }
      if (stop) break;

      try {
        await client.query(`DROP OWNED BY ${role}`);
        await client.query(`DROP ROLE IF EXISTS ${role}`);
      } catch (err) {
        failures.push(`${role}: could not be dropped (${String(err)})`);
      }
    }

    if (!discard) {
      const leaked = await client.query(
        "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
        [roles.roles]
      );
      if (leaked.rowCount) {
        failures.push(
          "roles left behind: " +
            leaked.rows
              .map((row: { rolname: string }) => row.rolname)
              .join(", ")
        );
      }
    }
  } finally {
    client.release(discard);
  }
  // Incomplete cleanup fails the suite rather than printing a warning nobody
  // reads: a leaked role or a half-restored session is a real defect.
  if (failures.length > 0) {
    throw new Error(
      "queue substrate suite cleanup failed: " + failures.join("; ")
    );
  }
}

async function expectSqlState(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

// -------------------------------------------------------------------- setup

beforeAll(async () => {
  process.env.POLIS_QUEUE_SUBSTRATE_ENABLED = "true";
  protocol = await import("../../src/queue/protocol");
  queue = await import("../../src/queue/enqueue");
  pgQuery = await import("../../src/db/pg-query");

  mainPool = new Pool({ connectionString: BASE_DATABASE_URL, max: 12 });
  await runMigration(mainPool);
  zid = await sql(
    mainPool,
    "INSERT INTO conversations (topic, description) VALUES ($1, NULL) RETURNING zid",
    [`p024 queue substrate ${RUN_ID}`]
  );

  if (SKIP_PROVISIONING) return;

  try {
    await provision();
  } catch (err) {
    // Recorded rather than thrown: the protocol suite needs none of this and
    // must still run, and the tests that do need it then say so by name.
    provisioningFailure = err instanceof Error ? err : new Error(String(err));
  }
}, 180000);

/** Everything the apply/replay and plans-at-scale suites need. */
async function provision(): Promise<void> {
  await mainPool.query(
    `CREATE ROLE ${ROLE_MIGRATOR} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '${ROLE_PASSWORD}'`
  );
  created.roles.push(ROLE_MIGRATOR);
  await mainPool.query(
    `CREATE ROLE ${ROLE_REPLAYER} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '${ROLE_PASSWORD}'`
  );
  created.roles.push(ROLE_REPLAYER);
  await mainPool.query(
    `CREATE ROLE ${ROLE_STRANGER} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '${ROLE_PASSWORD}'`
  );
  created.roles.push(ROLE_STRANGER);
  // ADMIN without SET reproduces the PostgreSQL 17 shape that broke revision 3:
  // the migration must grant itself WITH SET TRUE before it can SET LOCAL ROLE.
  await mainPool.query(
    `GRANT polis_queue_owner TO ${ROLE_MIGRATOR} WITH ADMIN TRUE, SET FALSE`
  );
  await mainPool.query(`GRANT polis_queue_owner TO ${ROLE_REPLAYER}`);
  // The scale checks call granted RPCs in the scratch database, so the migrator
  // login also needs to be able to SET ROLE to the executor there.
  await mainPool.query(`GRANT polis_queue_executor TO ${ROLE_MIGRATOR}`);
  await mainPool.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE_REPLAYER} WITH GRANT OPTION`
  );
  await mainPool.query(
    `GRANT SELECT, REFERENCES(zid), UPDATE(topic) ON public.conversations ` +
      `TO ${ROLE_REPLAYER} WITH GRANT OPTION`
  );
  await mainPool.query(`CREATE DATABASE ${SCRATCH_DB}`);
  created.scratchDatabase = true;
  await mainPool.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE_MIGRATOR} WITH GRANT OPTION`
  );

  const bootstrap = new Pool({ connectionString: urlFor(SCRATCH_DB), max: 2 });
  try {
    await bootstrap.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE_MIGRATOR} WITH GRANT OPTION`
    );
  } finally {
    await bootstrap.end();
  }

  scratchPool = new Pool({
    connectionString: urlFor(SCRATCH_DB, ROLE_MIGRATOR, ROLE_PASSWORD),
    max: 8,
  });
  await scratchPool.query(
    "CREATE TABLE public.conversations(zid SERIAL, topic VARCHAR(1000), " +
      "description VARCHAR(50000), UNIQUE(zid))"
  );
  await scratchPool.query(
    "INSERT INTO public.conversations VALUES (1,'synthetic',NULL),(2,'synthetic',NULL)"
  );
}

afterAll(async () => {
  if (mainPool) {
    for (const table of [
      "polis_queue_requests",
      "polis_queue_attempts",
      "polis_queue_jobs",
      "polis_queue_heads",
      "polis_queue_runs",
    ]) {
      await mainPool
        .query(`DELETE FROM public.${table} WHERE env LIKE $1`, [
          `${ENV_PREFIX}%`,
        ])
        .catch(() => undefined);
    }
    if (zid) {
      await mainPool
        .query("DELETE FROM conversations WHERE zid = $1", [zid])
        .catch(() => undefined);
    }
  }
  if (scratchPool) await scratchPool.end().catch(() => undefined);
  if (mainPool && created.scratchDatabase) {
    // A leftover connection makes DROP DATABASE fail and leaks the database
    // into a shared cluster, so close them first.
    await mainPool
      .query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [SCRATCH_DB]
      )
      .catch(() => undefined);
    await mainPool
      .query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
      .catch(() => undefined);
  }
  // Only roles this run actually created, so a half-finished provisioning
  // still releases what it made and touches nothing else.
  if (mainPool && created.roles.length > 0) await dropCreatedRoles();
  if (mainPool) await mainPool.end().catch(() => undefined);
}, 120000);

// ------------------------------------------------- 1-5 apply, replay, refuse

describeProvisioned(
  SKIP_PROVISIONING
    ? `P-024 migration apply and replay (${PROVISIONING_SKIP_REASON})`
    : "P-024 migration apply and replay",
  () => {
    it("applies fresh over a representative parent fixture as a non-superuser migrator", async () => {
      requireProvisioning();
      // The NOLOGIN roles already exist cluster-wide, so this exercises fresh
      // object creation, the ADMIN-without-SET self-grant and the parent grants,
      // not first-time role creation.
      expect(
        await sql(
          scratchPool,
          "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        )
      ).toBe(false);
      await runMigration(scratchPool);
      expect(
        await sql(scratchPool, "SELECT to_regclass('public.polis_queue_jobs')")
      ).toBe("polis_queue_jobs");
    }, 60000);

    it("replays for the same non-superuser migrator against a matching schema", async () => {
      requireProvisioning();
      await runMigration(scratchPool);
      expect(
        await sql(
          scratchPool,
          "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n " +
            "ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pq\\_%'"
        )
      ).toBe(21);
    }, 60000);

    it("replays for a superuser against the real conversations schema", async () => {
      requireProvisioning();
      await runMigration(mainPool);
      expect(
        await sql(mainPool, "SELECT to_regclass('public.polis_queue_runs')")
      ).toBe("polis_queue_runs");
    }, 60000);

    it("replays for a non-owner login through explicitly provisioned owner membership", async () => {
      requireProvisioning();
      const pool = new Pool({
        connectionString: urlFor(
          databaseNameOf(BASE_DATABASE_URL),
          ROLE_REPLAYER,
          ROLE_PASSWORD
        ),
        max: 1,
      });
      try {
        expect(
          await sql(
            pool,
            "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
          )
        ).toBe(false);
        await runMigration(pool);
      } finally {
        await pool.end();
      }
    }, 60000);

    it("never pools a session whose principal it could not verify", async () => {
      requireProvisioning();
      // Astra's 22012 injection: the verification read fails AFTER SET ROLE has
      // succeeded. The connection is fine, so "the query failed" is not
      // evidence that the socket is gone - the session is simply still acting
      // as the helper, and returning it to the pool hands that identity to the
      // next borrower.
      const helper = `pq_t_ver_${RUN_ID}`;
      const login = await sql(mainPool, "SELECT current_user");
      await mainPool.query(`CREATE ROLE ${helper}`);
      const raw = await mainPool.connect();
      let reads = 0;
      let released: boolean | undefined;
      const injected: CleanupPool = {
        connect: async () => ({
          query: async (text: string, values?: unknown[]) => {
            if (text === "SELECT current_user AS role" && (reads += 1) === 2) {
              return raw.query("SELECT 1/0");
            }
            return raw.query(text, values as unknown[]);
          },
          // Record the decision instead of acting on it, so the session can be
          // inspected afterwards.
          release: (destroy?: boolean) => {
            released = destroy;
          },
        }),
      };
      try {
        await expect(
          dropCreatedRoles(injected, { roles: [helper] })
        ).rejects.toThrow(/cleanup failed/);
        const principal = await sql(raw, "SELECT current_user");
        // The invariant: a session is pooled only when it is provably the
        // login again. Either it was restored and verified, or it is destroyed.
        if (released === false) {
          expect(principal).toBe(login);
        } else {
          expect(released).toBe(true);
        }
        // Nothing was revoked on the way through.
        expect(
          await sql(
            mainPool,
            "SELECT has_schema_privilege('polis_queue_owner','public','USAGE')"
          )
        ).toBe(true);
      } finally {
        raw.release(true);
        await mainPool
          .query(`DROP ROLE IF EXISTS ${helper}`)
          .catch(() => undefined);
      }
    }, 30000);

    it("refuses an unprovisioned login with a readable precondition", async () => {
      requireProvisioning();
      const pool = new Pool({
        connectionString: urlFor(
          databaseNameOf(BASE_DATABASE_URL),
          ROLE_STRANGER,
          ROLE_PASSWORD
        ),
        max: 1,
      });
      try {
        await expect(runMigration(pool)).rejects.toThrow(
          /requires membership in polis_queue_owner/
        );
      } finally {
        await pool.end();
      }
    }, 60000);
  }
);

// ------------------------------------- 6-29, 31-37, 39-40 protocol behaviour

describe("P-024 queue substrate protocol", () => {
  it("runs on PostgreSQL 17", async () => {
    expect(
      String(await sql(mainPool, "SHOW server_version_num")).slice(0, 2)
    ).toBe("17");
  });

  it("6. enqueues idempotently and conflicts on a changed digest", async () => {
    const env = `${ENV_PREFIX}idem`;
    const a = await enqueue(mainPool, env);
    const b = await enqueue(mainPool, env);
    expect(a.input.sha256).toBe(H);
    expect(a.input.uri).toBe(URI);
    expect(b.run_id).toBe(a.run_id);
    expect(b.outcome).toBe("existing");
    expect(
      (await enqueue(mainPool, env, { requestSha: "2".repeat(64) })).outcome
    ).toBe("conflict");
  }, 30000);

  it("7. grants 8 concurrent claims distinct jobs and then reports none", async () => {
    const env = `${ENV_PREFIX}concurrent`;
    for (let i = 0; i < 8; i += 1) {
      await enqueue(mainPool, env, { key: String(i) });
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claim(mainPool, env))
    );
    expect(claims.every((j) => j.outcome === "owned")).toBe(true);
    expect(new Set(claims.map((j) => j.job_id)).size).toBe(8);
    expect((await claim(mainPool, env)).outcome).toBe("none");
  }, 60000);

  describe("a single claimed job", () => {
    const env = `${ENV_PREFIX}final`;
    let j: QueueResult;

    beforeAll(async () => {
      await enqueue(mainPool, env);
      j = await claim(mainPool, env);
    }, 30000);

    it("8. renews version on heartbeat without changing epoch", async () => {
      const h = await call(
        mainPool,
        "pq_heartbeat",
        [...TOKEN_CASTS, "integer"],
        [...token(j), 60]
      );
      expect(h.outcome).toBe("owned");
      expect(h.lease_epoch).toBe(j.lease_epoch);
      expect(Number(h.version)).toBeGreaterThan(Number(j.version));
    });

    it("9. fences a heartbeat with the wrong epoch", async () => {
      const wrong = token(j);
      wrong[4] = String(Number(j.lease_epoch) + 1);
      const r = await call(
        mainPool,
        "pq_heartbeat",
        [...TOKEN_CASTS, "integer"],
        [...wrong, 60]
      );
      expect(r.outcome).toBe("fenced");
    });

    it("10. admits only the captured output digest", async () => {
      expect((await finalize(mainPool, j, URI, "2".repeat(64))).outcome).toBe(
        "invalid_output"
      );
    });

    it("11. replays a successful finalization (no transport fault injected)", async () => {
      expect((await finalize(mainPool, j)).outcome).toBe("succeeded");
      expect((await finalize(mainPool, j)).outcome).toBe("already_succeeded");
    });
  });

  it("12. transfers an expired lease and fences every old-token write", async () => {
    const env = `${ENV_PREFIX}expire`;
    await enqueue(mainPool, env);
    const old = await claim(mainPool, env);
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET locked_until = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    expect(
      (
        await call(
          mainPool,
          "pq_heartbeat",
          [...TOKEN_CASTS, "integer"],
          [...token(old), 60]
        )
      ).outcome
    ).toBe("fenced");
    expect((await finalize(mainPool, old)).outcome).toBe("fenced");
    const reaped = await reap(mainPool, env);
    expect(reaped[0].outcome).toBe("retry_wait");
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET eligible_at = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    const fresh = await claim(mainPool, env);
    expect(Number(fresh.lease_epoch)).toBeGreaterThan(Number(old.lease_epoch));
    expect(
      (await call(mainPool, "pq_release", TOKEN_CASTS, token(old))).outcome
    ).toBe("fenced");
    expect(
      (
        await call(
          mainPool,
          "pq_fail",
          [...TOKEN_CASTS, "boolean", "text"],
          [...token(old), false, "synthetic"]
        )
      ).outcome
    ).toBe("fenced");
    expect((await finalize(mainPool, old)).outcome).toBe("fenced");
    expect((await finalize(mainPool, fresh)).outcome).toBe("succeeded");
  }, 60000);

  it("13. refuses to move a newer product pointer with an older completed run", async () => {
    const env = `${ENV_PREFIX}order`;
    await enqueue(mainPool, env, { key: "old" });
    const old = await claim(mainPool, env);
    await enqueue(mainPool, env, { key: "new" });
    const fresh = await claim(mainPool, env);
    expect((await finalize(mainPool, fresh)).published).toBe(true);
    expect((await finalize(mainPool, old)).published).toBe(false);
    expect(
      await sql(
        mainPool,
        "SELECT published_run_id::text FROM public.polis_queue_heads WHERE env = $1",
        [env]
      )
    ).toBe(fresh.run_id);
  }, 60000);

  it("14. rejects a pointer regression at the schema level", async () => {
    const env = `${ENV_PREFIX}order`;
    await expectSqlState(
      mainPool.query(
        "UPDATE public.polis_queue_heads SET published_generation = 0 WHERE env = $1",
        [env]
      ),
      "23514"
    );
  }, 30000);

  it("15. terminalizes immediately on attempt exhaustion", async () => {
    const env = `${ENV_PREFIX}budget`;
    await enqueue(mainPool, env, { maxAttempts: 1 });
    const j = await claim(mainPool, env);
    expect(
      (
        await call(
          mainPool,
          "pq_fail",
          [...TOKEN_CASTS, "boolean", "text"],
          [...token(j), false, "synthetic"]
        )
      ).outcome
    ).toBe("dead");
    expect((await claim(mainPool, env)).outcome).toBe("none");
  }, 30000);

  it("16. resumes a park through the reaper without a new enqueue", async () => {
    const env = `${ENV_PREFIX}park`;
    await enqueue(mainPool, env);
    const j = await claim(mainPool, env);
    expect(
      (
        await call(
          mainPool,
          "pq_park",
          [...TOKEN_CASTS, "text"],
          [...token(j), "synthetic"]
        )
      ).outcome
    ).toBe("parked");
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET eligible_at = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    expect((await reap(mainPool, env))[0].outcome).toBe("queued");
    expect((await claim(mainPool, env)).outcome).toBe("owned");
  }, 60000);

  it("17. revokes ownership through a management cancellation CAS", async () => {
    const env = `${ENV_PREFIX}cancel`;
    await enqueue(mainPool, env);
    const j = await claim(mainPool, env);
    expect(
      (
        await call(
          mainPool,
          "pq_cancel",
          ["text", "uuid", "bigint"],
          [env, j.job_id, String(Number(j.mgmt_version) + 1)]
        )
      ).outcome
    ).toBe("conflict");
    expect(
      (
        await call(
          mainPool,
          "pq_cancel",
          ["text", "uuid", "bigint"],
          [env, j.job_id, j.mgmt_version]
        )
      ).outcome
    ).toBe("cancelled");
    expect(
      (await call(mainPool, "pq_release", TOKEN_CASTS, token(j))).outcome
    ).toBe("fenced");
  }, 30000);

  it("18. denies the executor any direct table write", async () => {
    const client = await mainPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE polis_queue_executor");
      await expectSqlState(
        client.query("UPDATE public.polis_queue_jobs SET state = 'queued'"),
        "42501"
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }, 30000);

  describe("held product head", () => {
    const env = `${ENV_PREFIX}heartbeat`;
    let j: QueueResult;

    beforeAll(async () => {
      await enqueue(mainPool, env);
      j = await claim(mainPool, env);
    }, 30000);

    it("19. renews a heartbeat while another transaction holds the head", async () => {
      await whileHolding(
        mainPool,
        "SELECT 1 FROM public.polis_queue_heads WHERE env = $1 FOR UPDATE",
        [env],
        async () => {
          const r = await call(
            mainPool,
            "pq_heartbeat",
            [...TOKEN_CASTS, "integer"],
            [...token(j), 60]
          );
          expect(r.outcome).toBe("owned");
        }
      );
    }, 30000);

    it("20. serializes the wire in UTC for a non-UTC caller", async () => {
      const r = await call(
        mainPool,
        "pq_heartbeat",
        [...TOKEN_CASTS, "integer"],
        [...token(j), 60],
        { timezone: "America/Los_Angeles" }
      );
      expect(String(r.locked_until).endsWith("+00:00")).toBe(true);
    });

    it("21. accepts the claim-era management version after two heartbeats", async () => {
      const r = await call(
        mainPool,
        "pq_cancel",
        ["text", "uuid", "bigint"],
        [env, j.job_id, j.mgmt_version]
      );
      expect(r.outcome).toBe("cancelled");
    });
  });

  it("22. reports a suppressed success as boolean false and separates content from identity", async () => {
    const env = `${ENV_PREFIX}suppressed`;
    await enqueue(mainPool, env, { key: "old" });
    const j = await claim(mainPool, env);
    await enqueue(mainPool, env, { key: "new" });
    expect((await finalize(mainPool, j)).published).toBe(false);
    const replay = await finalize(mainPool, j);
    expect(replay.outcome).toBe("already_succeeded");
    expect(replay.published).toBe(false);
    expect((await finalize(mainPool, j, URI, "2".repeat(64))).outcome).toBe(
      "invalid_output"
    );
    const wrong = token(j);
    wrong[3] = randomUUID();
    expect(
      (
        await call(
          mainPool,
          "pq_finalize",
          [...TOKEN_CASTS, "text", "text"],
          [...wrong, URI, H]
        )
      ).outcome
    ).toBe("fenced");
  }, 60000);

  it("23. retains and resumes a run parked on its last budgeted attempt", async () => {
    const env = `${ENV_PREFIX}park-budget`;
    await enqueue(mainPool, env, { maxAttempts: 1 });
    const j = await claim(mainPool, env);
    const parked = await call(
      mainPool,
      "pq_park",
      [...TOKEN_CASTS, "text"],
      [...token(j), "dependency"]
    );
    expect(parked.outcome).toBe("parked");
    expect(parked.parked_attempt_count).toBe(1);
    expect(
      (
        await call(
          mainPool,
          "pq_park",
          [...TOKEN_CASTS, "text"],
          [...token(j), "stale"]
        )
      ).outcome
    ).toBe("fenced");
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET eligible_at = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    expect((await reap(mainPool, env))[0].outcome).toBe("queued");
    const fresh = await claim(mainPool, env);
    expect(fresh.attempt_count).toBe(2);
    expect((await finalize(mainPool, fresh)).outcome).toBe("succeeded");
  }, 60000);

  it("24. lets the owner row-lock the parent through topic but never update zid", async () => {
    expect(
      await sql(
        mainPool,
        "SELECT has_column_privilege('polis_queue_owner','public.conversations','topic','UPDATE')"
      )
    ).toBe(true);
    expect(
      await sql(
        mainPool,
        "SELECT has_column_privilege('polis_queue_owner','public.conversations','zid','UPDATE')"
      )
    ).toBe(false);
  }, 30000);

  it("25. records expiry through the shared terminalization primitive", async () => {
    expect(
      await sql(
        mainPool,
        "SELECT outcome FROM public.polis_queue_attempts WHERE env = $1 ORDER BY lease_epoch LIMIT 1",
        [`${ENV_PREFIX}expire`]
      )
    ).toBe("expired");
  }, 30000);

  it("26. admits a captured expected output through the same finalize code", async () => {
    const env = `${ENV_PREFIX}descriptor`;
    await enqueue(mainPool, env);
    const j = await claim(mainPool, env);
    // Owner-only control standing in for a Q21 enqueuer change, not an
    // executor mutation: the executor has no table write at all.
    await mainPool.query(
      "UPDATE public.polis_queue_runs SET expected_output_uri = 'synthetic-output', " +
        "expected_output_sha256 = $2 WHERE env = $1",
      [env, "3".repeat(64)]
    );
    expect((await finalize(mainPool, j)).outcome).toBe("invalid_output");
    expect(
      (await finalize(mainPool, j, "synthetic-output", "3".repeat(64))).outcome
    ).toBe("succeeded");
    expect(
      (await finalize(mainPool, j, "synthetic-output", "3".repeat(64))).outcome
    ).toBe("already_succeeded");
  }, 60000);

  it("27. exposes a desired failure and the retained published pointer", async () => {
    const env = `${ENV_PREFIX}status`;
    await enqueue(mainPool, env, { key: "old" });
    const j = await claim(mainPool, env);
    expect((await finalize(mainPool, j)).published).toBe(true);
    await enqueue(mainPool, env, { key: "new", maxAttempts: 1 });
    const fresh = await claim(mainPool, env);
    expect(
      (
        await call(
          mainPool,
          "pq_fail",
          [...TOKEN_CASTS, "boolean", "text"],
          [...token(fresh), true, "synthetic_failure"]
        )
      ).outcome
    ).toBe("dead");
    const status = await call(
      mainPool,
      "pq_head_status",
      ["text", "text"],
      [env, "product"]
    );
    expect(status.desired_state).toBe("dead");
    expect(status.published_run_id).toBe(j.run_id);
    expect(
      (
        await call(
          mainPool,
          "pq_head_status",
          ["text", "text"],
          [`${ENV_PREFIX}missing`, "product"]
        )
      ).found
    ).toBe(false);
  }, 60000);

  it("28. replays an enqueue without contending for the product head", async () => {
    const env = `${ENV_PREFIX}replay`;
    await enqueue(mainPool, env);
    await whileHolding(
      mainPool,
      "SELECT 1 FROM public.polis_queue_heads WHERE env = $1 FOR UPDATE",
      [env],
      async () => {
        expect((await enqueue(mainPool, env)).outcome).toBe("existing");
      }
    );
  }, 30000);

  it("29. leaves no running row without a lease across every reply checked", async () => {
    expect(
      await sql(
        mainPool,
        "SELECT count(*)::int FROM public.polis_queue_jobs " +
          "WHERE state = 'running' AND locked_until IS NULL"
      )
    ).toBe(0);
  }, 30000);

  it.each([
    ["pq_release", [] as unknown[], ["retry_wait"]],
    ["pq_fail", [false, "synthetic"], ["retry_wait"]],
    ["pq_park", ["dependency"], ["parked"]],
  ])(
    "31-33. %s succeeds under a held head while the full-prefix finalize control blocks",
    async (action, extra, expected) => {
      const env = `${ENV_PREFIX}head-${action}`;
      const casts: Record<string, string[]> = {
        pq_release: TOKEN_CASTS,
        pq_fail: [...TOKEN_CASTS, "boolean", "text"],
        pq_park: [...TOKEN_CASTS, "text"],
      };
      await enqueue(mainPool, env);
      const j = await claim(mainPool, env);
      await whileHolding(
        mainPool,
        "SELECT 1 FROM public.polis_queue_heads WHERE env = $1 FOR UPDATE",
        [env],
        async () => {
          // Establishes the held-lock oracle: a transition that does write the
          // head must still contend for it.
          await expectSqlState(finalize(mainPool, j), "55P03");
          const result = await call(mainPool, action, casts[action], [
            ...token(j),
            ...extra,
          ]);
          expect(result.outcome).toBe(expected[0]);
          if (action === "pq_release") {
            expect(result.last_error_code).toBeNull();
            expect((await claim(mainPool, env)).outcome).toBe("owned");
          }
        }
      );
    },
    60000
  );

  it("34. supplies the management CAS token without mutating, and types a missing job", async () => {
    const env = `${ENV_PREFIX}job-status`;
    const a = await enqueue(mainPool, env);
    const before = await sql(
      mainPool,
      "SELECT row_to_json(j) FROM public.polis_queue_jobs j WHERE env = $1",
      [env]
    );
    const r = await call(
      mainPool,
      "pq_job_status",
      ["text", "uuid"],
      [env, a.job_id]
    );
    expect(r.state).toBe("queued");
    expect(r.mgmt_version).toBe("0");
    expect(
      await sql(
        mainPool,
        "SELECT row_to_json(j) FROM public.polis_queue_jobs j WHERE env = $1",
        [env]
      )
    ).toEqual(before);
    expect(
      (
        await call(
          mainPool,
          "pq_job_status",
          ["text", "uuid"],
          [env, randomUUID()]
        )
      ).job_id
    ).toBeNull();
    expect(
      (
        await call(
          mainPool,
          "pq_cancel",
          ["text", "uuid", "bigint"],
          [env, a.job_id, r.mgmt_version]
        )
      ).outcome
    ).toBe("cancelled");
  }, 60000);

  it("35. keeps the first park age across 12 parks and does not inflate the first real retry", async () => {
    const env = `${ENV_PREFIX}parks`;
    await enqueue(mainPool, env, { maxAttempts: 2 });
    let first: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const j = await claim(mainPool, env);
      const r = await call(
        mainPool,
        "pq_park",
        [...TOKEN_CASTS, "text"],
        [...token(j), "dependency"]
      );
      expect(r.outcome).toBe("parked");
      expect(r.parked_attempt_count).toBe(i + 1);
      if (first === null) first = r.first_parked_at;
      expect(r.first_parked_at).toBe(first);
      await mainPool.query(
        "UPDATE public.polis_queue_jobs SET eligible_at = clock_timestamp() - interval '1 second' WHERE env = $1",
        [env]
      );
      expect((await reap(mainPool, env))[0].outcome).toBe("queued");
    }
    const j = await claim(mainPool, env);
    const failed = await call(
      mainPool,
      "pq_fail",
      [...TOKEN_CASTS, "boolean", "text"],
      [...token(j), false, "synthetic"]
    );
    expect(failed.outcome).toBe("retry_wait");
    expect(
      Number(
        await sql(
          mainPool,
          "SELECT extract(epoch FROM eligible_at - updated_at) FROM public.polis_queue_jobs WHERE env = $1",
          [env]
        )
      )
    ).toBeLessThan(10);
    expect(
      (await call(mainPool, "pq_job_status", ["text", "uuid"], [env, j.job_id]))
        .first_parked_at
    ).toBe(first);
  }, 180000);

  it("36. reaps 30 products one committed transaction per job, holding no earlier run or head", async () => {
    const env = `${ENV_PREFIX}reap`;
    for (let i = 0; i < 30; i += 1) {
      await enqueue(mainPool, env, { key: String(i), product: `product-${i}` });
      await claim(mainPool, env);
    }
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET locked_until = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    const ids = await due(mainPool, env);
    expect(ids).toHaveLength(30);

    const first = await mainPool.connect();
    try {
      await first.query("BEGIN");
      await applySessionPolicy(first);
      wire(
        (
          await first.query(
            "SELECT public.pq_reap_one($1::text,$2::uuid) AS r",
            [env, ids[0]]
          )
        ).rows[0].r
      );
      await first.query("COMMIT");
    } finally {
      first.release();
    }

    const held = await mainPool.connect();
    try {
      await held.query("BEGIN");
      await applySessionPolicy(held);
      wire(
        (
          await held.query(
            "SELECT public.pq_reap_one($1::text,$2::uuid) AS r",
            [env, ids[1]]
          )
        ).rows[0].r
      );
      // The previous job's run lock is gone: NOWAIT would raise if it were not.
      const observer = await mainPool.connect();
      try {
        await observer.query("BEGIN");
        await observer.query(
          "SELECT 1 FROM public.polis_queue_runs WHERE env = $1 AND run_id = " +
            "(SELECT run_id FROM public.polis_queue_jobs WHERE env = $1 AND job_id = $2) " +
            "FOR UPDATE NOWAIT",
          [env, ids[0]]
        );
        await observer.query("COMMIT");
      } finally {
        observer.release();
      }
      // No product head is held either.
      for (const product of ["product-0", "product-29"]) {
        expect(
          (await enqueue(mainPool, env, { key: `new-${product}`, product }))
            .outcome
        ).toBe("enqueued");
      }
      await held.query("COMMIT");
    } finally {
      held.release();
    }

    expect(await reap(mainPool, env)).toHaveLength(28);
  }, 180000);

  it("37. skips a busy reaper row and recovers it on the next pass", async () => {
    const env = `${ENV_PREFIX}skip`;
    for (let i = 0; i < 2; i += 1) {
      await enqueue(mainPool, env, { key: String(i) });
      await claim(mainPool, env);
    }
    await mainPool.query(
      "UPDATE public.polis_queue_jobs SET locked_until = clock_timestamp() - interval '1 second' WHERE env = $1",
      [env]
    );
    const ids = await due(mainPool, env);
    expect(ids).toHaveLength(2);
    await whileHolding(
      mainPool,
      "SELECT 1 FROM public.polis_queue_jobs WHERE env = $1 AND job_id = $2 FOR UPDATE",
      [env, ids[0]],
      async () => {
        expect((await reap(mainPool, env)).map((r) => r.job_id)).toEqual([
          ids[1],
        ]);
      }
    );
    expect((await reap(mainPool, env)).map((r) => r.job_id)).toEqual([ids[0]]);
  }, 120000);

  it("39. pins search_path and UTC on every function, updates no conversation, and withholds CREATE grant option", async () => {
    const functions = await rows(
      mainPool,
      "SELECT proname, proconfig, prosrc FROM pg_proc " +
        "WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'pq\\_%'"
    );
    expect(functions).toHaveLength(21);
    for (const fn of functions) {
      expect(fn.proconfig).toContain("search_path=pg_catalog, pg_temp");
      expect(fn.proconfig).toContain("TimeZone=UTC");
      expect(fn.prosrc).not.toMatch(/UPDATE\s+(?:public\.)?conversations\b/i);
    }
    expect(
      await sql(
        mainPool,
        "SELECT has_schema_privilege('polis_queue_owner','public','CREATE WITH GRANT OPTION')"
      )
    ).toBe(false);
  }, 30000);

  it("40. grants EXECUTE to the executor on exactly the twelve RPCs", async () => {
    const acl = await rows(
      mainPool,
      "SELECT p.proname, has_function_privilege('polis_queue_executor', p.oid, 'EXECUTE') AS granted " +
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE n.nspname = 'public' AND p.proname LIKE 'pq\\_%'"
    );
    const granted = acl
      .filter((row) => row.granted)
      .map((row) => row.proname)
      .sort();
    expect(granted).toEqual([
      "pq_cancel",
      "pq_claim",
      "pq_due",
      "pq_enqueue",
      "pq_fail",
      "pq_finalize",
      "pq_head_status",
      "pq_heartbeat",
      "pq_job_status",
      "pq_park",
      "pq_reap_one",
      "pq_release",
    ]);
    expect(acl.length).toBeGreaterThan(granted.length);
  }, 30000);

  it("pins the migration SHA-256 that both adapters were written against", () => {
    expect(protocol.migrationSha256()).toBe(protocol.QUEUE_SQL_SHA256);
  });

  it("enqueues through the Node adapter inside one withTransaction", async () => {
    const env = `${ENV_PREFIX}node-adapter`;
    const request = {
      env,
      zid,
      productKey: "product",
      actorScope: "synthetic-actor",
      requestKey: "adapter",
      priority: 1,
      maxAttempts: 3,
    };
    const first = await queue.enqueueNoopJob(request);
    expect(first.outcome).toBe("enqueued");
    expect(first.result.stage).toBe("noop");
    expect(first.result.input).toEqual({
      uri: queue.NOOP_INPUT_URI,
      sha256: queue.NOOP_INPUT_SHA256,
      config_sha256: queue.NOOP_INPUT_SHA256,
      code_image_digest: queue.NOOP_IMAGE_DIGEST,
    });
    const replay = await queue.enqueueNoopJob(request);
    expect(replay.outcome).toBe("existing");
    expect(replay.result.run_id).toBe(first.result.run_id);
    // The digest covers every semantic input, so the same key with a changed
    // retry policy is a conflict rather than a silent second job.
    const changed = await queue.enqueueNoopJob({ ...request, maxAttempts: 4 });
    expect(changed.outcome).toBe("conflict");
    expect(changed.requestSha256).not.toBe(first.requestSha256);
  }, 60000);

  it("puts the declared session bounds in effect on a real connection", async () => {
    const settings = await pgQuery.default.withTransaction(async (client) => {
      const reply = await client.query(
        "SELECT current_setting('TimeZone') AS tz, current_setting('lock_timeout') AS lt, " +
          "current_setting('statement_timeout') AS st, current_setting('transaction_timeout') AS tt"
      );
      return reply.rows[0];
    });
    expect(settings).toEqual({
      tz: "UTC",
      lt: "500ms",
      st: "5s",
      tt: "10s",
    });
  }, 30000);

  it("refuses to report success when a swallowed statement error aborted the transaction", async () => {
    await expect(
      pgQuery.default.withTransaction(async (client) => {
        try {
          await client.query("SELECT 1/0");
        } catch {
          // A caller that swallows this leaves the transaction aborted, and
          // PostgreSQL then answers COMMIT with a ROLLBACK command tag.
        }
        return 42;
      })
    ).rejects.toThrow("transaction_was_aborted");
  }, 30000);

  it("survives its backend being terminated between queries, and the pool recovers", async () => {
    await expect(
      pgQuery.default.withTransaction(async (client) => {
        const reply = await client.query("SELECT pg_backend_pid() AS pid");
        await mainPool.query("SELECT pg_terminate_backend($1)", [
          reply.rows[0].pid,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 42;
      })
    ).rejects.toBeDefined();
    // The discarded client did not poison the pool.
    expect(
      await pgQuery.default.withTransaction(async (client) => {
        const reply = await client.query("SELECT 42 AS n");
        return reply.rows[0].n;
      })
    ).toBe(42);
  }, 30000);

  it("refuses an env outside the dev/test namespace and refuses when disabled", async () => {
    await expect(
      queue.enqueueNoopJob({
        env: "prod",
        zid,
        productKey: "product",
        actorScope: "synthetic-actor",
        requestKey: "rejected",
      })
    ).rejects.toThrow(/env must be/);
  }, 30000);
});

// ---------------------------------------------- 30, 38 plans at 20,000 rows

describeProvisioned(
  SKIP_PROVISIONING
    ? `P-024 queue substrate plans at scale (${PROVISIONING_SKIP_REASON})`
    : "P-024 queue substrate plans at scale",
  () => {
    it("30. uses the ready index with 20,000 terminal and other-lane rows", async () => {
      requireProvisioning();
      const a = await enqueue(scratchPool, "r3-plan");
      await scratchPool.query(
        "INSERT INTO public.polis_queue_jobs(env,job_id,run_id,stage,stage_instance,state,priority,max_attempts) " +
          "SELECT 'r3-plan',gen_random_uuid(),$1,'noop',g::text," +
          "CASE WHEN g<=10000 THEN 'succeeded' ELSE 'queued' END,2,3 FROM generate_series(1,20000) g",
        [a.run_id]
      );
      await scratchPool.query("ANALYZE public.polis_queue_jobs");
      const plan = await sql(
        scratchPool,
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT q.env,q.job_id FROM public.polis_queue_jobs q " +
          "WHERE q.env='r3-plan' AND q.priority=1 AND q.state IN ('queued','retry_wait') " +
          "AND q.eligible_at<=statement_timestamp() AND q.attempt_count-q.parked_attempt_count<q.max_attempts " +
          "ORDER BY q.eligible_at,q.created_at,q.job_id FOR UPDATE SKIP LOCKED LIMIT 1"
      );
      expect(
        nodes(plan[0].Plan).some(
          (n) =>
            n["Node Type"] === "Index Scan" &&
            n["Index Name"] === "polis_queue_ready"
        )
      ).toBe(true);
      expect((await claim(scratchPool, "r3-plan")).job_id).toBe(a.job_id);
    }, 180000);

    it("38. uses a zid index for both parent lookups at 20,000 rows and restricts parent deletion", async () => {
      requireProvisioning();
      await scratchPool.query(
        "INSERT INTO public.conversations(zid,topic) SELECT g,'synthetic' FROM generate_series(3,20002) g"
      );
      await scratchPool.query(
        "INSERT INTO public.polis_queue_heads(env,product_key,zid) " +
          "SELECT 'r4-fk',g::text,g FROM generate_series(3,20002) g"
      );
      await scratchPool.query(
        "INSERT INTO public.polis_queue_runs(env,run_id,zid,product_key,requested_generation," +
          "input_uri,input_sha256,expected_output_uri,expected_output_sha256,config_sha256," +
          "code_image_digest,contract_version) " +
          "SELECT 'r4-fk',gen_random_uuid(),g,g::text,1,'synthetic',$1,'synthetic',$1,$1," +
          "'synthetic','polis-queue/1' FROM generate_series(3,20002) g",
        [H]
      );
      for (const table of ["heads", "runs"]) {
        await scratchPool.query(`ANALYZE public.polis_queue_${table}`);
        const plan = await sql(
          scratchPool,
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM ONLY public.polis_queue_${table} x ` +
            "WHERE x.zid=20002 FOR KEY SHARE OF x"
        );
        // Index-backed either way; at few distinct zids the planner may pick a
        // bitmap, so the assertion is on the index used, not the node type.
        expect(
          nodes(plan[0].Plan).some(
            (n) => n["Index Name"] === `polis_queue_${table}_zid`
          )
        ).toBe(true);
      }
      await expectSqlState(
        scratchPool.query("DELETE FROM public.conversations WHERE zid=20002"),
        "23503"
      );
      await scratchPool.query(
        "INSERT INTO public.conversations(zid,topic) VALUES (20003,'synthetic')"
      );
      const deleted = await scratchPool.query(
        "DELETE FROM public.conversations WHERE zid=20003"
      );
      expect(deleted.rowCount).toBe(1);
    }, 180000);
  }
);
