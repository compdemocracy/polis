/**
 * Ops page U1 ("Activity now") against the migrated test database.
 *
 * 1. Index pinning. Each U1 statement declares the index its predicate must be
 *    able to use (src/ops/activityNow.ts, U1_STATEMENTS). With sequential
 *    scans disabled, the plan must use that index and must not scan the table.
 *    On an empty test database the planner would pick a sequential scan
 *    whatever indexes exist, so this proves that an index path EXISTS for the
 *    predicate, which is the property that keeps these reads off a full scan
 *    of votes or comments in production. A statement whose predicate stops
 *    being index-answerable, or a migration that drops or renames the index,
 *    fails here with the statement named.
 *
 * 2. The comments invariant the statements query relies on: modified >= created
 *    on every row, because both columns default to now_as_millis() and nothing
 *    writes either one explicitly on insert.
 *
 * 3. The guards for real: the reads run inside READ ONLY, a write is refused,
 *    and a statement past 3 s is cancelled and reported as "timeout".
 *
 * 4. Off by default: the real app, loaded with OPS_ENABLED unset as in the
 *    test environment, answers 404 on every /api/v3/ops path.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  readStatements,
  readVotes,
  U1_STATEMENTS,
  windowBounds,
} from "../../src/ops/activityNow";
import { guardedRead, OpsReadError } from "../../src/ops/guardedRead";
import { newAgent } from "../setup/api-test-helpers";

dotenv.config({ override: false });

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans || []).flatMap(nodes)];
}

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
});

afterAll(async () => {
  await pool.end();
});

describe("U1 statements can be answered from their declared index", () => {
  test.each(U1_STATEMENTS.map((s) => [s.name, s] as const))(
    "%s",
    async (_name, statement) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL enable_seqscan = off");
        const { rows } = await client.query(
          `EXPLAIN (FORMAT JSON) ${statement.sql}`,
          windowBounds(Date.now())
        );
        const plan = nodes(rows[0]["QUERY PLAN"][0].Plan);
        const indexes = plan.map((n) => n["Index Name"]).filter(Boolean);
        const seqScans = plan.filter(
          (n) =>
            n["Node Type"] === "Seq Scan" &&
            n["Relation Name"] === statement.table
        );
        expect({ statement: statement.name, indexes }).toEqual({
          statement: statement.name,
          indexes: expect.arrayContaining([statement.index]),
        });
        expect({ statement: statement.name, seqScans }).toEqual({
          statement: statement.name,
          seqScans: [],
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  );
});

describe("comments: modified >= created", () => {
  test("both columns default to now_as_millis()", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'comments'
          AND column_name IN ('created', 'modified') ORDER BY column_name`
    );
    expect(rows).toEqual([
      { column_name: "created", column_default: "now_as_millis()" },
      { column_name: "modified", column_default: "now_as_millis()" },
    ]);
  });

  test("no row in the test database has modified < created", async () => {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM comments WHERE modified < created"
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("U1 through the guards", () => {
  test("votes and statements read for real, one row per window", async () => {
    const now = Date.now();
    const votes = await guardedRead((q) => readVotes(q, now));
    const statements = await guardedRead((q) => readStatements(q, now));
    expect(votes.map((r) => r.window)).toEqual([
      "Last 5 minutes",
      "Last hour",
      "Last 24 hours",
    ]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM votes WHERE created >= $1",
      [windowBounds(now)[0]]
    );
    expect(votes[2].votes).toBe(rows[0].n);
    // Shorter windows never exceed longer ones.
    for (const key of ["votes", "voters", "conversations"]) {
      expect(votes[0][key]).toBeLessThanOrEqual(votes[1][key] as number);
      expect(votes[1][key]).toBeLessThanOrEqual(votes[2][key] as number);
    }
    expect(statements).toHaveLength(3);
  });

  test("the transaction is read-only", async () => {
    const err = await guardedRead((q) =>
      q("UPDATE conversations SET topic = topic WHERE false", [])
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OpsReadError);
    expect(err.reason).toBe("db_error");
  });

  test("a statement past the 3 s timeout is cancelled and reported as timeout", async () => {
    const started = Date.now();
    const err = await guardedRead((q) => q("SELECT pg_sleep(10)", [])).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(OpsReadError);
    expect(err.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15000);
});

describe("OPS_ENABLED unset (the default)", () => {
  test.each([
    "/api/v3/ops/whoami",
    "/api/v3/ops/page/activity",
    "/api/v3/ops/elsewhere",
  ])("GET %s is 404", async (path) => {
    expect(process.env.OPS_ENABLED || "").not.toBe("true");
    const agent = await newAgent();
    const res = await agent.get(path).set("Authorization", "Bearer x");
    expect(res.status).toBe(404);
  });
});
