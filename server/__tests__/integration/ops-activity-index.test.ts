/**
 * Ops page U1 ("Activity now") against the migrated test database.
 *
 * 1. No sequential scan. With sequential scans disabled, each U1 statement
 *    must read its table through an index whose condition is the window
 *    predicate (created >= $1 on votes, modified >= $1 on comments), and never
 *    by a Seq Scan. On small test data the planner would pick a sequential
 *    scan whatever indexes exist, so this proves an index path EXISTS for the
 *    predicate, which is what keeps these reads off a full scan of votes or
 *    comments in production. Which index is used is reported, not asserted:
 *    the declared one (U1_STATEMENTS) is expected, but the planner may choose
 *    another index on the same column. A statement whose predicate stops being
 *    index-answerable, or a migration that drops the last index on the
 *    column, fails here with the statement named.
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
  "Index Cond"?: string;
  "Recheck Cond"?: string;
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

// The column each U1 statement's window predicate is on.
const PREDICATE_COLUMN: Record<string, string> = {
  votes: "created",
  comments: "modified",
};

describe("U1 statements read their table through an index on the window predicate", () => {
  test.each(U1_STATEMENTS.map((s) => [s.name, s] as const))(
    "%s",
    async (_name, statement) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL enable_seqscan = off");
        // Plan for a window later than every row in the table. In production
        // the 24 h window is a sliver of the table (about 5.5k of 19M votes);
        // in the test database every row is recent, and a window that covers
        // the whole table lets the planner legitimately prefer any index
        // (CI chose votes_latest_unique_zid_tid_idx, which is on votes(zid,
        // tid), as a full index scan). A bound past the newest row reproduces
        // the production shape on any test data.
        const { rows } = await client.query(
          `EXPLAIN (FORMAT JSON) ${statement.sql}`,
          windowBounds(Date.now() + 365 * 24 * 60 * 60 * 1000)
        );
        const plan = nodes(rows[0]["QUERY PLAN"][0].Plan);
        const column = PREDICATE_COLUMN[statement.table];
        const onTable = plan.filter(
          (n) => n["Relation Name"] === statement.table
        );
        const seqScans = onTable.filter((n) => n["Node Type"] === "Seq Scan");
        // An index node whose condition is the window predicate. A full scan
        // of some other index with the window as a Filter reads the whole
        // table and does not count.
        const bounded = plan.filter((n) =>
          [n["Index Cond"], n["Recheck Cond"]].some(
            (cond) => typeof cond === "string" && cond.includes(`(${column} >=`)
          )
        );
        expect({ statement: statement.name, seqScans }).toEqual({
          statement: statement.name,
          seqScans: [],
        });
        expect({
          statement: statement.name,
          boundedByIndex: bounded.length > 0,
        }).toEqual({ statement: statement.name, boundedByIndex: true });
        // Informational: which index the planner used. The expected one is
        // declared in U1_STATEMENTS; another index on the same column is fine.
        const used = plan.map((n) => n["Index Name"]).filter(Boolean);
        if (!used.includes(statement.index)) {
          // eslint-disable-next-line no-console
          console.info(
            `ops index test: ${statement.name} used ${used.join(
              ", "
            )}, declared ${statement.index}`
          );
        }
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
