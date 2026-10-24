/** Participants joining one conversation at the same moment must each get a
 * participant on the first attempt, with their own participant number, and an
 * insert that fails or is skipped must leave nothing behind that makes the
 * next joiner wait.
 *
 * The pid_auto trigger numbers a conversation's participants MAX(pid) + 1,
 * from 0, under an advisory lock per conversation (server/postgres/migrations).
 * For as long as that lock ends before the inserting transaction commits, a
 * second join in the conversation can read the same MAX(pid), wait on the
 * conversations row the first holds, and fail with 23505 on (zid, pid) once
 * the first commits; the server then retries the join. An insert that fails
 * after the trigger, or a row ON CONFLICT DO NOTHING skips, keeps the lock on
 * its connection. With the lock held until the transaction ends, the second
 * join reads MAX(pid) only after the first has committed, and the lock ends
 * with every transaction.
 *
 * Each join is the server's insertParticipant transaction (src/participant.ts)
 * without its retry. Every connection here is its own session, as the
 * participation pools of several servers are. A connection whose join failed
 * is closed and replaced, as insertParticipant closes it.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh. */
import { Client } from "pg";

// pid_auto's advisory lock class; the conversation id is the second key.
const PID_LOCK = 873791983;
const BURST_ZID = { 40: 9621, 72: 9622 } as const;
const COMMIT_ORDER_ZID = 9623,
  FAILED_INSERT_ZID = 9624,
  SKIPPED_ROW_ZID = 9625;
const ROUNDS = 5;
// A join that the lock lets through must finish well within this.
const NEXT_JOIN_BUDGET_MS = 1000;
// Upper bound on any lock wait in this file, so a lock nobody releases fails a
// test instead of hanging it.
const LOCK_TIMEOUT = "20s";

type Outcome = {
  ms: number;
  pid?: number;
  error?: { code?: string; constraint?: string };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pg: Client;

async function session(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  return client;
}

/** Users with explicit uids: other suites in this database insert users with
 * explicit small uids without advancing the sequence, so a uid from the
 * sequence can collide with one of theirs. These are zid * 1000 + i. */
async function users(first: number, n: number): Promise<number[]> {
  const uids = Array.from({ length: n }, (_, i) => first + i);
  await pg.query("INSERT INTO users (uid) SELECT unnest($1::int[])", [uids]);
  return uids;
}

async function conversation(zid: number): Promise<void> {
  const [owner] = await users(zid * 1000, 1);
  await pg.query(
    "INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')",
    [zid, owner]
  );
}

/** The insert insertParticipant runs, alone; the caller owns the transaction. */
function insertParticipant(
  client: Client,
  zid: number,
  uid: number
): Promise<Outcome> {
  const started = Date.now();
  return client
    .query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *;",
      [zid, uid]
    )
    .then(
      (r) => ({ ms: Date.now() - started, pid: r.rows[0].pid }),
      (error) => ({
        ms: Date.now() - started,
        error: { code: error.code, constraint: error.constraint },
      })
    );
}

/** insertParticipant's transaction, without the retry. */
async function join(
  client: Client,
  zid: number,
  uid: number
): Promise<Outcome> {
  const started = Date.now();
  await client.query("BEGIN");
  await client.query(
    "INSERT INTO participants_extended (zid, uid) VALUES ($1, $2) ON CONFLICT (zid, uid) DO NOTHING;",
    [zid, uid]
  );
  const outcome = await insertParticipant(client, zid, uid);
  await client.query(outcome.error ? "ROLLBACK" : "COMMIT");
  return { ...outcome, ms: Date.now() - started };
}

