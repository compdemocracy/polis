/**
 * The Delphi job table: migration 000023, contract polis-queue/2, and the
 * large worker class on top of it: migration 000024, contract polis-queue/3.
 * Migration 000027 adds graph stages under the install contract polis-queue/5;
 * M29 adds graph_topics; existing RPC wire versions and worker classes remain unchanged.
 *
 * The migrations reach the test database the way every migration does: the
 * postgres image applies server/postgres/migrations/*.sql once at initdb. So
 * this file reads the live catalog and applies nothing. It pins what the
 * deploy creates (the tables, who owns them, that they are empty, which
 * stages and classes a job may have, which RPCs the executor may call) and
 * that, with the flag off, the server's queue helper refuses before it opens
 * a transaction.
 *
 * The migrations' forward/backward proofs against the real chain are
 * server/postgres/migrations/down/test_000023_down.sh and test_000024_down.sh.
 */
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config({ override: false });

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/polis-dev";

/** Every table 000023 creates, owned by polis_queue_owner like 000019's. 000024 creates no job table. */
const JOB_TABLES = [
  "delphi_jobs",
  "delphi_job_aliases",
  "delphi_job_inputs",
  "delphi_current",
  "delphi_job_guards",
  "delphi_provider_requests",
  "polis_queue_logs",
];

/**
 * The /2 and /3 RPCs the executor login may call, by exact signature (several
 * names also have a /1 overload that stays ungranted), and nothing else may.
 */
const EXECUTOR_RPCS = [
  "pd_enqueue(text,integer,text,text,text,text,uuid,uuid,text,text,text,text,smallint,integer,text,text,text,jsonb)",
  "pd_release_scope(text,text)",
  "pd_job_view(text,uuid)",
  "pd_provider_intent(text,uuid,uuid,uuid,bigint,uuid,text,bytea)",
  "pd_provider_update(text,uuid,uuid,uuid,bigint,uuid,text,text)",
  "pq_attempt_logs(text,uuid,bigint,integer)",
  "pq_claim(text,smallint,uuid,uuid,integer,text)",
  "pq_end_attempt(text,uuid,uuid,uuid,bigint,text,text,boolean,timestamptz)",
  "pq_reap(text,uuid,integer,text)",
  // 000024: the class depth read the capacity line is made of.
  "pq_class_depth(text,text)",
];

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await pool.end();
});

async function one<T>(text: string, values?: unknown[]): Promise<T> {
  const result = await pool.query(text, values);
  return Object.values(result.rows[0] ?? {})[0] as T;
}

