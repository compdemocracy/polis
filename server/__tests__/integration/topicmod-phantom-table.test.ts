/**
 * `server/src/routes/delphi/topicMod.ts` reads two DynamoDB tables that have
 * never existed: `Delphi_TopicModerationStatus` and `Delphi_CommentClusters`.
 * Neither is defined in `delphi/create_dynamodb_tables.py` (the bootstrap the
 * Delphi container runs on every start, and the only creator of Delphi tables
 * locally), nothing under `delphi/` writes them, and a read-only `list-tables`
 * against the deployed account shows the same eighteen tables the bootstrap
 * defines plus `report_narrative_store` — no sign of either name.
 *
 * That makes DynamoDB local an exact reproduction of production for these
 * routes: the tables are absent in both, so every read raises
 * ResourceNotFoundException on every call. These tests pin what the routes
 * answer under that condition.
 *
 * Before this branch:
 *   - GET  /topicMod/topics                    200, silently "all pending"
 *   - GET  /topicMod/topics/:key/comments      200 {status:"error"} echoing the
 *                                              raw AWS "Requested resource not
 *                                              found" string, logged at error
 *   - POST /topicMod/moderate {topic_key}      200 {status:"error"}; the Put
 *                                              fallback rethrew from the same
 *                                              missing table, so any
 *                                              `comment_ids` in the same
 *                                              request were silently dropped
 *   - GET  /topicMod/stats                     200, zeroed
 */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";

import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
  wait,
} from "../setup/api-test-helpers";
import {
  createDelphiTopicCluster,
  cleanupDelphiTopicData,
  dynamoClient,
} from "../setup/dynamodb-test-helpers";
import pg from "../../src/db/pg-query";

const PHANTOM_TABLES = [
  "Delphi_TopicModerationStatus",
  "Delphi_CommentClusters",
];

const TOPIC_KEY = "job-p034#0#3";
const LAYER_ID = 0;
const CLUSTER_ID = 3;