/** Sessions holding the conversation's participant lock. */
async function lockHolders(zid: number): Promise<number> {
  return (
    await pg.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
    AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 2`,
      [PID_LOCK, zid]
    )
  ).rows[0].n;
}

async function untilWaiting(pid: number): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = (
      await pg.query(
        "SELECT wait_event FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [pid]
      )
    ).rows[0];
    if (row) return row.wait_event;
    if (Date.now() > deadline)
      throw new Error(`session ${pid} never waited on a lock`);
    await sleep(10);
  }
}

async function storedPids(zid: number): Promise<number[]> {
  return (
    await pg.query("SELECT pid FROM participants WHERE zid = $1 ORDER BY pid", [
      zid,
    ])
  ).rows.map((r) => r.pid);
}

async function participantCount(zid: number): Promise<number> {
  return (
    await pg.query(
      "SELECT participant_count FROM conversations WHERE zid = $1",
      [zid]
    )
  ).rows[0].participant_count;
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});
afterAll(async () => {
  await pg?.end();
});

test.each([40, 72] as const)(
  "%i participants joining one conversation at once, round after round: every one joins on the first attempt, with distinct contiguous numbers",
  async (n) => {
    const zid = BURST_ZID[n];
    await conversation(zid);
    const sessions = await Promise.all(
      Array.from({ length: n }, () => session())
    );
    const perRound: Array<{
      round: number;
      sent: number;
      joined: number;
      refused: number;
      refusals: string[];
    }> = [];
    let refusedTotal = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const uids = await users(zid * 1000 + 1 + round * n, n);
        const outcomes = await Promise.all(
          uids.map(async (uid, i) => {
            const outcome = await join(sessions[i], zid, uid);
            if (outcome.error) {
              // insertParticipant closes a connection whose join failed.
              await sessions[i].end().catch(() => undefined);
              sessions[i] = await session();
            }
            return outcome;
          })
        );
        const refusals = outcomes
          .filter((o) => o.error)
          .map((o) => `${o.error!.code} ${o.error!.constraint ?? ""}`.trim());
        refusedTotal += refusals.length;
        perRound.push({
          round,
          sent: n,
          joined: n - refusals.length,
          refused: refusals.length,
          refusals: [...new Set(refusals)],
        });
      }
    } finally {
      await Promise.all(sessions.map((s) => s.end().catch(() => undefined)));
    }
    const pids = await storedPids(zid);
    const count = await participantCount(zid);
    process.stdout.write(
      `${JSON.stringify({
        scenario: `${n} joins at once, ${ROUNDS} rounds`,
        per_round: perRound,
        sent: n * ROUNDS,
        joined: pids.length,
        refused: refusedTotal,
        numbers_contiguous_from_0: pids.every((pid, i) => pid === i),
        participant_count: count,
      })}\n`
    );

    expect(refusedTotal).toBe(0);
    expect(pids).toEqual(Array.from({ length: n * ROUNDS }, (_, i) => i));
    expect(count).toBe(n * ROUNDS);
    expect(await lockHolders(zid)).toBe(0);
  },
  120000
);

test("a join sent while another in its conversation is not yet committed gets the next number once that one commits", async () => {
  await conversation(COMMIT_ORDER_ZID);
  const [uidA, uidB] = await users(COMMIT_ORDER_ZID * 1000 + 1, 2);
  const a = await session();
  const b = await session();
  const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  try {
    // A has inserted (the trigger numbered it) and not committed: in
    // production its COMMIT is one round trip later.
    await a.query("BEGIN");
    const first = await insertParticipant(a, COMMIT_ORDER_ZID, uidA);
    expect(first.error).toBeUndefined();

    const second = join(b, COMMIT_ORDER_ZID, uidB);
    const waitedOn = await untilWaiting(bPid);
    await a.query("COMMIT");
    const outcome = await second;
    const holders = await lockHolders(COMMIT_ORDER_ZID);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "second join sent before the first commits",
        second_waited_on: waitedOn,
        first_pid: first.pid,
        second: outcome.error
          ? `error ${outcome.error.code} ${outcome.error.constraint}`
          : `pid ${outcome.pid}`,
        sessions_holding_lock_after: holders,
      })}\n`
    );

    // It waits for the participant number, not for a row it will fail behind.
    expect(waitedOn).toBe("advisory");
    expect(outcome.error).toBeUndefined();
    expect(outcome.pid).toBe(first.pid! + 1);
    expect(holders).toBe(0);
    expect(await storedPids(COMMIT_ORDER_ZID)).toEqual([0, 1]);
    expect(await participantCount(COMMIT_ORDER_ZID)).toBe(2);
  } finally {
    await a.end().catch(() => undefined);
    await b.end().catch(() => undefined);
  }
}, 60000);