describe("the Delphi job table (000023) with large class (000024) and graph stages (000027)", () => {
  it("records contract polis-queue/5 in the queue's install row", async () => {
    expect(
      await one<string>(
        "SELECT contract_version FROM public.polis_queue_install",
      ),
    ).toBe("polis-queue/5");
  });

  it.each(JOB_TABLES)(
    "creates %s owned by polis_queue_owner, and the deploy leaves it empty",
    async (table) => {
      const name = `public.${table}`;
      expect(await one<string>("SELECT to_regclass($1)::text", [name])).toBe(
        table,
      );
      expect(
        await one<string>(
          "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass($1)",
          [name],
        ),
      ).toBe("polis_queue_owner");
      expect(await one<number>(`SELECT count(*)::int FROM ${name}`)).toBe(0);
    },
  );

  it.each(["delphi_foundation_install", "polis_queue_large_class_install"])(
    "records its install baseline once in %s",
    async (table) => {
      expect(
        await one<number>(`SELECT count(*)::int FROM public.${table}`),
      ).toBe(1);
    },
  );

  it("admits exactly noop, both daemon stages, rebuild and the three graph stages, and holds no job of any", async () => {
    expect(
      await one<string>(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint " +
          "WHERE conrelid = 'public.polis_queue_jobs'::regclass AND conname = 'polis_queue_jobs_stage_check'",
      ),
    ).toBe(
      "CHECK ((stage = ANY (ARRAY['noop'::text, 'delphi_full_pipeline'::text, 'delphi_narrative'::text, 'math_rebuild'::text, 'graph_embed'::text, 'graph_cluster'::text, 'graph_topics'::text, 'graph_narrative'::text])))",
    );
    expect(
      await one<number>(
        "SELECT count(*)::int FROM public.polis_queue_jobs WHERE stage <> 'noop' OR worker_class <> 'noop'",
      ),
    ).toBe(0);
  });

  it("admits exactly noop, delphi and large, with large required for rebuild and optional for graph clustering", async () => {
    expect(
      await one<string>(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint " +
          "WHERE conrelid = 'public.polis_queue_jobs'::regclass AND conname = 'polis_queue_jobs_worker_class_check'",
      ),
    ).toBe(
      "CHECK ((worker_class = ANY (ARRAY['noop'::text, 'delphi'::text, 'large'::text])))",
    );
    expect(
      await one<string>(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint " +
          "WHERE conrelid = 'public.polis_queue_jobs'::regclass AND conname = 'pq_stage_large'",
      ),
    ).toBe(
      "CHECK ((((stage = 'math_rebuild'::text) AND (worker_class = 'large'::text)) OR ((stage = 'graph_cluster'::text) AND (worker_class = ANY (ARRAY['delphi'::text, 'large'::text]))) OR ((stage <> ALL (ARRAY['math_rebuild'::text, 'graph_cluster'::text])) AND (worker_class <> 'large'::text))))",
    );
  });

  it.each(EXECUTOR_RPCS)(
    "grants %s to polis_queue_executor and not to PUBLIC",
    async (signature) => {
      expect(
        await one<boolean>(
          "SELECT has_function_privilege('polis_queue_executor', $1, 'EXECUTE')",
          [`public.${signature}`],
        ),
      ).toBe(true);
      expect(
        await one<boolean>(
          "SELECT EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure)) a WHERE a.grantee = 0)",
          [`public.${signature}`],
        ),
      ).toBe(false);
    },
  );

  it("grants no queue function or job table to PUBLIC", async () => {
    expect(
      await one<number>(
        "SELECT count(*)::int FROM pg_proc p, aclexplode(p.proacl) x " +
          "WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'pq\\_%' OR p.proname LIKE 'pd\\_%') AND x.grantee = 0",
      ),
    ).toBe(0);
    expect(
      await one<number>(
        "SELECT count(*)::int FROM pg_class c, aclexplode(c.relacl) x " +
          "WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND (c.relname LIKE 'delphi\\_%' OR c.relname LIKE 'polis\\_queue\\_%') AND x.grantee = 0",
      ),
    ).toBe(0);
  });

  it("reads an empty class depth for both classes and refuses any other class", async () => {
    for (const cls of ["delphi", "large"]) {
      const depth = await one<Record<string, unknown>>(
        "SELECT public.pq_class_depth('test-000024', $1)",
        [cls],
      );
      expect(depth).toMatchObject({
        schema_version: "polis-queue/3",
        outcome: "class_depth",
        worker_class: cls,
        queued: 0,
        leased: 0,
        parked: 0,
        dead: 0,
        oldest_unresolved_created_at: null,
      });
    }
    await expect(
      pool.query("SELECT public.pq_class_depth('test-000024', 'noop')"),
    ).rejects.toThrow(/invalid class depth read/);
  });
});

describe("with the flag off, nothing in the server reaches the job table", () => {
  it("the queue helper refuses before it opens a transaction", async () => {
    const saved = process.env.POLIS_QUEUE_SUBSTRATE_ENABLED;
    delete process.env.POLIS_QUEUE_SUBSTRATE_ENABLED;
    try {
      await jest.isolateModulesAsync(async () => {
        const { enqueueNoopJob } = await import("../../src/queue/enqueue");
        await expect(
          enqueueNoopJob({
            env: "test",
            zid: 1,
            productKey: "flag-off",
            actorScope: "flag-off",
            requestKey: "flag-off",
            priority: 1,
            maxAttempts: 1,
          }),
        ).rejects.toThrow(/queue substrate is disabled/);
      });
    } finally {
      if (saved !== undefined) {
        process.env.POLIS_QUEUE_SUBSTRATE_ENABLED = saved;
      }
    }
  });
});
