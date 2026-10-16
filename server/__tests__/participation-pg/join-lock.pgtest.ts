/** Joining a conversation must never leave its participant lock on a pooled
 * connection, and must never wait on that lock indefinitely.
 *
 * The pid_auto trigger (server/postgres/migrations/000000_initial.sql) takes a
 * SESSION advisory lock per conversation and pid_auto_unlock gives it back only
 * after a successful INSERT. Two joiners racing in one conversation can be
 * handed the same pid: the second takes the lock as soon as the first's INSERT
 * ends, before the first has committed. The second INSERT then fails on
 * (zid, pid), and its session keeps the lock through ROLLBACK. If that
 * connection goes back to the pool, every later joiner of the conversation on
 * any other connection, on this server or another, waits for a lock nobody
 * will release, and holds a read-write connection while it waits.
 *
 * Generated data only. Needs DATABASE_URL (superuser, migrated); see
 * scripts/test-delphi-result-reads.sh. */
import { Client } from "pg";
import { addParticipant, joinConversation } from "../../src/participant";

// pid_auto's advisory lock class; the conversation id is the second key.
const PID_LOCK = 873791983;
const RACE_ZID = 9601, HELD_ZID = 9602;
// A later joiner must have its participant within this budget.
const LATER_JOIN_BUDGET_MS = 1000;
// A joiner facing a lock nobody releases must be answered within this cap.
const HELD_LOCK_CAP_MS = 8000;

type Outcome = { ms: number; rows?: any; error?: any };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let pg: Client;
// A second server process: its own module instance, so its own connection
// pools, against the same database.
let otherServer: { addParticipant: typeof addParticipant };

function timed(work: Promise<any>): Promise<Outcome> {
  const started = Date.now();
  return work.then(
    rows => ({ ms: Date.now() - started, rows }),
    error => ({ ms: Date.now() - started, error }),
  );
}

/** The outcome if it settles within capMs, else "waiting". */
async function within(outcome: Promise<Outcome>, capMs: number): Promise<Outcome | "waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<"waiting">(resolve => { timer = setTimeout(() => resolve("waiting"), capMs); });
  try {
    return await Promise.race([outcome, cap]);
  } finally {
    clearTimeout(timer);
  }
}

async function newUsers(n: number): Promise<number[]> {
  const uids: number[] = [];
  for (let i = 0; i < n; i++) {
    uids.push((await pg.query("INSERT INTO users (created) VALUES (default) RETURNING uid")).rows[0].uid);
  }
  return uids;
}

async function newConversation(zid: number): Promise<void> {
  const [owner] = await newUsers(1);
  await pg.query("INSERT INTO conversations (zid, owner, topic) VALUES ($1, $2, 'generated')", [zid, owner]);
}

/** Sessions holding the conversation's participant lock. */
async function lockHolders(zid: number): Promise<number> {
  return (await pg.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
    AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 2`, [PID_LOCK, zid])).rows[0].n;
}

/** Participant INSERTs currently waiting on a lock. */
async function waitingInserts(): Promise<number> {
  return (await pg.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
    AND query LIKE 'INSERT INTO participants (pid%'`)).rows[0].n;
}

beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await newConversation(RACE_ZID);
  await newConversation(HELD_ZID);
  jest.isolateModules(() => {
    otherServer = require("../../src/participant");
  });
});
afterAll(async () => { await pg?.end(); });

