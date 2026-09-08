/**
 * Regression test for the two routes that built invalid SQL from an empty
 * update set.
 *
 * PUT /api/v3/users takes `email` and `hname` as want() parameters, so a
 * request may carry neither. handle_PUT_users passed the resulting empty
 * object to sql_users.update(), which rendered "UPDATE users SET  WHERE
 * uid = …" and Postgres answered 42601 (syntax error at or near "WHERE").
 * PUT /api/v3/participants_extended had the identical defect on its single
 * want() column.
 *
 * Both now refuse the request with a 400 before any SQL is built, and neither
 * sends malformed SQL to the database.
 */
import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
  type TestUser,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

describe("empty update requests", () => {
  let ownerAgent: any;
  let conversationId: string;
  let convoAgent: any;

  beforeAll(async () => {
    const pooled = getPooledTestUser(3);
    const user: TestUser = {
      email: pooled.email,
      hname: pooled.name,
      password: pooled.password,
    } as TestUser;
    const { agent } = await getJwtAuthenticatedAgent(user);
    ownerAgent = agent;

    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    const jwtAgent = await getJwtAuthenticatedAgent(setup.testUser);
    convoAgent = jwtAgent.agent;
  });

  describe("PUT /api/v3/users", () => {
    test("a body with nothing to update is a 400, not invalid SQL", async () => {
      const response = await ownerAgent.put("/api/v3/users").send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_param_missing_user_fields"
      );
      // A 42601 would have arrived as the generic put-user 500.
      expect(response.body).not.toHaveProperty("error", "polis_err_put_user");
    });

    test("a body naming a field still updates and returns 200", async () => {
      const pooled = getPooledTestUser(3);
      const response = await ownerAgent
        .put("/api/v3/users")
        .send({ hname: pooled.name });

      expect(response.status).toBe(200);
    });
  });

  describe("PUT /api/v3/participants_extended", () => {
    test("a body with nothing to update is a 400, not invalid SQL", async () => {
      const response = await convoAgent
        .put("/api/v3/participants_extended")
        .send({ conversation_id: conversationId });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty(
        "error",
        "polis_err_param_missing_show_translation_activated"
      );
      expect(response.body).not.toHaveProperty(
        "error",
        "polis_err_put_participants_extended"
      );
    });

    test("a body naming the field is still accepted", async () => {
      const response = await convoAgent
        .put("/api/v3/participants_extended")
        .send({
          conversation_id: conversationId,
          show_translation_activated: true,
        });

      expect(response.status).toBe(200);
    });
  });
});
