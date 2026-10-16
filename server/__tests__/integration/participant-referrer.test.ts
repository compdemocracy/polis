import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  newAgent,
  submitVote,
  wait,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../setup/vote-wire";

// participants_extended.referrer records the page a participant came from.
// For an embedded conversation that is the iframe's own URL, whose query
// string carries the participant's xid. Only the origin and path are stored:
// the query string and fragment are dropped where the column is written, on
// the participant's creation at their first vote.
describe("participants_extended.referrer is stored without the query string", () => {
  let ownerAgent: Agent;
  let conversationId: string;
  let zid: number;
  let commentTid: number;

  // The referrer is written after the response is sent; poll briefly.
  async function storedReferrer(uid: number): Promise<string | null> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT referrer FROM participants_extended WHERE zid = $1 AND uid = $2",
        [zid, uid]
      );
      if (rows.length > 0 && rows[0].referrer !== null) {
        return rows[0].referrer;
      }
      await wait(100);
    }
    return null;
  }

  beforeAll(async () => {
    const ownerUser = getPooledTestUser(1);
    const { agent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    });
    ownerAgent = agent;

    conversationId = await createConversation(ownerAgent, {
      topic: "Referrer storage test",
    });
    const { rows } = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    zid = rows[0].zid;

    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the referrer storage test",
      });
    expect(commentResponse.status).toBe(200);
    commentTid = commentResponse.body.tid;
  });

  test("a participant created on their first vote: the iframe URL is stored without its xid", async () => {
    const xid = generateRandomXid();
    const iframeUrl = `http://localhost/${conversationId}?xid=${xid}&parent_url=${encodeURIComponent(
      "https://example.com/survey"
    )}`;

    const agent = await newAgent();
    agent.set("Referer", iframeUrl);
    const init: Response = await agent.get(
      `/api/v3/participationInit?conversation_id=${conversationId}&xid=${xid}&pid=-1&lang=en&agid=1`
    );
    expect(init.status).toBe(200);
    if (init.body.auth?.token) {
      agent.set("Authorization", `Bearer ${init.body.auth.token}`);
    }
    const vote = await submitVote(agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(200);

    const { rows } = await pool.query("SELECT uid FROM xids WHERE xid = $1", [
      xid,
    ]);
    expect(rows.length).toBe(1);

    const referrer = await storedReferrer(rows[0].uid);
    expect(referrer).toBe(`http://localhost/${conversationId}`);
    expect(referrer).not.toContain(xid);
  });
});
