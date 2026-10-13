/** Reports and data exports run on a small dedicated connection pool, so a flood
 * of slow exports can never take the connections votes, comments and the
 * next-statement call need. This guard saturates the export pool with slow
 * queries, then shows that while it is full:
 *   - a vote, a comment and nextComment all stay prompt (they run on the
 *     read-write and read pools, never the export pool), and
 *   - a further export is rejected within the acquire timeout — it degrades
 *     itself rather than waiting on, or spilling into, a participation
 *     connection.
 *
 * It is the votes/comments/nextComment counterpart of the result-pool guard in
 * ../delphi-results-pg/concurrency.pgtest.ts. Like that one it is load-bearing:
 * a failure is investigated as possible participation-path starvation first, and
 * it is never skipped or loosened to get a build green.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh. */

// db/pg-query.ts reads these when it first builds the export pool. They are set
// here, before any module under test is required (below, in beforeAll), so the
// pool is small and the acquire timeout short and deterministic for the test.
process.env.REPORT_EXPORT_POOL_MAX = process.env.REPORT_EXPORT_POOL_MAX || "2";
process.env.REPORT_EXPORT_ACQUIRE_TIMEOUT_MS =
  process.env.REPORT_EXPORT_ACQUIRE_TIMEOUT_MS || "1500";
// Comfortably longer than the saturating pg_sleep below, so a held connection
// is not released by its own statement_timeout before the test samples.
process.env.REPORT_EXPORT_STATEMENT_TIMEOUT_MS =
  process.env.REPORT_EXPORT_STATEMENT_TIMEOUT_MS || "60000";

import { Client } from "pg";
import { semanticToWire } from "../../src/votes/convention";

const ZID = 8701;
const ACQUIRE_TIMEOUT_MS = parseInt(
  process.env.REPORT_EXPORT_ACQUIRE_TIMEOUT_MS as string,
  10
);
// Votes, comments and nextComment must answer within this while exports hold
// every export-pool connection. Generous so a loaded CI runner is not flaky;
// the real guard is that they do not error and do not wait on the export pool.
const PARTICIPATION_BUDGET_MS = 5000;
// The rejected export must settle close to the acquire timeout, not hang.
const OVERFLOW_CAP_MS = ACQUIRE_TIMEOUT_MS + 4000;
const SATURATING_SLEEP_S = 20;

type Outcome = { ms: number; value?: any; error?: any };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function timed(work: Promise<any>): Promise<Outcome> {
  const started = Date.now();
  return work.then(
    (value) => ({ ms: Date.now() - started, value }),
    (error) => ({ ms: Date.now() - started, error })
  );
}

let admin: Client;
// The server's db layer and the real participation functions, required after
// the env above is set so they share one pg-query instance with the small pool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pg: any;
let EXPORT_POOL_MAX: number;
let getNextComment: (
  zid?: number,
  pid?: number,
  withoutTids?: Array<number | string>,
  lang?: string
) => Promise<any>;
let votesPost: (
  uid?: number,
  pid?: number,
  zid?: number,
  tid?: number,
  voteType?: number,
  weight?: number,
  high_priority?: boolean
) => Promise<any>;

let voterUid: number;
let voterPid: number;
let authorPid: number;
let ownerUid: number;
let tids: number[] = [];

/** Backends inside a pg_sleep right now — i.e. export-pool connections the
 * saturating queries are holding. Excludes this admin connection. */
