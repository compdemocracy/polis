/** Accepting a treevite invite must never leave the conversation's participant
 * lock on a pooled connection, must never wait on that lock without a bound,
 * and must not refuse an invitee who loses the race for a participant number.
 *
 * acceptInvite creates the invitee's participants row, which fires the pid_auto
 * trigger (server/postgres/migrations/000000_initial.sql). The trigger takes a
 * SESSION advisory lock per conversation, and pid_auto_unlock gives it back only
 * after an INSERT that succeeds: an INSERT that fails keeps it on its session.
 * The lock is also given back before the inserting transaction commits, so a
 * second joiner can be handed the pid of a first joiner that has not committed
 * yet, and its INSERT then fails on (zid, pid). A connection that went back to
 * the pool still holding the lock would make every later joiner of the
 * conversation, through acceptInvite or a vote, a comment or participationInit,
 * wait on a lock nobody releases.
 *
 * Generated data only. Invitation codes and login codes are never printed. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { Client } from "pg";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { addParticipant as AddParticipant } from "../../src/participant";

// pid_auto's advisory lock class; the conversation id is the second key.
const PID_LOCK = 873791983;
// A joiner of the conversation must have its participant within this budget.
const JOIN_BUDGET_MS = 1000;
// A connection discarded on an error ends its session within this; a lock still
// held after it is held by a session that is still open.
const LOCK_SETTLE_MS = 2000;
// An accept facing a lock that is never released must be answered within this.
const HELD_LOCK_CAP_MS = 8000;

type Outcome = { ms: number; at: number; value?: any; error?: any };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let db: Client;
let owner: Agent;
// A second server process: its own module instance, so its own connection
// pools, against the same database. A connection the accept leaked can never be
// handed to it.
let otherServer: { addParticipant: typeof AddParticipant };

function timed(work: Promise<any>): Promise<Outcome> {
  const started = Date.now();
  return work.then(
    (value) => ({ ms: Date.now() - started, at: Date.now(), value }),
    (error) => ({ ms: Date.now() - started, at: Date.now(), error })
  );
}

/** The outcome if it settles within capMs, else "waiting". */
async function within(
  outcome: Promise<Outcome>,
  capMs: number
): Promise<Outcome | "waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), capMs);
  });
  try {
    return await Promise.race([outcome, cap]);
  } finally {
    clearTimeout(timer);
  }
}

async function newUsers(n: number): Promise<number[]> {
  const uids: number[] = [];
  for (let i = 0; i < n; i++) {
    uids.push(
      (
        await db.query(
          "INSERT INTO users (created) VALUES (default) RETURNING uid"
        )
      ).rows[0].uid
    );
  }
  return uids;
}

/** A treevite conversation with one wave of owner invites. */
async function treeviteConversation(
  invites: number
): Promise<{ conversationId: string; zid: number; codes: string[] }> {
  const conversationId = await createConversation(owner, {
    topic: "generated",
    treevite_enabled: true,
  });
  const wave = await owner.post("/api/v3/treevite/waves").send({
    conversation_id: conversationId,
    owner_invites: invites,
    invites_per_user: 0,
  });
  expect(wave.status).toBe(201);
  const listed = await owner.get("/api/v3/treevite/invites").query({
    conversation_id: conversationId,
    status: 0,
    limit: invites,
  });
  expect(listed.status).toBe(200);
  const codes = listed.body.invites.map(
    (i: { invite_code: string }) => i.invite_code
  );
  expect(codes).toHaveLength(invites);
  const zid = (
    await db.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
      conversationId,
    ])
  ).rows[0].zid;
  return { conversationId, zid, codes };
}

/** POST acceptInvite as a new visitor; resolves to the HTTP status and error. */
async function acceptInvite(
  conversationId: string,
  code: string
): Promise<{ status: number; error?: string }> {
  const agent = await newAgent();
  const response = await agent.post("/api/v3/treevite/acceptInvite").send({
    conversation_id: conversationId,
    invite_code: code,
  });
  return {
    status: response.status,
    error:
      response.status === 201
        ? undefined
        : response.body?.error ?? response.text,
  };
}

/** Sessions holding the conversation's participant lock, and their state. */
async function lockHolders(
  zid: number
): Promise<{ pid: number; state: string | null }[]> {
  return (
    await db.query(
      `SELECT l.pid, a.state FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.granted AND l.classid::bigint = $1 AND l.objid::bigint = $2
    AND l.objsubid = 2`,
      [PID_LOCK, zid]
    )
  ).rows;
}

