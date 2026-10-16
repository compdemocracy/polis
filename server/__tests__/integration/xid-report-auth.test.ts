import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent, Response } from "supertest";
import {
  createConversation,
  generateRandomXid,
  getJwtAuthenticatedAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  submitVote,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import { WIRE_AGREE } from "../setup/vote-wire";

// GET /api/v3/xid/<uuid>-xid.csv is a conversation's participant-to-xid map.
// The UUID in the path is minted only for the conversation's owner or a
// moderator, but a link that carries it can be copied or logged, so the
// download takes the same gate: a request without a login, with a participant
// token, or from a signed-in non-owner is refused and sees no xid, while the
// owner receives the CSV with the bytes it has always had.
describe("GET /api/v3/xid/:xid_report - owner/moderator gate", () => {
  let ownerAgent: Agent;
  let strangerAgent: Agent;
  let conversationId: string;
  let zid: number;
  let commentTid: number;
  let participantXid: string;
  let participantPid: number;
  let csvPath: string;

  beforeAll(async () => {
    const ownerUser = getPooledTestUser(1);
    const { agent: ownerJwtAgent } = await getJwtAuthenticatedAgent({
      email: ownerUser.email,
      hname: ownerUser.name,
      password: ownerUser.password,
    });
    ownerAgent = ownerJwtAgent;

    // A fully signed-in account that neither owns nor moderates the
    // conversation (a distinct user => a distinct site_id).
    const strangerUser = getPooledTestUser(3);
    const { agent: strangerJwtAgent } = await getJwtAuthenticatedAgent({
      email: strangerUser.email,
      hname: strangerUser.name,
      password: strangerUser.password,
    });
    strangerAgent = strangerJwtAgent;

    conversationId = await createConversation(ownerAgent, {
      topic: "Participant XID export auth test",
      description: "Verifies the owner/moderator gate on the XID CSV",
    });

    const commentResponse: Response = await ownerAgent
      .post("/api/v3/comments")
      .send({
        conversation_id: conversationId,
        txt: "Comment for the XID export auth test",
      });
    expect(commentResponse.status).toBe(200);
    commentTid = commentResponse.body.tid;

    // One participant with an xid, so the export has a row to leak.
    participantXid = generateRandomXid();
    const xidParticipant = await initializeParticipantWithXid(
      conversationId,
      participantXid
    );
    const vote = await submitVote(xidParticipant.agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(200);

    const pidRows = await pool.query(
      `SELECT p.pid FROM participants p
         JOIN xids x ON x.uid = p.uid
        WHERE p.zid = (SELECT zid FROM zinvites WHERE zinvite = $1)
          AND x.xid = $2`,
      [conversationId, participantXid]
    );
    expect(pidRows.rows.length).toBe(1);
    participantPid = pidRows.rows[0].pid;
    const zidRows = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    zid = zidRows.rows[0].zid;

    const uuidResponse: Response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );
    expect(uuidResponse.status).toBe(200);
    csvPath = `/api/v3/xid/${uuidResponse.body.conversation_uuid}-xid.csv`;
  });

  test("a request without a login is refused with 401 and sees no xid", async () => {
    const anonymousAgent = await newAgent();
    const response: Response = await anonymousAgent.get(csvPath);
    expect(response.status).toBe(401);
    expect(response.text).not.toContain("participant,xid");
    expect(response.text).not.toContain(participantXid);
  });

  test("a participant token is refused with 403 and sees no xid", async () => {
    const participant = await initializeParticipant(conversationId);
    const vote = await submitVote(participant.agent, {
      conversation_id: conversationId,
      tid: commentTid,
      vote: WIRE_AGREE,
    });
    expect(vote.status).toBe(200);

    const response: Response = await participant.agent.get(csvPath);
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_xid_report_auth");
    expect(response.text).not.toContain(participantXid);
  });

  test("a signed-in non-owner is refused with 403 and sees no xid", async () => {
    const response: Response = await strangerAgent.get(csvPath);
    expect(response.status).toBe(403);
    expect(response.text).toContain("polis_err_xid_report_auth");
    expect(response.text).not.toContain(participantXid);
  });

  test("the owner receives the CSV with the same bytes as before", async () => {
    const response: Response = await ownerAgent.get(csvPath);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    // The bytes the export has always produced: a header line, then one line
    // per (participant, xid) pair of the conversation in pid order, the xid
    // quoted, each line ending in "\n". The pairs are read back independently
    // of the export: the pooled owner's uid may carry xids from other suites,
    // and as participant 0 those appear here too.
    const pairs = await pool.query(
      `SELECT p.pid, x.xid FROM participants p
         JOIN xids x ON x.uid = p.uid
        WHERE p.zid = $1
          AND x.owner = (SELECT owner FROM conversations WHERE zid = $1)`,
      [zid]
    );
    const expectedLines = pairs.rows
      .map((row: { pid: number; xid: string }) => `${row.pid},"${row.xid}"`)
      .sort();
    expect(expectedLines).toContain(`${participantPid},"${participantXid}"`);

    const [header, ...rest] = response.text.split("\n");
    expect(header).toBe("participant,xid");
    expect(rest[rest.length - 1]).toBe("");
    const lines = rest.slice(0, -1);
    expect([...lines].sort()).toEqual(expectedLines);
    const pids = lines.map((line) => Number(line.split(",")[0]));
    expect(pids).toEqual([...pids].sort((a, b) => a - b));
  });

  test("the owner still gets 404 for an unknown UUID", async () => {
    const response: Response = await ownerAgent.get(
      "/api/v3/xid/00000000-0000-4000-8000-000000000000-xid.csv"
    );
    expect(response.status).toBe(404);
    expect(response.text).toContain("polis_error_data_unknown_report");
  });
});
