/** Statements sent at the same moment in one conversation must all be stored,
 * each with its own statement number, and a failed insert must leave nothing
 * behind that makes the next statement wait.
 *
 * The tid_auto trigger numbers a conversation's statements MAX(tid) + 1, from
 * 0, under an advisory lock per conversation (server/postgres/migrations).
 * For as long as that lock ends before the inserting transaction commits, a
 * second insert in the conversation can read the same MAX(tid), wait on the
 * (zid, tid) unique index, and fail with 23505 once the first commits; the
 * comment route answered that as a duplicate, and the statement was not
 * stored. With the lock held until the transaction ends, the second insert
 * reads MAX(tid) only after the first has committed.
 *
 * Every connection here is its own session, as the participation pools of
 * several servers are. A connection whose INSERT failed is closed and
 * replaced, as the server's query helper closes a failed client.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh. */
import { Client } from "pg";

// tid_auto's advisory lock class; the conversation id is the second key.
const TID_LOCK = 873791984;
const BURST_ZID = { 40: 9611, 72: 9612 } as const;
const COMMIT_ORDER_ZID = 9613,
  FAILED_INSERT_ZID = 9614,
  SAME_TEXT_ZID = 9615;
const ROUNDS = 5;
// An insert that the lock lets through must finish well within this.
const NEXT_INSERT_BUDGET_MS = 1000;
// Upper bound on any lock wait in this file, so a lock nobody releases fails a
// test instead of hanging it.
const LOCK_TIMEOUT = "20s";

// The comment route's INSERT (src/routes/comments.ts), with tid left to the
// trigger.
const INSERT_STATEMENT = `INSERT INTO COMMENTS
  (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
  VALUES ($1, $2, $3, 1, true, 0, $4, false, false, default, null, null, null)
  RETURNING tid;`;

type Author = { uid: number; pid: number };
type Outcome = {
  ms: number;
  tid?: number;
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

/** A user with an explicit uid: other suites in this database insert users with
 * explicit small uids without advancing the sequence, so a uid from the
 * sequence can collide with one of theirs. These are zid * 1000 + i. */
async function user(uid: number): Promise<number> {
  return (
    await pg.query(
      "INSERT INTO users (uid, created) VALUES ($1, default) RETURNING uid",
      [uid]
    )
  ).rows[0].uid;
}

async function conversationWithAuthors(
  zid: number,
  n: number
): Promise<Author[]> {
  const owner = await user(zid * 1000);
  await pg.query(
    "INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')",
    [zid, owner]
  );
  const authors: Author[] = [];
  for (let i = 0; i < n; i++) {
    const uid = await user(zid * 1000 + 1 + i);
    const pid = (
      await pg.query(
        "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
        [zid, uid]
      )
    ).rows[0].pid;
    authors.push({ uid, pid });
  }
  return authors;
}

function insert(
  client: Client,
  zid: number,
  author: Author,
  txt: string
): Promise<Outcome> {
  const started = Date.now();
  return client
    .query(INSERT_STATEMENT, [author.pid, zid, txt, author.uid])
    .then(
      (r) => ({ ms: Date.now() - started, tid: r.rows[0].tid }),
      (error) => ({
        ms: Date.now() - started,
        error: { code: error.code, constraint: error.constraint },
      })
    );
}

/** Sessions holding the conversation's statement-number lock. */
async function lockHolders(zid: number): Promise<number> {
  return (
    await pg.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
    AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 2`,
      [TID_LOCK, zid]
    )
  ).rows[0].n;
}

/** What the session is waiting on, or null when it is not waiting on a lock. */
async function lockWait(pid: number): Promise<string | null> {
  const row = (
    await pg.query(
      "SELECT wait_event FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
      [pid]
    )
  ).rows[0];
  return row ? row.wait_event : null;
}

async function untilWaiting(pid: number): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const wait = await lockWait(pid);
    if (wait) return wait;
    if (Date.now() > deadline)
      throw new Error(`session ${pid} never waited on a lock`);
    await sleep(10);
  }
}

async function storedTids(zid: number): Promise<number[]> {
  return (
    await pg.query("SELECT tid FROM comments WHERE zid = $1 ORDER BY tid", [
      zid,
    ])
  ).rows.map((r) => r.tid);
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
});
afterAll(async () => {
  await pg?.end();
});

test.each([40, 72] as const)(
  "%i statements sent at once into one conversation, round after round: every one is stored, with distinct contiguous numbers",
  async (n) => {
    const zid = BURST_ZID[n];
    const authors = await conversationWithAuthors(zid, n);
    const sessions = await Promise.all(authors.map(() => session()));
    const perRound: Array<{
      round: number;
      sent: number;
      stored: number;
      refused: number;
      refusals: string[];
    }> = [];
    let refusedTotal = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const outcomes = await Promise.all(
          authors.map(async (author, i) => {
            const outcome = await insert(
              sessions[i],
              zid,
              author,
              `round ${round}: statement from participant ${i}`
            );
            if (outcome.error) {
              // The server closes a client whose statement failed, at once.
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
          stored: n - refusals.length,
          refused: refusals.length,
          refusals: [...new Set(refusals)],
        });
      }
    } finally {
      await Promise.all(sessions.map((s) => s.end().catch(() => undefined)));
    }
    const tids = await storedTids(zid);
    process.stdout.write(
      `${JSON.stringify({
        scenario: `${n} statements at once, ${ROUNDS} rounds`,
        per_round: perRound,
        sent: n * ROUNDS,
        stored: tids.length,
        refused: refusedTotal,
        numbers_contiguous_from_0: tids.every((tid, i) => tid === i),
      })}\n`
    );

    expect(refusedTotal).toBe(0);
    expect(tids).toEqual(Array.from({ length: n * ROUNDS }, (_, i) => i));
    expect(await lockHolders(zid)).toBe(0);
  },
  120000
);

test("a statement inserted while another in its conversation is not yet committed gets the next number once that one commits", async () => {
  const [authorA, authorB] = await conversationWithAuthors(COMMIT_ORDER_ZID, 2);
  const a = await session();
  const b = await session();
  const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  try {
    // A has inserted (the trigger numbered it) and not committed: in
    // production its COMMIT is one round trip later.
    await a.query("BEGIN");
    const first = await insert(
      a,
      COMMIT_ORDER_ZID,
      authorA,
      "first, committed after the second is sent"
    );
    expect(first.error).toBeUndefined();

    const second = insert(
      b,
      COMMIT_ORDER_ZID,
      authorB,
      "second, sent before the first commits"
    );
    const waitedOn = await untilWaiting(bPid);
    await a.query("COMMIT");
    const outcome = await second;
    const holders = await lockHolders(COMMIT_ORDER_ZID);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "second statement sent before the first commits",
        second_waited_on: waitedOn,
        first_tid: first.tid,
        second: outcome.error
          ? `error ${outcome.error.code} ${outcome.error.constraint}`
          : `tid ${outcome.tid}`,
        sessions_holding_lock_after: holders,
      })}\n`
    );

    // It waits for the statement number, not for a unique index it will fail on.
    expect(waitedOn).toBe("advisory");
    expect(outcome.error).toBeUndefined();
    expect(outcome.tid).toBe(first.tid! + 1);
    expect(holders).toBe(0);
    expect(await storedTids(COMMIT_ORDER_ZID)).toEqual([0, 1]);
  } finally {
    await a.end().catch(() => undefined);
    await b.end().catch(() => undefined);
  }
}, 60000);