/** The holders still there once a discarded connection has had time to end. */
async function settledLockHolders(
  zid: number
): Promise<{ pid: number; state: string | null }[]> {
  const deadline = Date.now() + LOCK_SETTLE_MS;
  let holders = await lockHolders(zid);
  while (holders.length > 0 && Date.now() < deadline) {
    await sleep(25);
    holders = await lockHolders(zid);
  }
  return holders;
}

/** Participant INSERTs waiting, directly or behind another waiter, on the
 * session `blocker` (other suites' joins running at the same time do not
 * count). */
async function insertsWaitingOn(blocker: number): Promise<number> {
  return (
    await db.query(
      `WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::int AS n FROM waiting JOIN pg_stat_activity a USING (pid)
      WHERE a.wait_event_type = 'Lock' AND a.query ILIKE 'insert into participants %'`,
      [blocker]
    )
  ).rows[0].n;
}

async function untilWaiting(
  blocker: number,
  n: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + 5000;
  while ((await insertsWaitingOn(blocker)) < n) {
    if (Date.now() > deadline)
      throw new Error(`${what} never reached the lock wait`);
    await sleep(20);
  }
}

/** A first joiner that has run its participants INSERT (pid_auto took and gave
 * back the lock) and not yet committed: the moment between the INSERT and the
 * COMMIT of a join through the server, held open. */
