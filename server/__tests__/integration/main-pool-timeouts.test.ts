/**
 * Votes and comments must answer, never hang, when slow work holds the API
 * server's main pools.
 *
 * Votes, comments and the next statement run on the read-write and read pools
 * (src/db/pg-query.ts). Work that takes one of their connections and then waits
 * on something else (a model call, a network fetch, a stalled client) holds it
 * without running a statement, so no statement timeout can end the hold. With
 * every connection held like that, a vote or comment used to queue for a
 * connection until one was released: the participant saw nothing until the
 * client gave up. The acquire bound makes the request fail at that bound with
 * the route's ordinary database error, and store nothing, so the participant
 * can submit it again; once the holders let go, it succeeds.
 *
 * The statement bound is the other half: a runaway statement on these pools is
 * cancelled by Postgres at the bound and its connection returns, so it cannot
 * occupy a participation connection indefinitely.
 *
 * Same shape as the participation-path guards in ../participation-pg/ and
 * ../delphi-results-pg/concurrency.pgtest.ts: hold the shared resource, then
 * measure the participation request. A failure is read as possible
 * starvation of the participation path first; the bounds are never widened to
 * make it pass.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { PoolClient } from "pg";
import pg, {
  MAIN_POOL_ACQUIRE_TIMEOUT_MS,
  MAIN_POOL_MAX,
  MAIN_POOL_STATEMENT_TIMEOUT_MS,
} from "../../src/db/pg-query";
import {
  initializeParticipant,
  setupAuthAndConvo,
  submitComment,
  submitVote,
  wait,
} from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";
import { toWire } from "../setup/vote-wire";

// Time allowed past a bound for the error to travel back through the route.
// Generous for a loaded runner; the lower edge of each window shows the bound,
// not some earlier failure, is what answered.
const SLACK_MS = 2500;

type Outcome<T> = { ms: number; value?: T; error?: any };
function timed<T>(work: Promise<T>): Promise<Outcome<T>> {
  const started = Date.now();
  return work.then(
    (value) => ({ ms: Date.now() - started, value }),
    (error) => ({ ms: Date.now() - started, error })
  );
}
/** The work's result, or "waiting" if it has not settled within `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T | "waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

describe("main pool bounds", () => {
  let conversationId: string;
  let zid: number;
  let tids: number[];
  let pid: number;
  let agent: Awaited<ReturnType<typeof initializeParticipant>>["agent"];

  const storedVotes = async (tid: number) =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM votes WHERE zid = $1 AND pid = $2 AND tid = $3",
        [zid, pid, tid]
      )
    ).rows[0].n as number;
  const storedComments = async (txt: string) =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM comments WHERE zid = $1 AND txt = $2",
        [zid, txt]
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({ commentCount: 3 });
    conversationId = setup.conversationId;
    tids = setup.commentIds;
    zid = (
      await pool.query("SELECT zid FROM zinvites WHERE zinvite = $1", [
        conversationId,
      ])
    ).rows[0].zid;

    // A participant who has already voted once, as in a running conversation.
    const participant = await initializeParticipant(conversationId);
    agent = participant.agent;
    const first = await submitVote(agent, {
      conversation_id: conversationId,
      tid: tids[0],
      vote: toWire("agree"),
    });
    expect(first.status).toBe(200);
    pid = first.body.currentPid;
    // Let the vote's background bookkeeping finish before the pools are held.
    await wait(500);
  });

  afterAll(async () => {
    await closePool();
  });

  test("a vote and a comment answer within the acquire bound while every main-pool connection is held, then succeed once released", async () => {
    expect(MAIN_POOL_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
    const txt = `held-pool comment ${Date.now()}`;

    // Slow work takes every connection of both pools and keeps it.
    const held: PoolClient[] = [];
    for (let i = 0; i < MAIN_POOL_MAX; i++) held.push(await pg.connect());
    for (let i = 0; i < MAIN_POOL_MAX; i++)
      held.push(await pg.connectReadOnly());
    const releaseHolders = () => {
      while (held.length) held.pop()!.release();
    };

    const vote = timed(
      submitVote(agent, {
        conversation_id: conversationId,
        tid: tids[1],
        vote: toWire("disagree"),
      })
    );
    const comment = timed(
      submitComment(agent, { conversation_id: conversationId, txt })
    );
    let seen: unknown;
    try {
      seen = await within(
        Promise.all([vote, comment]),
        MAIN_POOL_ACQUIRE_TIMEOUT_MS + SLACK_MS
      );
    } finally {
      releaseHolders();
    }
    // On a pool with no acquire bound the requests are still queued here; they
    // finish once the holders let go, so the test reports instead of hanging.
    const [voteOut, commentOut] = await Promise.all([vote, comment]);
    process.stdout.write(
      `${JSON.stringify({
        pool_max: MAIN_POOL_MAX,
        acquire_timeout_ms: MAIN_POOL_ACQUIRE_TIMEOUT_MS,
        within_bound: seen !== "waiting",
        vote_ms: voteOut.ms,
        vote_status: voteOut.value?.status,
        vote_body: voteOut.value?.text?.slice(0, 120),
        comment_ms: commentOut.ms,
        comment_status: commentOut.value?.status,
        comment_body: commentOut.value?.text?.slice(0, 120),
      })}\n`
    );

    expect(seen).not.toBe("waiting");
    for (const out of [voteOut, commentOut]) {
      expect(out.error).toBeUndefined();
      expect(out.ms).toBeGreaterThanOrEqual(MAIN_POOL_ACQUIRE_TIMEOUT_MS - 250);
      expect(out.ms).toBeLessThan(MAIN_POOL_ACQUIRE_TIMEOUT_MS + SLACK_MS);
    }
    // The route's ordinary answer for a database failure, given promptly.
    expect(voteOut.value!.status).toBe(500);
    expect(voteOut.value!.body).toMatchObject({ error: "polis_err_vote" });
    expect(commentOut.value!.status).toBe(500);
    expect(commentOut.value!.body).toMatchObject({
      error: "polis_err_post_comment",
    });
    // An error answer stored nothing: submitting again is the only write.
    expect(await storedVotes(tids[1])).toBe(0);
    expect(await storedComments(txt)).toBe(0);

    // Once the holders have released their connections, the same vote and
    // comment succeed.
    const retriedVote = await submitVote(agent, {
      conversation_id: conversationId,
      tid: tids[1],
      vote: toWire("disagree"),
    });
    expect(retriedVote.status).toBe(200);
    expect(await storedVotes(tids[1])).toBe(1);
    const retriedComment = await submitComment(agent, {
      conversation_id: conversationId,
      txt,
    });
    expect(retriedComment.status).toBe(200);
    expect(await storedComments(txt)).toBe(1);
  }, 60000);

  test("a runaway statement on either main pool is cancelled at the statement bound, and the next vote is served", async () => {
    expect(MAIN_POOL_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    const sleepSeconds = Math.ceil(MAIN_POOL_STATEMENT_TIMEOUT_MS / 1000) + 5;

    const [readWrite, read] = await Promise.all([
      timed(pg.queryP("SELECT pg_sleep($1)", [sleepSeconds])),
      timed(pg.queryP_readOnly("SELECT pg_sleep($1)", [sleepSeconds])),
    ]);
    process.stdout.write(
      `${JSON.stringify({
        statement_timeout_ms: MAIN_POOL_STATEMENT_TIMEOUT_MS,
        read_write: { ms: readWrite.ms, code: readWrite.error?.code ?? null },
        read: { ms: read.ms, code: read.error?.code ?? null },
      })}\n`
    );
    for (const out of [readWrite, read]) {
      // 57014 query_canceled: the server's statement_timeout fired.
      expect(out.error?.code).toBe("57014");
      expect(out.ms).toBeGreaterThanOrEqual(
        MAIN_POOL_STATEMENT_TIMEOUT_MS - 250
      );
      expect(out.ms).toBeLessThan(MAIN_POOL_STATEMENT_TIMEOUT_MS + SLACK_MS);
    }

    const next = await timed(
      submitVote(agent, {
        conversation_id: conversationId,
        tid: tids[2],
        vote: toWire("pass"),
      })
    );
    expect(next.error).toBeUndefined();
    expect(next.value!.status).toBe(200);
    expect(next.ms).toBeLessThan(MAIN_POOL_ACQUIRE_TIMEOUT_MS);
    expect(await storedVotes(tids[2])).toBe(1);
  }, 60000);
});
