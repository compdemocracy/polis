import { beforeAll, expect, test } from "@jest/globals";
import { Pool } from "pg";
import {
  setupAuthAndConvo,
  getJwtAuthenticatedAgent,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import pg, { NOTIFICATION_PENDING_MAX } from "../../src/db/pg-query";
import { onParticipationPools } from "../../src/db/participation-scope";
import {
  conversationModifiedSql,
  participantVoteCountSql,
} from "../../src/db/activity";
import { semanticToWire } from "../../src/votes/convention";

let agent: any, conversationId: string, zid: number, pid: number, tid: number;
beforeAll(async () => {
  const fixture = await setupAuthAndConvo({
    createConvo: true,
    commentCount: 2,
  });
  conversationId = fixture.conversationId;
  tid = fixture.commentIds[0];
  agent = (await getJwtAuthenticatedAgent(fixture.testUser)).agent;
  zid = (
    await pool.query("SELECT zid FROM zinvites WHERE zinvite=$1", [
      conversationId,
    ])
  ).rows[0].zid;
  pid = (
    await pool.query("SELECT pid FROM participants WHERE zid=$1 ORDER BY pid", [
      zid,
    ])
  ).rows[0].pid;
});

test("participant reads count history including revotes without maintaining the cached count", async () => {
  const start = Number(
    (
      await pool.query("SELECT count(*) FROM votes WHERE zid=$1 AND pid=$2", [
        zid,
        pid,
      ])
    ).rows[0].count
  );
  await pool.query(
    "UPDATE participants SET vote_count=97 WHERE zid=$1 AND pid=$2",
    [zid, pid]
  );
  for (const semantic of ["agree", "disagree", "pass"] as const) {
    const response = await agent.post("/api/v3/votes").send({
      conversation_id: conversationId,
      tid,
      vote: semanticToWire(semantic),
    });
    expect(response.status).toBe(200);
  }
  const response = await agent
    .get("/api/v3/participants")
    .query({ conversation_id: conversationId });
  expect(response.status).toBe(200);
  const stored = (
    await pool.query("SELECT * FROM participants WHERE zid=$1 AND pid=$2", [
      zid,
      pid,
    ])
  ).rows[0];
  expect(stored.vote_count).toBe(97);
  // The same object field order/types, with only the obsolete cache replaced.
  // Notification timestamps can advance independently; pin their observed bytes.
  stored.last_interaction = response.body.last_interaction;
  stored.nsli = response.body.nsli;
  stored.vote_count = start + 3;
  expect(response.text).toBe(JSON.stringify(stored));
  const absent = (
    await pool.query(
      `SELECT ${participantVoteCountSql(
        "p"
      )} AS vote_count FROM (VALUES ($1::int, 2147483647, NULL::int)) p(zid,pid,vote_count)`,
      [zid]
    )
  ).rows[0];
  expect(absent.vote_count).toBeNull();
});

test("activity includes votes, comment edits and the retained metadata clock with bigint output", async () => {
  const read = async () =>
    (
      await pool.query(
        `SELECT ${conversationModifiedSql(
          "c"
        )} AS modified FROM conversations c WHERE zid=$1`,
        [zid]
      )
    ).rows[0].modified;
  const voteTime = (
    await pool.query("SELECT max(created) AS t FROM votes WHERE zid=$1", [zid])
  ).rows[0].t;
  await pool.query("UPDATE conversations SET modified=1 WHERE zid=$1", [zid]);
  await pool.query("UPDATE comments SET created=1,modified=2 WHERE zid=$1", [
    zid,
  ]);
  expect(await read()).toBe(voteTime);
  const edited = Number(voteTime) + 100;
  await pool.query("UPDATE comments SET modified=$2 WHERE zid=$1 AND tid=$3", [
    zid,
    edited,
    tid,
  ]);
  expect(await read()).toBe(String(edited));
  await pool.query("UPDATE conversations SET modified=$2 WHERE zid=$1", [
    zid,
    edited + 100,
  ]);
  expect(await read()).toBe(String(edited + 100));
  await pool.query("UPDATE conversations SET modified=NULL WHERE zid=$1", [
    zid,
  ]);
  expect(await read()).toBeNull();
});

test("notification admission is bounded and cannot occupy participation connections", async () => {
  const work = Array.from({ length: NOTIFICATION_PENDING_MAX + 1 }, () =>
    pg.queryP_notification("SELECT pg_sleep(2)")
  );
  const settled = Promise.allSettled(work);
  const started = performance.now();
  const answer: any = await new Promise((resolve, reject) =>
    onParticipationPools(null, null, () => {
      pg.queryP("SELECT 42::int AS n").then(resolve, reject);
    })
  );
  expect(answer[0].n).toBe(42);
  expect(performance.now() - started).toBeLessThan(5000);
  const results = await settled;
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(
    results.some(
      (r) =>
        r.status === "rejected" &&
        r.reason.message === "notification_queue_full"
    )
  ).toBe(true);
  expect(performance.now() - started).toBeLessThan(5000);
  expect((await pg.queryP_notification("SELECT 43::int AS n"))[0].n).toBe(43);
});

test("an idle notification connection loss is handled and replaced", async () => {
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const lost = (
      await pg.queryP_notification("SELECT pg_backend_pid() AS pid")
    )[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)", [lost]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      (await pg.queryP_notification("SELECT pg_backend_pid() AS pid"))[0].pid
    ).not.toBe(lost);
  } finally {
    await admin.end();
  }
});