async function uncommittedJoiner(
  zid: number,
  uid: number
): Promise<{ pid: number; session: number; commit: () => Promise<void> }> {
  const session = new Client({ connectionString: process.env.DATABASE_URL });
  await session.connect();
  const backend = (await session.query("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid;
  await session.query("BEGIN");
  const pid = (
    await session.query(
      "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid",
      [zid, uid]
    )
  ).rows[0].pid;
  return {
    pid,
    session: backend,
    commit: async () => {
      await session.query("COMMIT");
      await session.end();
    },
  };
}

function report(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const pooled = getPooledTestUser(1);
  ({ agent: owner } = await getJwtAuthenticatedAgent({
    email: pooled.email,
    hname: pooled.name,
    password: pooled.password,
  }));
  jest.isolateModules(() => {
    otherServer = require("../../src/participant");
  });
});
afterAll(async () => {
  await db?.end();
});

describe("treevite acceptInvite and the participant lock", () => {
  test("an accept that loses the race for a participant number leaves no lock on a pooled connection, and joiners do not wait", async () => {
    const { conversationId, zid, codes } = await treeviteConversation(1);
    const [uidA, uidC, uidD] = await newUsers(3);

    const first = await uncommittedJoiner(zid, uidA);
    // The accept is handed the first joiner's pid and waits on its commit.
    const accepting = timed(acceptInvite(conversationId, codes[0]));
    await untilWaiting(first.session, 1, "the accept");
    // A plain join (the insert behind votes, comments and participationInit)
    // arrives at another server process meanwhile and queues on the lock.
    const concurrent = timed(otherServer.addParticipant(zid, uidC));
    await untilWaiting(first.session, 2, "the concurrent join");
    const committedAt = Date.now();
    await first.commit();

    const concurrentSeen = await within(concurrent, JOIN_BUDGET_MS * 3);
    const concurrentDone = await concurrent;
    const accepted = await accepting;
    const holdersAtAnswer = await lockHolders(zid);
    const holders = await settledLockHolders(zid);
    // A join arriving after the accept has answered.
    const later = timed(otherServer.addParticipant(zid, uidD));
    const laterSeen = await within(later, JOIN_BUDGET_MS * 3);
    const laterDone = await later;

    report({
      case: "accept loses the pid race, a plain join waits behind it",
      accept: accepted.value
        ? `${accepted.value.status}${
            accepted.value.error ? ` ${accepted.value.error}` : ""
          }`
        : `threw ${accepted.error}`,
      sessions_holding_lock_at_answer: holdersAtAnswer.length,
      sessions_holding_lock_after_accept: holders.length,
      holder_states: holders.map((h) => h.state),
      concurrent_join_ms_after_first_commit:
        concurrentSeen === "waiting"
          ? `>${JOIN_BUDGET_MS * 3} (waiting)`
          : concurrentDone.at - committedAt,
      concurrent_join: concurrentDone.error
        ? `error ${concurrentDone.error.code}`
        : `pid ${concurrentDone.value?.[0]?.pid}`,
      later_join_ms:
        laterSeen === "waiting"
          ? `>${JOIN_BUDGET_MS * 3} (waiting)`
          : laterSeen.ms,
      later_join: laterDone.error
        ? `error ${laterDone.error.code}`
        : `pid ${laterDone.value?.[0]?.pid}`,
    });

    expect(holders).toEqual([]);
    expect(concurrentSeen).not.toBe("waiting");
    expect(concurrentDone.error).toBeUndefined();
    expect(concurrentDone.at - committedAt).toBeLessThan(JOIN_BUDGET_MS);
    expect(laterSeen).not.toBe("waiting");
    expect(laterDone.error).toBeUndefined();
    expect(laterDone.ms).toBeLessThan(JOIN_BUDGET_MS);
    const pids = (
      await db.query("SELECT pid FROM participants WHERE zid = $1", [zid])
    ).rows.map((r) => r.pid);
    expect(new Set(pids).size).toBe(pids.length);
  }, 60000);

  test("an accept that loses the race for a participant number still admits the invitee", async () => {
    const { conversationId, zid, codes } = await treeviteConversation(1);
    const [uidA, uidLater] = await newUsers(2);

    const first = await uncommittedJoiner(zid, uidA);
    const accepting = acceptInvite(conversationId, codes[0]);
    await untilWaiting(first.session, 1, "the accept");
    await first.commit();
    const accepted = await accepting;
    const holders = await settledLockHolders(zid);
    const later = await timed(otherServer.addParticipant(zid, uidLater));
    const invite = (
      await db.query(
        "SELECT status, invite_used_by_pid FROM treevite_invites WHERE zid = $1",
        [zid]
      )
    ).rows[0];

    report({
      case: "accept loses the pid race",
      accept: `${accepted.status}${accepted.error ? ` ${accepted.error}` : ""}`,
      first_joiner_pid: first.pid,
      invite_status: invite.status,
      invite_used_by_pid: invite.invite_used_by_pid,
      sessions_holding_lock_after_accept: holders.length,
      later_join_ms: later.ms,
    });

    expect(accepted.status).toBe(201);
    expect(invite.status).toBe(1);
    expect(invite.invite_used_by_pid).not.toBeNull();
    expect(invite.invite_used_by_pid).not.toBe(first.pid);
    const invitee = (
      await db.query(
        "SELECT uid FROM participants WHERE zid = $1 AND pid = $2",
        [zid, invite.invite_used_by_pid]
      )
    ).rows;
    expect(invitee).toHaveLength(1);
    expect(invitee[0].uid).not.toBe(uidA);
    expect(holders).toEqual([]);
    expect(later.error).toBeUndefined();
    expect(later.ms).toBeLessThan(JOIN_BUDGET_MS);
  }, 60000);

  test("an accept facing a participant lock that is never released is answered, not left waiting", async () => {
    const { conversationId, zid, codes } = await treeviteConversation(1);
    // A session that kept the lock: a server still running code that leaks it,
    // during a deploy for example.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1, $2)", [PID_LOCK, zid]);

    const accepting = timed(acceptInvite(conversationId, codes[0]));
    const seen = await within(accepting, HELD_LOCK_CAP_MS);
    await holder.query("SELECT pg_advisory_unlock_all()");
    await holder.end();
    const finished = await accepting;
    const holders = await settledLockHolders(zid);

    report({
      case: "accept facing a held lock",
      held_lock_accept:
        seen === "waiting"
          ? `>${HELD_LOCK_CAP_MS} (waiting)`
          : `${seen.value?.status} ${seen.value?.error ?? ""}`.trim(),
      held_lock_accept_ms: seen === "waiting" ? null : seen.ms,
      finished_after_release_ms: finished.ms,
      sessions_holding_lock_after: holders.length,
    });

    expect(seen).not.toBe("waiting");
    expect((seen as Outcome).value?.status).toBe(500);
    expect((seen as Outcome).value?.error).toBe(
      "polis_err_treevite_accept_invite"
    );
    expect(holders).toEqual([]);
    // The invite was not spent: the invitee can accept it again.
    const invite = (
      await db.query("SELECT status FROM treevite_invites WHERE zid = $1", [
        zid,
      ])
    ).rows[0];
    expect(invite.status).toBe(0);
  }, 60000);
});