test("a statement whose insert fails leaves no statement-number lock on its connection, and the next statement does not wait", async () => {
  const [author, other] = await conversationWithAuthors(FAILED_INSERT_ZID, 2);
  await insert(pg, FAILED_INSERT_ZID, author, "already in the conversation");
  const failing = await session();
  const next = await session();
  try {
    // The same text again fails on (zid, txt) after the trigger took the lock;
    // the connection is then rolled back but kept open, as a pooled one is.
    await failing.query("BEGIN");
    const refused = await insert(
      failing,
      FAILED_INSERT_ZID,
      author,
      "already in the conversation"
    );
    await failing.query("ROLLBACK");
    const holders = await lockHolders(FAILED_INSERT_ZID);

    await next.query("SET lock_timeout = '3s'");
    const outcome = await insert(
      next,
      FAILED_INSERT_ZID,
      other,
      "the next statement"
    );
    process.stdout.write(
      `${JSON.stringify({
        scenario: "an insert that fails, its connection kept",
        refused: refused.error
          ? `${refused.error.code} ${refused.error.constraint}`
          : "stored",
        sessions_holding_lock_after_rollback: holders,
        next_statement: outcome.error
          ? `error ${outcome.error.code}`
          : `tid ${outcome.tid}`,
        next_statement_ms: outcome.ms,
      })}\n`
    );

    expect(refused.error?.code).toBe("23505");
    expect(holders).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(outcome.ms).toBeLessThan(NEXT_INSERT_BUDGET_MS);
    expect(outcome.tid).toBe(1);
  } finally {
    await failing.end().catch(() => undefined);
    await next.end().catch(() => undefined);
  }
}, 60000);

test("the same text sent twice at once: one is stored, the other is refused on the conversation's (zid, txt) index", async () => {
  const authors = await conversationWithAuthors(SAME_TEXT_ZID, 2);
  const sessions = await Promise.all(authors.map(() => session()));
  try {
    const outcomes = await Promise.all(
      authors.map((author, i) =>
        insert(
          sessions[i],
          SAME_TEXT_ZID,
          author,
          "one statement, sent by two participants at once"
        )
      )
    );
    const refused = outcomes.filter((o) => o.error);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "the same text twice at once",
        outcomes: outcomes.map((o) =>
          o.error ? `${o.error.code} ${o.error.constraint}` : `tid ${o.tid}`
        ),
      })}\n`
    );

    expect(outcomes.filter((o) => !o.error)).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The constraint the comment route answers 409 duplicate for.
    expect(refused[0].error).toEqual({
      code: "23505",
      constraint: "comments_zid_txt_key",
    });
    expect(await storedTids(SAME_TEXT_ZID)).toEqual([0]);
    expect(await lockHolders(SAME_TEXT_ZID)).toBe(0);
  } finally {
    await Promise.all(sessions.map((s) => s.end().catch(() => undefined)));
  }
}, 60000);
