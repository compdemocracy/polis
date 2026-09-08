import { randomUUID } from "crypto";
import { Response } from "express";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
} from "../setup/api-test-helpers";
import {
  docClient,
  ensureJobQueueTableExists,
} from "../setup/dynamodb-test-helpers";
import pgQuery from "../../src/db/pg-query";
import { RequestWithP } from "../../src/d";
import {
  handle_POST_topicAgenda_selections,
  handle_PUT_topicAgenda_selections,
} from "../../src/routes/delphi/topicAgenda";

// These tests use real DynamoDB Local queries and PostgreSQL writes. Fixtures
// must use the internal zid, not the public conversation invite returned by API helpers.
describe.each(["post", "put"] as const)(
  "Topic agenda %s job attribution",
  (method) => {
    let agent: any;
    let conversationId: string;
    let zid: string;
    let jobIds: string[];
    const selections = [{ topic_id: "synthetic-topic", priority: 1 }];

    beforeAll(async () => {
      await ensureJobQueueTableExists();
    });

    beforeEach(async () => {
      jobIds = [];
      const setup = await setupAuthAndConvo({ createConvo: true });
      conversationId = setup.conversationId;
      ({ agent } = await getJwtAuthenticatedAgent(setup.testUser));
      const rows = (await pgQuery.queryP(
        "SELECT zid FROM zinvites WHERE zinvite = $1",
        [conversationId]
      )) as { zid: number }[];
      zid = rows[0].zid.toString();
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      for (const jobId of jobIds) {
        await docClient.send(
          new DeleteCommand({
            TableName: "Delphi_JobQueue",
            Key: { job_id: jobId },
          })
        );
      }
    });

    async function createJob(status: string, order: number, padding = "") {
      const jobId = `test-topic-agenda-${randomUUID()}`;
      jobIds.push(jobId);
      await docClient.send(
        new PutCommand({
          TableName: "Delphi_JobQueue",
          Item: {
            job_id: jobId,
            conversation_id: zid,
            status,
            created_at: new Date(
              Date.UTC(2025, 0, 1, 0, 0, order)
            ).toISOString(),
            padding,
          },
        })
      );
      return jobId;
    }

    function save(nextSelections = selections) {
      return agent[method]("/api/v3/topicAgenda/selections").send({
        conversation_id: conversationId,
        selections: nextSelections,
      });
    }

    async function expectStoredJob(jobId: string | null) {
      const response = await agent
        .get("/api/v3/topicAgenda/selections")
        .query({ conversation_id: conversationId });
      expect(response.status).toBe(200);
      expect(response.body.data.delphi_job_id).toBe(jobId);
      expect(response.body.data.archetypal_selections).toEqual(selections);
    }

    it("returns and stores the newest completed job", async () => {
      await createJob("COMPLETED", 1);
      const newest = await createJob("COMPLETED", 2);
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(newest);
      await expectStoredJob(newest);
    });

    it("returns the older completed job without erasing it when a newer job is pending", async () => {
      const completed = await createJob("COMPLETED", 1);
      expect((await save()).body.data.job_id).toBe(completed);
      await createJob("PENDING", 2);
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(completed);
      await expectStoredJob(completed);
    });

    it("continues through an empty filtered page to the newest completed job", async () => {
      await createJob("COMPLETED", 0);
      const completed = await createJob("COMPLETED", 1);
      for (let i = 2; i < 29; i++) {
        await createJob(i % 2 ? "PENDING" : "PROCESSING", i);
      }
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(completed);
      await expectStoredJob(completed);
    });

    it("continues beyond DynamoDB's 1 MB page boundary", async () => {
      const completed = await createJob("COMPLETED", 1);
      for (let i = 2; i < 6; i++) {
        await createJob("PENDING", i, "x".repeat(350_000));
      }
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(completed);
      await expectStoredJob(completed);
    });

    it("returns and stores null for new selections when no job exists", async () => {
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBeNull();
      await expectStoredJob(null);
    });

    it("returns null when all jobs are failed", async () => {
      await createJob("FAILED", 1);
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBeNull();
      await expectStoredJob(null);
    });

    it("preserves existing attribution when only a pending job remains", async () => {
      const completed = await createJob("COMPLETED", 1);
      expect((await save()).body.data.job_id).toBe(completed);
      await docClient.send(
        new DeleteCommand({
          TableName: "Delphi_JobQueue",
          Key: { job_id: completed },
        })
      );
      await createJob("PENDING", 2);
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(completed);
      await expectStoredJob(completed);
    });

    it("preserves existing attribution when the index returns no jobs", async () => {
      const completed = await createJob("COMPLETED", 1);
      expect((await save()).body.data.job_id).toBe(completed);
      await docClient.send(
        new DeleteCommand({
          TableName: "Delphi_JobQueue",
          Key: { job_id: completed },
        })
      );
      const response = await save();
      expect(response.status).toBe(200);
      expect(response.body.data.job_id).toBe(completed);
      await expectStoredJob(completed);
    });

    it("fails without changing selections or attribution if a later query page fails", async () => {
      const completed = await createJob("COMPLETED", 1);
      const initial = await save();
      expect(initial.body.data.job_id).toBe(completed);
      for (let i = 2; i < 29; i++) {
        await createJob("PENDING", i);
      }
      // Only inject the failure; the first page still comes from DynamoDB Local.
      const originalSend = DynamoDBDocumentClient.prototype.send;
      let queryCount = 0;
      jest
        .spyOn(DynamoDBDocumentClient.prototype, "send")
        .mockImplementation(function (
          this: DynamoDBDocumentClient,
          command: any
        ): any {
          if (command instanceof QueryCommand && ++queryCount === 2) {
            return Promise.reject(new Error("Synthetic DynamoDB page failure"));
          }
          return originalSend.call(this, command);
        });
      // Invoke the handler in this Jest module context so the failure spy is
      // applied; API helpers otherwise use the separate global-setup server.
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const handler =
        method === "post"
          ? handle_POST_topicAgenda_selections
          : handle_PUT_topicAgenda_selections;
      await handler(
        {
          p: {
            zid: Number(zid),
            pid: Number(initial.body.data.participant_id),
          },
          body: { selections: [{ topic_id: "changed-topic", priority: 2 }] },
        } as RequestWithP,
        response as unknown as Response
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(queryCount).toBe(2);
      await expectStoredJob(completed);
    });
  }
);