async function sleepingBackends(): Promise<number> {
  return (
    await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'active'
       AND query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()`
    )
  ).rows[0].n;
}

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();

  // Required now, after the env above is set, so config + pg-query read it.
  const db = require("../../src/db/pg-query");
  pg = db.default;
  EXPORT_POOL_MAX = db.REPORT_EXPORT_POOL_MAX;
  getNextComment = require("../../src/nextComment").getNextComment;
  votesPost = require("../../src/routes/votes").votesPost;

  // Seed: one active conversation, an author and a voter participant, a few
  // comments. pid/tid are assigned by the pid_auto / tid_auto triggers.
  ownerUid = (
    await admin.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid"
    )
  ).rows[0].uid;
  await admin.query(
    "INSERT INTO conversations (zid, owner, topic, is_active) VALUES ($1, $2, 'generated', true) ON CONFLICT (zid) DO NOTHING",
    [ZID, ownerUid]
  );
  authorPid = (
    await admin.query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
      [ZID, ownerUid]
    )
  ).rows[0].pid;
  voterUid = (
    await admin.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid"
    )
  ).rows[0].uid;
  voterPid = (
    await admin.query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
      [ZID, voterUid]
    )
  ).rows[0].pid;
  for (let i = 0; i < 5; i++) {
    const tid = (
      await admin.query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) RETURNING tid",
        [ZID, authorPid, ownerUid, `generated comment ${i}`]
      )
    ).rows[0].tid;
    tids.push(tid);
  }
}, 60000);

afterAll(async () => {
  await admin?.end();
});

test("votes, comments and nextComment stay prompt while slow exports saturate the export pool", async () => {
  // Hold every export-pool connection with a slow query. These are the real
  // export read function; each parks in pg_sleep and keeps its connection.
  const saturating = Array.from({ length: EXPORT_POOL_MAX }, () =>
    (
      pg.queryP_reportExport("SELECT pg_sleep($1)", [
        SATURATING_SLEEP_S,
      ]) as Promise<unknown>
    ).catch(() => {})
  );

  // Wait until every export-pool connection is held.
  const deadline = Date.now() + 10000;
  while ((await sleepingBackends()) < EXPORT_POOL_MAX) {
    if (Date.now() > deadline) throw new Error("export pool never saturated");
    await sleep(25);
  }
  const held = await sleepingBackends();

  // With the pool full, run the three participation operations and one further
  // export, all at once.
  const vote = timed(
    votesPost(
      voterUid,
      voterPid,
      ZID,
      tids[0],
      semanticToWire("agree"), // the wire value an agree vote POSTs; converted to storage by the vote convention module inside votesPost
      0,
      false
    )
  );
  // The comment write uses pg.queryP on the read-write pool, exactly as the
  // POST /comments route's INSERT does (routes/comments.ts). Comments carry no
  // vote sign, so there is no conversion.
  const comment = timed(
    pg.queryP(
      "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) RETURNING tid",
      [ZID, authorPid, ownerUid, "generated comment while exports saturate"]
    )
  );
  const next = timed(getNextComment(ZID, voterPid, [], "en"));
  // A further export cannot get a connection; it must be rejected near the
  // acquire timeout, never served and never taking a participation connection.
  const overflow = timed(
    pg.queryP_reportExport("SELECT pg_sleep($1)", [SATURATING_SLEEP_S])
  );

  const [voteOut, commentOut, nextOut, overflowOut] = await Promise.all([
    vote,
    comment,
    next,
    overflow,
  ]);

  // Release the saturating queries so nothing lingers.
  await admin.query(
    `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active'
     AND query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()`
  );
  await Promise.all(saturating);

  process.stdout.write(
    `${JSON.stringify({
      export_pool_max: EXPORT_POOL_MAX,
      export_connections_held: held,
      acquire_timeout_ms: ACQUIRE_TIMEOUT_MS,
      vote_ms: voteOut.ms,
      comment_ms: commentOut.ms,
      nextcomment_ms: nextOut.ms,
      overflow_export_ms: overflowOut.ms,
      overflow_export_rejected: !!overflowOut.error,
    })}\n`
  );

  // The pool was genuinely full.
  expect(held).toBe(EXPORT_POOL_MAX);

  // Participation stayed prompt: none errored, none waited on the export pool.
  expect(voteOut.error).toBeUndefined();
  expect(voteOut.ms).toBeLessThan(PARTICIPATION_BUDGET_MS);
  expect(commentOut.error).toBeUndefined();
  expect(commentOut.ms).toBeLessThan(PARTICIPATION_BUDGET_MS);
  expect(nextOut.error).toBeUndefined();
  expect(nextOut.ms).toBeLessThan(PARTICIPATION_BUDGET_MS);

  // The vote was really written, through the vote convention module.
  const stored = (
    await admin.query(
      "SELECT vote FROM votes WHERE zid = $1 AND pid = $2 AND tid = $3",
      [ZID, voterPid, tids[0]]
    )
  ).rows;
  expect(stored.length).toBe(1);

  // The overflow export degraded itself: rejected, and near the acquire timeout.
  expect(overflowOut.error).toBeDefined();
  expect(overflowOut.ms).toBeGreaterThanOrEqual(ACQUIRE_TIMEOUT_MS - 250);
  expect(overflowOut.ms).toBeLessThan(OVERFLOW_CAP_MS);
}, 120000);

/** A streamed export reads the whole conversation through a cursor. If the HTTP
 * client disconnects mid-stream, the export must stop fetching and release its
 * connection right away, so a stalled or aborted download cannot hold one of the
 * few export-pool connections until the whole conversation has been read. This
 * fills the pool to its last free connection, takes it with a long streaming
 * export, disconnects the client mid-stream, and shows a further export is then
 * served — proof the stream freed its connection. */
test("a client disconnect mid-stream frees the export-pool connection", async () => {
  // Hold every export-pool connection but one with slow queries, so the stream
  // below takes the last one and the pool is full while it is mid-cursor.
  const holders = EXPORT_POOL_MAX - 1;
  const saturating = Array.from({ length: holders }, () =>
    (
      pg.queryP_reportExport("SELECT pg_sleep($1)", [
        SATURATING_SLEEP_S,
      ]) as Promise<unknown>
    ).catch(() => {})
  );
  const deadline = Date.now() + 10000;
  while ((await sleepingBackends()) < holders) {
    if (Date.now() > deadline) throw new Error("export pool never saturated");
    await sleep(25);
  }

  // A fake HTTP response that lets the test fire the "close" (client-disconnect)
  // event on demand, the same event Express emits when the socket goes away.
  const closeListeners: Array<() => void> = [];
  const res = {
    on: (event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
    },
    removeListener: (event: string, listener: () => void) => {
      if (event === "close") {
        const i = closeListeners.indexOf(listener);
        if (i >= 0) closeListeners.splice(i, 1);
      }
    },
  };
  const disconnect = () => closeListeners.slice().forEach((cb) => cb());

  // A long streaming export: many rows so the cursor stays open (the connection
  // stays held) well past the acquire timeout if it were never released.
  let streamEnded = false;
  let streamError: any;
  const firstRow = new Promise<void>((resolve, reject) => {
    let resolved = false;
    pg.stream_queryP_reportExport(
      "SELECT n FROM generate_series(1, 5000000) AS n",
      [],
      () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      },
      () => {
        streamEnded = true;
      },
      (error: any) => {
        streamError = error;
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      },
      res
    );
  });
  // Cursor open, last connection held -> pool is now full.
  await firstRow;

  // The client disconnects. The stream must close its cursor and release its
  // connection; a further export then acquires it instead of being rejected.
  disconnect();
  const probe = await timed(pg.queryP_reportExport("SELECT 42 AS ok"));

  // Release the saturating queries so nothing lingers.
  await admin.query(
    `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active'
     AND pid <> pg_backend_pid()`
  );
  await Promise.all(saturating);

  process.stdout.write(
    `${JSON.stringify({
      disconnect_test: true,
      export_pool_max: EXPORT_POOL_MAX,
      holders,
      stream_ended_normally: streamEnded,
      probe_ms: probe.ms,
      probe_served: !probe.error && probe.value?.[0]?.ok === 42,
    })}\n`
  );

  // The stream did not finish on its own; it was aborted by the disconnect.
  expect(streamEnded).toBe(false);
  expect(streamError).toBeUndefined();
  // The further export was served (connection was freed), not rejected at the
  // acquire timeout.
  expect(probe.error).toBeUndefined();
  expect(probe.value?.[0]?.ok).toBe(42);
  expect(probe.ms).toBeLessThan(ACQUIRE_TIMEOUT_MS);
}, 120000);