test("a joiner that loses the pid race leaves no lock behind, still gets a participant, and later joiners do not wait", async () => {
  const [uidA, uidB, uidC] = await newUsers(3);

  // Joiner A has run its INSERT (pid_auto took and gave back the lock); its
  // COMMIT, one round trip later in production, has not arrived yet.
  const a = new Client({ connectionString: process.env.DATABASE_URL });
  await a.connect();
  await a.query("BEGIN");
  await a.query("INSERT INTO participants_extended (zid, uid) VALUES ($1, $2) ON CONFLICT (zid, uid) DO NOTHING", [RACE_ZID, uidA]);
  const pidA = (await a.query("INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid", [RACE_ZID, uidA])).rows[0].pid;

  // Joiner B joins through the server. pid_auto gives it A's pid, because A's
  // row is not committed, and B then waits on A's conversations row.
  const lost = timed(addParticipant(RACE_ZID, uidB));
  const deadline = Date.now() + 5000;
  while ((await waitingInserts()) === 0) {
    if (Date.now() > deadline) throw new Error("joiner B never reached the lock wait");
    await sleep(20);
  }
  await a.query("COMMIT");
  await a.end();
  const lostOutcome = await lost;
  const leaked = await lockHolders(RACE_ZID);

  // Joiner C arrives at another server process: its pool never holds B's
  // connection, so it can only proceed if no session kept the lock.
  const later = timed(otherServer.addParticipant(RACE_ZID, uidC));
  const laterSeen = await within(later, LATER_JOIN_BUDGET_MS * 3);
  // Let a stalled joiner finish before the next test (on the unfixed code the
  // leaked connection closes after the pool's 10 s idle timeout).
  const laterOutcome = await later;

  process.stdout.write(`${JSON.stringify({
    lost_race: lostOutcome.error ? `error ${lostOutcome.error.code}` : `pid ${lostOutcome.rows?.[0]?.pid}`,
    winner_pid: pidA,
    sessions_holding_lock_after: leaked,
    later_join_ms: laterSeen === "waiting" ? `>${LATER_JOIN_BUDGET_MS * 3} (waiting)` : laterSeen.ms,
    later_join_finished_ms: laterOutcome.ms,
  })}\n`);

  expect(leaked).toBe(0);
  expect(laterSeen).not.toBe("waiting");
  expect((laterSeen as Outcome).error).toBeUndefined();
  expect((laterSeen as Outcome).ms).toBeLessThan(LATER_JOIN_BUDGET_MS);
  expect(lostOutcome.error).toBeUndefined();
  expect(lostOutcome.rows?.[0]?.uid).toBe(uidB);
  expect(lostOutcome.rows?.[0]?.pid).not.toBe(pidA);
  const pids = (await pg.query("SELECT uid, pid FROM participants WHERE zid = $1 ORDER BY pid", [RACE_ZID])).rows;
  expect(pids.map(r => r.uid).sort()).toEqual([uidA, uidB, uidC].sort());
  expect(new Set(pids.map(r => r.pid)).size).toBe(3);
}, 60000);

// Both ways a participant row is created: addParticipant directly (votes and
// comments, through ensureParticipant and the comment route) and
// joinConversation, which retries a failed join up to ten times.
test.each([
  ["addParticipant (votes, comments)", (zid: number, uid: number) => addParticipant(zid, uid)],
  ["joinConversation (POST /api/v3/participants)", (zid: number, uid: number) => joinConversation(zid, uid)],
])("%s: a joiner facing a participant lock that is never released is answered, not left waiting", async (path, join) => {
  const [uid] = await newUsers(1);
  // A session that kept the lock: a server still running code that leaks it,
  // during a deploy for example.
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query("SELECT pg_advisory_lock($1, $2)", [PID_LOCK, HELD_ZID]);

  const joining = timed(join(HELD_ZID, uid));
  const seen = await within(joining, HELD_LOCK_CAP_MS);
  await holder.query("SELECT pg_advisory_unlock_all()");
  await holder.end();
  const finished = await joining;

  process.stdout.write(`${JSON.stringify({
    path,
    held_lock_join: seen === "waiting" ? `>${HELD_LOCK_CAP_MS} (waiting)` : (seen.error ? `error ${seen.error.code}` : "joined"),
    held_lock_join_ms: seen === "waiting" ? null : seen.ms,
    finished_after_release_ms: finished.ms,
  })}\n`);

  expect(seen).not.toBe("waiting");
  expect((seen as Outcome).error?.code).toBe("55P03");
  expect(await lockHolders(HELD_ZID)).toBe(0);
}, 60000);
