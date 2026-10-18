/**
 * Where the database bounds sit: none on the pools the participation path
 * shares, and their own on the pools only slow work uses.
 *
 * Votes, comments, the next statement and participationInit run on the API
 * server's read-write and read pools (src/db/pg-query.ts). A vote or a comment
 * that has to wait for one of their connections must wait and be stored; it is
 * never refused. So those two pools have no acquire timeout and no statement
 * timeout. With an acquire timeout, a vote held behind slow work answered 500
 * and was not stored; this file and ./participation-under-load.test.ts hold
 * that it waits instead.
 *
 * Slow work keeps its bounds on pools of its own and degrades itself first:
 * reports and exports on the report/export pool (its acquire bound is held by
 * ../participation-pg/export-budget.pgtest.ts), and the collective-statement
 * agent exchange on its own pool.
 *
 * Same shape as the participation-path guards in ../participation-pg/ and
 * ../delphi-results-pg/concurrency.pgtest.ts: hold the shared resource, then
 * measure the participation request. A failure is read as possible refusal or
 * starvation of the participation path first.
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { PoolClient } from "pg";
import pg, {
  AGENT_EXCHANGE_POOL_MAX,
  MAIN_POOL_MAX,
} from "../../src/db/pg-query";
import Config from "../../src/config";
import {
  initializeParticipant,
  setupAuthAndConvo,
  submitComment,
  submitVote,
  wait,
} from "../setup/api-test-helpers";
import { pool, closePool } from "../setup/db-test-helpers";
import { toWire } from "../setup/vote-wire";

/** How long the main pools stay held: longer than the participation budget
 * (5 s) and than the 3 s acquire timeout these pools used to have, after which
 * a held vote answered 500 and was not stored. */
const HELD_MS = 5000;
/** The agent exchange pool's acquire timeout (src/db/pg-query.ts). */
const AGENT_EXCHANGE_ACQUIRE_MS = 5000;
// Time allowed past a bound for the error to travel back. Generous for a
// loaded runner; the lower edge of the window shows the bound answered.
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

/** The statement timeout a pool's connections run with, in ms ("0": none). */
async function statementTimeout(
  run: (sql: string, params: unknown[]) => Promise<unknown>
): Promise<string> {
  const rows = (await run(
    "SELECT setting FROM pg_settings WHERE name = 'statement_timeout'",
    []
  )) as { setting: string }[];
  return rows[0].setting;
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

  test("a vote and a comment wait while every main-pool connection is held, and are stored once the holders release", async () => {
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
      seen = await within(Promise.all([vote, comment]), HELD_MS);
    } finally {
      releaseHolders();
    }
    const [voteOut, commentOut] = await Promise.all([vote, comment]);
    process.stdout.write(
      `${JSON.stringify({
        pool_max: MAIN_POOL_MAX,
        held_ms: HELD_MS,
        waited_while_held: seen === "waiting",
        vote_ms: voteOut.ms,
        vote_status: voteOut.value?.status,
        vote_body: voteOut.value?.text?.slice(0, 120),
        comment_ms: commentOut.ms,
        comment_status: commentOut.value?.status,
        comment_body: commentOut.value?.text?.slice(0, 120),
      })}\n`
    );

    // Neither was answered while the pools were held: both waited, and
    // neither was refused.
    expect(seen).toBe("waiting");
    for (const out of [voteOut, commentOut]) {
      expect(out.error).toBeUndefined();
      expect(out.ms).toBeGreaterThanOrEqual(HELD_MS);
    }
    // Once the holders let go, both are answered and stored.
    expect(voteOut.value!.status).toBe(200);
    expect(commentOut.value!.status).toBe(200);
    expect(await storedVotes(tids[1])).toBe(1);
    expect(await storedComments(txt)).toBe(1);
  }, 60000);

  test("the read-write and read pools run with no statement timeout", async () => {
    expect(await statementTimeout(pg.queryP)).toBe("0");
    expect(await statementTimeout(pg.queryP_readOnly)).toBe("0");
  });

  test("the pools only slow work uses keep their statement timeouts", async () => {
    expect(await statementTimeout(pg.queryP_reportExport)).toBe(
      String(Config.reportExportStatementTimeoutMs)
    );
    expect(await statementTimeout(pg.queryP_agentExchange)).toBe("60000");
  });

  test("the agent exchange pool refuses at its acquire timeout when it is full", async () => {
    const held: PoolClient[] = [];
    for (let i = 0; i < AGENT_EXCHANGE_POOL_MAX; i++)
      held.push(await pg.connectAgentExchange());
    let out: Outcome<unknown>;
    try {
      out = await timed(pg.queryP_agentExchange("SELECT 1", []));
    } finally {
      while (held.length) held.pop()!.release();
    }
    expect(String(out.error?.message ?? out.error)).toMatch(
      /timeout exceeded when trying to connect/
    );
    expect(out.ms).toBeGreaterThanOrEqual(AGENT_EXCHANGE_ACQUIRE_MS - 250);
    expect(out.ms).toBeLessThan(AGENT_EXCHANGE_ACQUIRE_MS + SLACK_MS);
  }, 60000);
});