describe("topicMod routes against the never-provisioned DynamoDB tables", () => {
  let conversationId: string;
  let commentIds: number[];
  let zid: number;
  let ownerAgent: any;

  const modStateFor = async (tids: number[]) => {
    const response = await ownerAgent.get(
      `/api/v3/comments?conversation_id=${conversationId}&moderation=true`
    );
    expect(response.status).toBe(200);
    const byTid = new Map<number, number>();
    for (const comment of response.body as Array<{
      tid: number;
      mod: number;
    }>) {
      if (tids.includes(comment.tid)) {
        byTid.set(comment.tid, comment.mod);
      }
    }
    return byTid;
  };

  beforeAll(async () => {
    const convo = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 3,
    });
    conversationId = convo.conversationId;
    commentIds = convo.commentIds;

    const { agent } = await getJwtAuthenticatedAgent(convo.testUser);
    ownerAgent = agent;

    const zidRows = (await pg.queryP_readOnly(
      "select zid from zinvites where zinvite = ($1) limit 1;",
      [conversationId]
    )) as Array<{ zid: number }>;
    zid = zidRows?.[0]?.zid;
    expect(typeof zid).toBe("number");

    // Seed the two tables that DO exist, so the topics route has real content
    // and any failure below is attributable to the missing tables alone.
    await createDelphiTopicCluster(
      zid,
      TOPIC_KEY,
      commentIds,
      LAYER_ID,
      CLUSTER_ID
    );

    // Wait on the route actually seeing the seed rather than on a fixed delay.
    // With no topics the handler returns early on a different shape (no
    // `moderation_available`), so a slow seed would otherwise fail the tests
    // below for a reason that has nothing to do with the missing tables.
    for (let attempt = 0; attempt < 20; attempt++) {
      const seeded = await ownerAgent.get(
        `/api/v3/topicMod/topics?conversation_id=${conversationId}`
      );
      if (seeded.body?.total_topics > 0) {
        break;
      }
      await wait(250);
    }
  });

  afterAll(async () => {
    if (zid) {
      await cleanupDelphiTopicData(zid);
    }
  });

  test("the two tables the routes read are absent, as they are in production", async () => {
    // If this ever fails, someone provisioned one of them. The degradation
    // below is then no longer the right behaviour and this file must be
    // revisited alongside the route.
    for (const tableName of PHANTOM_TABLES) {
      await expect(
        dynamoClient.send(new DescribeTableCommand({ TableName: tableName }))
      ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
    }
  });

  describe("GET /api/v3/topicMod/topics", () => {
    test("still lists the topics that live in a real table", async () => {
      const response = await ownerAgent.get(
        `/api/v3/topicMod/topics?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
      expect(response.body.total_topics).toBeGreaterThan(0);

      const layer = response.body.topics_by_layer?.[String(LAYER_ID)];
      expect(Array.isArray(layer)).toBe(true);
      expect(layer.map((t: { topic_key: string }) => t.topic_key)).toContain(
        TOPIC_KEY
      );
    });

    test("says the moderation status is unavailable rather than implying every topic is pending", async () => {
      const response = await ownerAgent.get(
        `/api/v3/topicMod/topics?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("moderation_available", false);

      // The placeholder is still "pending", but a caller can now tell that
      // apart from a decision someone actually recorded.
      const topic = response.body.topics_by_layer[String(LAYER_ID)].find(
        (t: { topic_key: string }) => t.topic_key === TOPIC_KEY
      );
      expect(topic.moderation.status).toBe("pending");
    });
  });

  describe("GET /api/v3/topicMod/topics/:topicKey/comments", () => {
    test("answers 503 with a stable code instead of an empty topic or a raw AWS message", async () => {
      const response = await ownerAgent.get(
        `/api/v3/topicMod/topics/${encodeURIComponent(
          TOPIC_KEY
        )}/comments?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_topicMod_comments_store_missing"
      );

      // A 200 with `comments: []` would read as "this topic has no comments".
      expect(response.body).not.toHaveProperty("comments");
      expect(response.body.status).not.toBe("success");

      // The pre-fix response echoed the SDK's message verbatim.
      expect(JSON.stringify(response.body)).not.toMatch(
        /Requested resource not found/i
      );
    });
  });

  describe("POST /api/v3/topicMod/moderate", () => {
    test("whole-topic moderation reports 503 instead of a success it did not achieve", async () => {
      const before = await modStateFor(commentIds);

      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        topic_key: TOPIC_KEY,
        action: "reject",
      });

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_topicMod_moderate_topic_store_missing"
      );
      expect(response.body).toHaveProperty("comments_moderated", 0);

      // Nothing was recorded, so nothing may have changed.
      const after = await modStateFor(commentIds);
      for (const tid of commentIds) {
        expect(after.get(tid)).toBe(before.get(tid));
      }
    });

    test("comment_ids sent alongside a topic_key are still applied", async () => {
      // The regression this branch fixes: the topic branch ran first and threw
      // out of the handler, so these ids never reached Postgres.
      const targeted = [commentIds[0], commentIds[1]];

      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        topic_key: TOPIC_KEY,
        comment_ids: targeted,
        action: "reject",
      });

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty(
        "comments_moderated",
        targeted.length
      );

      const after = await modStateFor(commentIds);
      for (const tid of targeted) {
        expect(after.get(tid)).toBe(-1);
      }
      // The comment outside the request is untouched.
      expect(after.get(commentIds[2])).not.toBe(-1);
    });

    test("comment_ids on their own still succeed, unchanged by this branch", async () => {
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [commentIds[2]],
        action: "accept",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
      expect(response.body).toHaveProperty("comments_moderated", 1);

      const after = await modStateFor(commentIds);
      expect(after.get(commentIds[2])).toBe(1);
    });

    // `comments_moderated` must count comments this request actually moderated.
    // Postgres runs an UPDATE that matches nothing without complaint, so
    // counting the submitted ids would report a moderation that never happened.
    test("an id matching no comment in this conversation is not counted", async () => {
      const absentTid = 999999;
      const before = await modStateFor(commentIds);

      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [absentTid],
        action: "reject",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("comments_moderated", 0);
      expect(response.body.unmatched_comment_ids).toEqual([absentTid]);

      // And no real comment was touched on the way past it.
      const after = await modStateFor(commentIds);
      for (const tid of commentIds) {
        expect(after.get(tid)).toBe(before.get(tid));
      }
    });

    test("a mix of real and absent ids counts only the real one", async () => {
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [commentIds[0], 999999],
        action: "reject",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("comments_moderated", 1);
      expect(response.body.unmatched_comment_ids).toEqual([999999]);
      expect((await modStateFor(commentIds)).get(commentIds[0])).toBe(-1);
    });

    test("the same id twice counts as one moderated comment", async () => {
      const response = await ownerAgent.post("/api/v3/topicMod/moderate").send({
        conversation_id: conversationId,
        comment_ids: [commentIds[1], commentIds[1]],
        action: "meta",
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("comments_moderated", 1);
      expect(response.body.unmatched_comment_ids).toEqual([]);
      expect((await modStateFor(commentIds)).get(commentIds[1])).toBe(0);
    });
  });

  describe("GET /api/v3/topicMod/stats", () => {
    test("returns zeroed counts flagged as unavailable, not as 'nothing moderated yet'", async () => {
      const response = await ownerAgent.get(
        `/api/v3/topicMod/stats?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "success");
      expect(response.body).toHaveProperty("moderation_available", false);
      expect(response.body.stats).toMatchObject({
        total_topics: 0,
        pending: 0,
        accepted: 0,
        rejected: 0,
        meta: 0,
      });
    });
  });
});
