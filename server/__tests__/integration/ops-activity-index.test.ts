/**
 * Ops pages U1 ("Activity now"), U2 ("Activity over time"), U4 (topics), U5
 * (consensus) and S1 (database) against the migrated test database.
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
 *
 * 5. U2: the day and hour series are bounded by an index on their window
 *    column exactly as U1 is, and the index the planner chose is logged; the
 *    all-time monthly series reads only conversations (a sequential scan of
 *    that small table is the one allowed) and never votes or participants.
 *    U4/U5: no statement scans votes, comments or math_main sequentially.
 *    Every page statement also runs for real through the guards.
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
import {
  DAILY_90,
  HOURLY_48,
  readMonthly,
  readSeries,
  U2_MONTHLY,
  U2_STATEMENTS,
} from "../../src/ops/history";
import {
  DETAIL_SQL,
  readActive,
  WINDOW_VOTERS_SQL,
} from "../../src/ops/topics";
import {
  MathMemo,
  MATH_LABEL,
  MATH_SQL,
  readConsensus,
  TICKS_SQL,
  TOPIC_SQL,
  VISIBLE_TEXT_SQL,
} from "../../src/ops/consensus";
import {
  RateTracker,
  readConnections,
  readDatabase,
  readTables,
} from "../../src/ops/database";
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

// EXPLAIN one statement with sequential scans disabled; returns its plan nodes.
async function explain(sql: string, values: unknown[]): Promise<PlanNode[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL enable_seqscan = off");
    const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
    return nodes(rows[0]["QUERY PLAN"][0].Plan);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const YEAR_AHEAD = Date.now() + 365 * 24 * 60 * 60 * 1000;

describe("U2 day and hour series read through an index on the window column", () => {
  test.each(
    U2_STATEMENTS.flatMap((s) =>
      [
        ["day", 86400000],
        ["hour", 3600000],
      ].map(([bucket, ms]) => [`${s.name} (${bucket})`, s, ms] as const)
    )
  )("%s", async (_name, statement, bucketMs) => {
    // A window later than every row, for the reason given in the U1 test.
    const plan = await explain(statement.sql, [YEAR_AHEAD, bucketMs]);
    const seqScans = plan.filter(
      (n) =>
        n["Node Type"] === "Seq Scan" && n["Relation Name"] === statement.table
    );
    const bounded = plan.filter((n) =>
      [n["Index Cond"], n["Recheck Cond"]].some(
        (cond) =>
          typeof cond === "string" && cond.includes(`(${statement.column} >=`)
      )
    );
    expect({ statement: statement.name, seqScans }).toEqual({
      statement: statement.name,
      seqScans: [],
    });
    expect({
      statement: statement.name,
      boundedByIndex: bounded.length > 0,
    }).toEqual({
      statement: statement.name,
      boundedByIndex: true,
    });
    const used = [
      ...new Set(bounded.map((n) => n["Index Name"]).filter(Boolean)),
    ];
    // The index each U2 statement is answered from, logged on every run.
    // eslint-disable-next-line no-console
    console.info(
      `ops index test: U2 ${statement.name} (${bucketMs} ms buckets) uses ${
        used.join(", ") || "a bitmap on " + statement.index
      }; declared ${statement.index}`
    );
  });

  test("the all-time monthly series reads only conversations", async () => {
    const plan = await explain(U2_MONTHLY.sql, []);
    const relations = [
      ...new Set(plan.map((n) => n["Relation Name"]).filter(Boolean)),
    ];
    expect(relations).toEqual([U2_MONTHLY.seqScanAllowed]);
    // eslint-disable-next-line no-console
    console.info(
      `ops index test: U2 ${U2_MONTHLY.name} reads ${relations.join(
        ", "
      )} (${plan
        .filter((n) => n["Relation Name"])
        .map((n) => n["Node Type"])
        .join(", ")}); a sequential scan of this table is the one allowed`
    );
  });
});

describe("U4 and U5 never scan votes, comments or math_main sequentially", () => {
  const LARGE = [
    "votes",
    "votes_latest_unique",
    "comments",
    "math_main",
    "participants",
    "participants_extended",
  ];
  test.each([
    [
      "U4 voters per conversation in the window",
      WINDOW_VOTERS_SQL,
      [YEAR_AHEAD],
    ],
    ["U4 topic and totals for named zids", DETAIL_SQL, [[1, 2]]],
    ["U5 math ticks", TICKS_SQL, [[1, 2], MATH_LABEL]],
    ["U5 math blob fields", MATH_SQL, [[1, 2], MATH_LABEL]],
    ["U5 topics", TOPIC_SQL, [[1, 2]]],
    [
      "U5 visible statement text",
      VISIBLE_TEXT_SQL,
      [
        [1, 1],
        [0, 1],
      ],
    ],
  ] as const)("%s", async (name, sql, values) => {
    const plan = await explain(sql, values as unknown as unknown[]);
    const seqScans = plan
      .filter(
        (n) =>
          n["Node Type"] === "Seq Scan" &&
          LARGE.includes(String(n["Relation Name"]))
      )
      .map((n) => n["Relation Name"]);
    expect({ name, seqScans }).toEqual({ name, seqScans: [] });
  });
});

describe("the new pages through the guards, for real", () => {
  test("U2 series and monthly", async () => {
    const now = Date.now();
    const hourly = await guardedRead((q) => readSeries(q, HOURLY_48, now));
    const daily = await guardedRead((q) => readSeries(q, DAILY_90, now));
    expect(hourly).toHaveLength(48);
    expect(daily).toHaveLength(90);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM votes WHERE created >= $1",
      [(Math.floor(now / 86400000) - 89) * 86400000]
    );
    expect(daily.reduce((n, r) => n + (r.votes as number), 0)).toBe(rows[0].n);
    const monthly = await guardedRead((q) => readMonthly(q, now));
    const total = await pool.query(
      "SELECT count(*)::int AS n FROM conversations"
    );
    expect(monthly.reduce((n, r) => n + (r.conversations as number), 0)).toBe(
      total.rows[0].n
    );
  });

  test("U4 and U5 statements run (threshold 1 so test data is named)", async () => {
    const now = Date.now();
    const split = await guardedRead((q) => readActive(q, now, 1));
    expect(split.below.conversations).toBe(0);
    const r = await guardedRead((q) =>
      readConsensus(q, now, 1, new MathMemo())
    );
    expect(r.named).toBe(split.named.length);
    // Text for invented (zid, tid) pairs runs and returns nothing.
    const none = await guardedRead((q) => q(VISIBLE_TEXT_SQL, [[-1], [-1]]));
    expect(none).toEqual([]);
  });

  test("S1 statistics views", async () => {
    const tracker = new RateTracker();
    const conns = await guardedRead((q) => readConnections(q));
    expect(Array.isArray(conns)).toBe(true);
    for (const c of conns) expect(Object.keys(c)).not.toContain("query");
    const tables = await guardedRead((q) => readTables(q, Date.now(), tracker));
    expect(tables.map((t) => t.table)).toContain("votes");
    const [db] = await guardedRead((q) => readDatabase(q, Date.now(), tracker));
    expect(db.size_bytes as number).toBeGreaterThan(0);
  });
});

// A generated conversation: 25 voters, a strictly moderated conversation with
// one accepted statement (tid 0), one unmoderated (tid 1, hidden under strict
// moderation), one moderated out (tid 2), and a math_main row under the served
// label whose repness and group votes point at all three. Removed afterwards.
describe("U4 and U5 on a generated conversation", () => {
  const fixture: { zid?: number; uids: number[] } = { uids: [] };

  beforeAll(async () => {
    const users = await pool.query(
      "INSERT INTO users (hname) SELECT 'ops generated fixture' FROM generate_series(1, 25) RETURNING uid"
    );
    fixture.uids = users.rows.map((r) => r.uid);
    const conv = await pool.query(
      "INSERT INTO conversations (owner, topic, strict_moderation, is_active) VALUES ($1, 'Generated fixture: parks', true, true) RETURNING zid",
      [fixture.uids[0]]
    );
    const zid = conv.rows[0].zid;
    fixture.zid = zid;
    const pids: number[] = [];
    for (const uid of fixture.uids) {
      const p = await pool.query(
        "INSERT INTO participants (zid, uid) VALUES ($1, $2) RETURNING pid",
        [zid, uid]
      );
      pids.push(p.rows[0].pid);
    }
    for (const [mod, txt] of [
      [1, "Accepted generated statement"],
      [0, "Unmoderated generated statement"],
      [-1, "Rejected generated statement"],
    ] as const) {
      await pool.query(
        "INSERT INTO comments (zid, pid, uid, txt, mod) VALUES ($1, $2, $3, $4, $5)",
        [zid, pids[0], fixture.uids[0], txt, mod]
      );
    }
    for (const pid of pids) {
      await pool.query(
        "INSERT INTO votes (zid, pid, tid, vote) VALUES ($1, $2, 0, -1)",
        [zid, pid]
      );
    }
    const votes = {
      "0": { A: 9, D: 1, S: 10 },
      "1": { A: 10, D: 0, S: 10 },
      "2": { A: 10, D: 0, S: 10 },
    };
    const data = {
      "group-votes": {
        "0": { "n-members": 15, votes },
        "1": { "n-members": 10, votes },
      },
      "group-aware-consensus": { "0": 0.6, "1": 0.8, "2": 0.8 },
      repness: {
        "0": [
          {
            tid: 1,
            "repful-for": "agree",
            "p-success": 0.9,
            "n-success": 10,
            "n-trials": 10,
            repness: 3,
          },
          {
            tid: 0,
            "repful-for": "agree",
            "p-success": 0.8,
            "n-success": 9,
            "n-trials": 10,
            repness: 2,
          },
        ],
        "1": [
          {
            tid: 2,
            "repful-for": "agree",
            "p-success": 0.9,
            "n-success": 10,
            "n-trials": 10,
            repness: 3,
          },
        ],
      },
    };
    await pool.query(
      "INSERT INTO math_main (zid, math_env, data, last_vote_timestamp, math_tick) VALUES ($1, $2, $3, $4, 7)",
      [zid, MATH_LABEL, JSON.stringify(data), Date.now()]
    );
  });

  afterAll(async () => {
    const zid = fixture.zid;
    if (zid !== undefined) {
      await pool.query("DELETE FROM math_main WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM votes_latest_unique WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM votes WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM participants WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM conversations WHERE zid = $1", [zid]);
    }
    if (fixture.uids.length) {
      await pool.query("DELETE FROM users WHERE uid = ANY($1::int[])", [
        fixture.uids,
      ]);
    }
  });

  test("named at the threshold of 20, not named at 26", async () => {
    const now = Date.now();
    const at20 = await guardedRead((q) => readActive(q, now, 20));
    expect(at20.named.find((c) => c.zid === fixture.zid)).toMatchObject({
      voters: 25,
      votes: 25,
    });
    const at26 = await guardedRead((q) => readActive(q, now, 26));
    expect(at26.named.find((c) => c.zid === fixture.zid)).toBeUndefined();
  });

  test("only statements participants can see are shown", async () => {
    const r = await guardedRead((q) =>
      readConsensus(q, Date.now(), 20, new MathMemo())
    );
    const mine = r.rows.filter((row) =>
      String(row.conversation).startsWith("Generated fixture: parks")
    );
    expect(mine.map((row) => [row.finding, row.statement])).toEqual([
      ["Common ground 1", "Accepted generated statement"],
      ["Group A · 15 people", "Accepted generated statement"],
      ["Group B · 10 people", null],
    ]);
    expect(JSON.stringify(r.rows)).not.toMatch(/Unmoderated|Rejected/);
  });
});
