/**
 * Test for race condition in concurrent participant creation for the same (zid, uid).
 *
 * Real-world scenarios where this happens:
 * 1. Double-click: user clicks vote/comment twice quickly, both requests carry
 *    the same cookie/JWT and hit ensureParticipant concurrently
 * 2. Page load + immediate action: participationInit GET and a vote POST fire
 *    nearly simultaneously for the same anonymous user
 * 3. Legacy cookie migration: request with permanent cookie triggers participant
 *    lookup while another concurrent request also tries to ensure the participant
 * 4. Network retry: client retries a request while the original is still in-flight
 *
 * Root cause: addParticipant() in participant.ts uses pg.query() (pool-level)
 * for BEGIN/INSERT/COMMIT, but each call may grab a different connection from
 * the pool, breaking transaction isolation under concurrent load.
 */
import { describe, expect, test, beforeAll } from "@jest/globals";
import { setupAuthAndConvo, newAgent } from "../setup/api-test-helpers";
import { createAnonUser } from "../../src/auth/create-user";
import pg from "../../src/db/pg-query";
import { v4 as uuidv4 } from "uuid";

const NUM_CONCURRENT_REQUESTS = 10;

describe("Concurrent same-participant creation", () => {
  let conversationId: string;
  let zid: number;
  let commentId: number;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0];

    // Get zid from conversation
    zid = await new Promise<number>((resolve, reject) => {
      pg.query(
        "SELECT zid FROM zinvites WHERE zinvite = $1",
        [conversationId],
        (err: any, results: { rows: { zid: number }[] }) => {
          if (err) reject(err);
          else resolve(results.rows[0].zid);
        }
      );
    });
  });

  test("concurrent votes with same legacy cookie should not produce 500 errors", async () => {
    // Create a user and participant (via direct DB calls, like the legacy-cookie test)
    const uid = await createAnonUser();

    // Insert participant directly
    await new Promise((resolve, reject) => {
      pg.query(
        "INSERT INTO participants_extended (zid, uid) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [zid, uid],
        (err: any) => (err ? reject(err) : resolve(true))
      );
    });
    await new Promise((resolve, reject) => {
      pg.query(
        "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING *",
        [zid, uid],
        (err: any) => (err ? reject(err) : resolve(true))
      );
    });

    // Add a permanent cookie
    const permanentCookie = uuidv4().replace(/-/g, "");
    await new Promise((resolve, reject) => {
      pg.query(
        `INSERT INTO participants_extended (zid, uid, permanent_cookie)
         VALUES ($1, $2, $3)
         ON CONFLICT (zid, uid) DO UPDATE SET permanent_cookie = $3`,
        [zid, uid, permanentCookie],
        (err: any) => (err ? reject(err) : resolve(true))
      );
    });

    // Fire N concurrent requests all using the same legacy cookie.
    // Each request triggers ensureParticipant → checkLegacyCookieAndIssueJWT.
    // Under the broken-transaction bug, concurrent lookups can miss the
    // existing participant and try to re-create it.
    const agents = Array.from({ length: NUM_CONCURRENT_REQUESTS }, () =>
      newAgent()
    );
    const resolvedAgents = await Promise.all(agents);

    const promises = resolvedAgents.map((agent) =>
      agent
        .post("/api/v3/votes")
        .set("Cookie", `pc=${permanentCookie}`)
        .send({
          conversation_id: conversationId,
          tid: commentId,
          vote: 1,
        })
    );

    const results = await Promise.allSettled(promises);

    let successes = 0;
    let duplicateVotes = 0;
    let serverErrors = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        serverErrors++;
        console.error("Request rejected:", result.reason);
        continue;
      }
      const { status, text } = result.value;
      if (status === 200) {
        successes++;
      } else if (status === 406 && text?.includes("polis_err_vote_duplicate")) {
        duplicateVotes++;
      } else {
        serverErrors++;
        console.error(`Unexpected: status=${status}, body=${text}`);
      }
    }

    console.log(
      `Legacy cookie concurrent: ${successes} ok, ${duplicateVotes} dup(406), ${serverErrors} errors`
    );

    expect(serverErrors).toBe(0);
    expect(successes + duplicateVotes).toBe(NUM_CONCURRENT_REQUESTS);
  }, 30000);

  test("concurrent comment+vote from same user should not produce 500 errors", async () => {
    // Simulate: user creates a participant via one endpoint while simultaneously
    // hitting another endpoint. Both trigger ensureParticipant for the same uid.

    // Create a fresh anonymous user (no participant yet)
    const uid = await createAnonUser();

    // Add a permanent cookie so the server can identify this user
    // (without a JWT, the server uses the cookie to find the uid)
    await new Promise((resolve, reject) => {
      pg.query(
        `INSERT INTO participants_extended (zid, uid, permanent_cookie)
         VALUES ($1, $2, $3)
         ON CONFLICT (zid, uid) DO UPDATE SET permanent_cookie = $3`,
        [zid, uid, uuidv4().replace(/-/g, "")],
        (err: any) => (err ? reject(err) : resolve(true))
      );
    });

    // Get the cookie we just stored
    const cookieResult = await new Promise<string>((resolve, reject) => {
      pg.query(
        "SELECT permanent_cookie FROM participants_extended WHERE zid = $1 AND uid = $2",
        [zid, uid],
        (err: any, results: { rows: { permanent_cookie: string }[] }) => {
          if (err) reject(err);
          else resolve(results.rows[0].permanent_cookie);
        }
      );
    });

    // NOTE: No participant row exists yet! Only participants_extended.
    // All requests below will try to create the participant via ensureParticipant.
    // We fire many concurrent requests to make the race condition reliable.

    const NUM_AGENTS = 10;
    const agents = await Promise.all(
      Array.from({ length: NUM_AGENTS }, () => newAgent())
    );

    // Mix of votes and comments — all using the same cookie (same uid)
    const promises = agents.map((agent, i) => {
      if (i % 2 === 0) {
        return agent
          .post("/api/v3/votes")
          .set("Cookie", `pc=${cookieResult}`)
          .send({
            conversation_id: conversationId,
            tid: commentId,
            vote: (i % 3) - 1,
          });
      } else {
        return agent
          .post("/api/v3/comments")
          .set("Cookie", `pc=${cookieResult}`)
          .send({
            conversation_id: conversationId,
            txt: `concurrent comment ${i} ${Date.now()}`,
          });
      }
    });

    const results = await Promise.allSettled(promises);

    let successes = 0;
    let duplicates = 0;
    let serverErrors = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        serverErrors++;
        console.error("Request rejected:", result.reason);
        continue;
      }
      const { status, text } = result.value;
      if (status === 200) {
        successes++;
      } else if (status === 406) {
        duplicates++;
      } else if (status >= 500) {
        serverErrors++;
        console.error(`Server error: status=${status}, body=${text}`);
      } else {
        successes++; // other 2xx/3xx are fine
      }
    }

    console.log(
      `Concurrent creation: ${successes} ok, ${duplicates} dup, ${serverErrors} errors (of ${NUM_AGENTS})`
    );

    expect(serverErrors).toBe(0);
    expect(successes + duplicates).toBe(NUM_AGENTS);
  }, 30000);
});