test("a join whose insert fails leaves no participant lock on its connection, and the next join does not wait", async () => {
  await conversation(FAILED_INSERT_ZID);
  const [uid, other] = await users(FAILED_INSERT_ZID * 1000 + 1, 2);
  const failing = await session();
  const next = await session();
  try {
    expect((await join(pg, FAILED_INSERT_ZID, uid)).pid).toBe(0);
    // The same user again fails on (zid, uid) after the trigger took the lock;
    // the connection is then rolled back but kept open, as a pooled one is
    // (pg.withTransaction, for example, pools a client after an error).
    const refused = await join(failing, FAILED_INSERT_ZID, uid);
    const holders = await lockHolders(FAILED_INSERT_ZID);

    await next.query("SET lock_timeout = '3s'");
    const outcome = await join(next, FAILED_INSERT_ZID, other);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "a join that fails, its connection kept",
        refused: refused.error
          ? `${refused.error.code} ${refused.error.constraint}`
          : "joined",
        sessions_holding_lock_after_rollback: holders,
        next_join: outcome.error
          ? `error ${outcome.error.code}`
          : `pid ${outcome.pid}`,
        next_join_ms: outcome.ms,
      })}\n`
    );

    expect(refused.error).toEqual({
      code: "23505",
      constraint: "participants_zid_uid_key",
    });
    expect(holders).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(outcome.ms).toBeLessThan(NEXT_JOIN_BUDGET_MS);
    expect(outcome.pid).toBe(1);
  } finally {
    await failing.end().catch(() => undefined);
    await next.end().catch(() => undefined);
  }
}, 60000);

test("a participant row skipped by ON CONFLICT DO NOTHING (the CSV import) leaves no participant lock on its connection, and the next join does not wait", async () => {
  await conversation(SKIPPED_ROW_ZID);
  const [uid, other] = await users(SKIPPED_ROW_ZID * 1000 + 1, 2);
  const importer = await session();
  const next = await session();
  try {
    expect((await join(pg, SKIPPED_ROW_ZID, uid)).pid).toBe(0);
    // The import worker's participants insert (src/workers/import-processor.ts)
    // for a user who already joined: the BEFORE trigger runs, the row is
    // skipped, and the transaction commits.
    await importer.query("BEGIN");
    const skipped = await importer.query(
      "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, default) ON CONFLICT (zid, uid) DO NOTHING",
      [uid, SKIPPED_ROW_ZID]
    );
    await importer.query("COMMIT");
    const holders = await lockHolders(SKIPPED_ROW_ZID);

    await next.query("SET lock_timeout = '3s'");
    const outcome = await join(next, SKIPPED_ROW_ZID, other);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "a participant row skipped by ON CONFLICT DO NOTHING",
        rows_inserted: skipped.rowCount,
        sessions_holding_lock_after_commit: holders,
        next_join: outcome.error
          ? `error ${outcome.error.code}`
          : `pid ${outcome.pid}`,
        next_join_ms: outcome.ms,
      })}\n`
    );

    expect(skipped.rowCount).toBe(0);
    expect(holders).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(outcome.ms).toBeLessThan(NEXT_JOIN_BUDGET_MS);
    expect(outcome.pid).toBe(1);
  } finally {
    await importer.end().catch(() => undefined);
    await next.end().catch(() => undefined);
  }
}, 60000);
