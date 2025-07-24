import { describe, test, expect, beforeEach } from "@jest/globals";
import { newAgent, setupAuthAndConvo } from "../setup/api-test-helpers";
import { createAnonUser } from "../../src/auth/create-user";
import { joinConversation } from "../../src/participant";
import pg from "../../src/db/pg-query";
import { v4 as uuidv4 } from "uuid";

// Helper to add permanent cookie to database
async function addPermanentCookie(zid: number, uid: number): Promise<string> {
  const permanentCookie = uuidv4().replace(/-/g, ""); // Generate a unique cookie

  await new Promise((resolve, reject) => {
    pg.query(
      "UPDATE participants_extended SET permanent_cookie = $1 WHERE zid = $2 AND uid = $3",
      [permanentCookie, zid, uid],
      (err: any) => {
        if (err) reject(err);
        else resolve(true);
      }
    );
  });

  return permanentCookie;
}

describe("Legacy Cookie Authentication", () => {
  let conversationId: string;
  let zid: number;
  let commentId: number;

  beforeEach(async () => {
    // Create conversation with 1 comment by default
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0]; // Use the pre-created comment

    // Get zid from the conversation
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

  test("should recognize existing participant with legacy cookie on votes", async () => {
    // Create an existing participant (in addition to the owner)
    const uid = await createAnonUser();
    const { pid } = await joinConversation(zid, uid);

    // Add a permanent cookie for this participant
    const permanentCookie = await addPermanentCookie(zid, uid);

    // Create a new agent with the permanent cookie
    const cookieAgent = await newAgent();

    // Vote with the permanent cookie (no JWT)
    const voteResponse = await cookieAgent
      .post("/api/v3/votes")
      .set("Cookie", `pc=${permanentCookie}`)
      .send({
        conversation_id: conversationId,
        tid: commentId, // Use the pre-created comment
        vote: 1,
      });

    expect(voteResponse.status).toBe(200);
    expect(voteResponse.body.currentPid).toBe(pid);
    expect(voteResponse.body.auth).toBeDefined();
    expect(voteResponse.body.auth.token).toBeDefined();
    expect(voteResponse.body.auth.token_type).toBe("Bearer");

    // Verify the participant wasn't created new
    // Should have 2 participants: owner + our created participant
    const participantCount = await new Promise<number>((resolve, reject) => {
      pg.query(
        "SELECT COUNT(*) as count FROM participants WHERE zid = $1",
        [zid],
        (err: any, results: { rows: { count: string }[] }) => {
          if (err) reject(err);
          else resolve(parseInt(results.rows[0].count));
        }
      );
    });

    expect(participantCount).toBe(2); // Owner + our created participant
  });

  test("should recognize existing participant with legacy cookie on comments", async () => {
    // Create an existing participant
    const uid = await createAnonUser();
    const { pid } = await joinConversation(zid, uid);

    // Add a permanent cookie for this participant
    const permanentCookie = await addPermanentCookie(zid, uid);

    // Create a new agent with the permanent cookie
    const cookieAgent = await newAgent();

    // Post a comment with the permanent cookie (no JWT)
    const commentResponse = await cookieAgent
      .post("/api/v3/comments")
      .set("Cookie", `pc=${permanentCookie}`)
      .send({
        conversation_id: conversationId,
        txt: "Comment from legacy cookie user",
      });

    expect(commentResponse.status).toBe(200);
    expect(commentResponse.body.currentPid).toBe(pid);
    expect(commentResponse.body.auth).toBeDefined();
    expect(commentResponse.body.auth.token).toBeDefined();
    expect(commentResponse.body.auth.token_type).toBe("Bearer");
  });

  test("should recognize existing participant with legacy cookie on participationInit", async () => {
    // Create an existing participant
    const uid = await createAnonUser();
    const { pid } = await joinConversation(zid, uid);

    // Add a permanent cookie for this participant
    const permanentCookie = await addPermanentCookie(zid, uid);

    // Create a new agent with the permanent cookie
    const cookieAgent = await newAgent();

    // Call participationInit with the permanent cookie (no JWT)
    const initResponse = await cookieAgent
      .get(`/api/v3/participationInit?conversation_id=${conversationId}`)
      .set("Cookie", `pc=${permanentCookie}`);

    expect(initResponse.status).toBe(200);
    expect(initResponse.body.auth).toBeDefined();
    expect(initResponse.body.auth.token).toBeDefined();
    expect(initResponse.body.auth.token_type).toBe("Bearer");
    expect(initResponse.body.user).toBeDefined();
    // The pid might be in ptpt field for participationInit
    const responsePid =
      initResponse.body.user.pid || initResponse.body.ptpt?.pid;
    expect(responsePid).toBe(pid);
  });

  test("should create new participant if legacy cookie not found", async () => {
    // Create an agent with a non-existent permanent cookie
    const cookieAgent = await newAgent();
    const fakeCookie = uuidv4().replace(/-/g, "");

    // Vote with the fake permanent cookie
    const voteResponse = await cookieAgent
      .post("/api/v3/votes")
      .set("Cookie", `pc=${fakeCookie}`)
      .send({
        conversation_id: conversationId,
        tid: commentId, // Use the pre-created comment
        vote: 1,
      });

    expect(voteResponse.status).toBe(200);
    expect(voteResponse.body.currentPid).toBeDefined();
    expect(voteResponse.body.auth).toBeDefined();
    expect(voteResponse.body.auth.token).toBeDefined();

    // Verify a new participant was created
    // Should have 2 participants: owner + newly created participant
    const participantCount = await new Promise<number>((resolve, reject) => {
      pg.query(
        "SELECT COUNT(*) as count FROM participants WHERE zid = $1",
        [zid],
        (err: any, results: { rows: { count: string }[] }) => {
          if (err) reject(err);
          else resolve(parseInt(results.rows[0].count));
        }
      );
    });

    expect(participantCount).toBe(2); // Owner + newly created participant
  });

  test("should handle XID participant with legacy cookie", async () => {
    const xid = "test-xid-" + Date.now();

    // Create an existing XID participant
    const uid = await createAnonUser();
    const { pid } = await joinConversation(zid, uid);

    // Create XID record
    await new Promise((resolve, reject) => {
      pg.query(
        "INSERT INTO xids (uid, xid, owner, created) VALUES ($1, $2, (SELECT org_id FROM conversations WHERE zid = $3), default)",
        [uid, xid, zid],
        (err: any) => {
          if (err) reject(err);
          else resolve(true);
        }
      );
    });

    // Add a permanent cookie for this participant
    const permanentCookie = await addPermanentCookie(zid, uid);

    // Create a new agent with the permanent cookie
    const cookieAgent = await newAgent();

    // Vote with the permanent cookie and XID
    const voteResponse = await cookieAgent
      .post("/api/v3/votes")
      .set("Cookie", `pc=${permanentCookie}`)
      .send({
        conversation_id: conversationId,
        tid: commentId, // Use the pre-created comment
        vote: 1,
        xid: xid,
      });

    expect(voteResponse.status).toBe(200);
    expect(voteResponse.body.currentPid).toBe(pid);
    expect(voteResponse.body.auth).toBeDefined();
    expect(voteResponse.body.auth.token).toBeDefined();

    // Decode the JWT to verify it's an XID token
    const tokenParts = voteResponse.body.auth.token.split(".");
    const payload = JSON.parse(Buffer.from(tokenParts[1], "base64").toString());
    expect(payload.xid).toBe(xid);
    expect(payload.xid_participant).toBe(true);
  });
});
