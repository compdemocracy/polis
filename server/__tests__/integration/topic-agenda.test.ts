import {
  getJwtAuthenticatedAgent,
  setupAuthAndConvo,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  type TestUser,
} from "../setup/api-test-helpers";
import {
  ensureJobQueueTableExists,
  createCompletedDelphiJob,
  cleanupDelphiJobs,
} from "../setup/dynamodb-test-helpers";

describe("Topic Agenda API", () => {
  let testUser: TestUser;
  let conversationId: string;
  let authenticatedAgent: any;
  let _delphiJobId: string;

  beforeAll(async () => {
    // Ensure DynamoDB table exists
    await ensureJobQueueTableExists();

    // Set up test user and conversation
    const { testUser: user, conversationId: convId } = await setupAuthAndConvo({
      createConvo: true,
      commentCount: 2,
    });
    testUser = user;
    conversationId = convId;

    // Create a completed Delphi job for this conversation
    _delphiJobId = await createCompletedDelphiJob(conversationId);

    // Get authenticated agent
    const { agent } = await getJwtAuthenticatedAgent(testUser);
    authenticatedAgent = agent;
  });

  afterAll(async () => {
    // Clean up DynamoDB test data
    if (conversationId) {
      await cleanupDelphiJobs(conversationId);
    }
  });

  describe("POST /api/v3/topicAgenda/selections", () => {
    it("should create topic agenda selections for authenticated user", async () => {
      const selections = [
        { topic_id: "topic1", priority: 1 },
        { topic_id: "topic2", priority: 2 },
        { topic_id: "topic3", priority: 3 },
      ];

      const response = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe(
        "Topic agenda selections saved successfully"
      );
      expect(response.body.data).toMatchObject({
        conversation_id: expect.any(String),
        participant_id: expect.any(String),
        selections_count: 3,
      });
      // job_id is optional in test environments when DynamoDB might not be fully configured
      expect(response.body.data).toHaveProperty("job_id");
    });

    it("should require selections parameter", async () => {
      const response = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
        });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/selections are required/);
    });

    it("should require conversation_id parameter", async () => {
      const selections = [{ topic_id: "topic1", priority: 1 }];

      const response = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          selections,
        });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
    });

    it("should handle empty selections array", async () => {
      const response = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: [],
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.data.selections_count).toBe(0);
    });

    it("should update existing selections when called again", async () => {
      const initialSelections = [{ topic_id: "topic1", priority: 1 }];

      // First call - create selections
      const firstResponse = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: initialSelections,
        });

      expect(firstResponse.status).toBe(200);

      const updatedSelections = [
        { topic_id: "topic2", priority: 1 },
        { topic_id: "topic3", priority: 2 },
      ];

      // Second call - update selections
      const secondResponse = await authenticatedAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: updatedSelections,
        });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.data.selections_count).toBe(2);
    });
  });

  describe("GET /api/v3/topicAgenda/selections", () => {
    it("should retrieve topic agenda selections for authenticated user", async () => {
      // First create some selections
      const selections = [
        { topic_id: "topic1", priority: 1 },
        { topic_id: "topic2", priority: 2 },
      ];

      await authenticatedAgent.post("/api/v3/topicAgenda/selections").send({
        conversation_id: conversationId,
        selections,
      });

      // Then retrieve them
      const response = await authenticatedAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.data).toMatchObject({
        conversation_id: expect.any(String),
        participant_id: expect.any(String),
        archetypal_selections: selections,
        total_selections: 2,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it("should return null data when no selections exist", async () => {
      // Create a new conversation to ensure no existing data
      const { conversationId: newConversationId } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 1,
      });

      // Create a Delphi job for this conversation
      const _jobId = await createCompletedDelphiJob(newConversationId);

      const response = await authenticatedAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${newConversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe("No selections found");
      expect(response.body.data).toBeNull();

      // Clean up
      await cleanupDelphiJobs(newConversationId);
    });

    it("should return null data for unauthenticated user", async () => {
      const unauthenticatedAgent = await newAgent();

      const response = await unauthenticatedAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe("No selections found");
      expect(response.body.data).toBeNull();
    });

    it("should require conversation_id parameter", async () => {
      const response = await authenticatedAgent.get(
        "/api/v3/topicAgenda/selections"
      );

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
    });
  });

  describe("PUT /api/v3/topicAgenda/selections", () => {
    it("should update existing topic agenda selections", async () => {
      // First create some selections
      const initialSelections = [{ topic_id: "topic1", priority: 1 }];

      await authenticatedAgent.post("/api/v3/topicAgenda/selections").send({
        conversation_id: conversationId,
        selections: initialSelections,
      });

      // Then update them
      const updatedSelections = [
        { topic_id: "topic2", priority: 1 },
        { topic_id: "topic3", priority: 2 },
      ];

      const response = await authenticatedAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: updatedSelections,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe(
        "Topic agenda selections updated successfully"
      );
      expect(response.body.data).toMatchObject({
        conversation_id: expect.any(String),
        participant_id: expect.any(String),
        selections_count: 2,
      });
      expect(response.body.data).toHaveProperty("job_id");
    });

    it("should create selections if they don't exist", async () => {
      // Create a new conversation to ensure no existing data
      const { conversationId: newConversationId } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 1,
      });

      // Create a Delphi job for this conversation
      const _jobId = await createCompletedDelphiJob(newConversationId);

      const selections = [
        { topic_id: "topic1", priority: 1 },
        { topic_id: "topic2", priority: 2 },
      ];

      const response = await authenticatedAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: newConversationId,
          selections,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe(
        "Topic agenda selections created successfully"
      );
      expect(response.body.data.selections_count).toBe(2);

      // Clean up
      await cleanupDelphiJobs(newConversationId);
    });

    it("should require selections parameter", async () => {
      const response = await authenticatedAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
        });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/selections are required/);
    });

    it("should require conversation_id parameter", async () => {
      const selections = [{ topic_id: "topic1", priority: 1 }];

      const response = await authenticatedAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          selections,
        });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
    });

    it("should require authentication", async () => {
      const unauthenticatedAgent = await newAgent();

      const response = await unauthenticatedAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: [{ topic_id: "topic1", priority: 1 }],
        });

      expect(response.status).toBe(401);
      expect(response.text).toMatch(/No authentication token found/);
    });
  });

  describe("DELETE /api/v3/topicAgenda/selections", () => {
    it("should delete topic agenda selections for authenticated user", async () => {
      // First create some selections
      const selections = [{ topic_id: "topic1", priority: 1 }];

      await authenticatedAgent.post("/api/v3/topicAgenda/selections").send({
        conversation_id: conversationId,
        selections,
      });

      // Then delete them
      const response = await authenticatedAgent.delete(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe(
        "Topic agenda selections deleted successfully"
      );

      // Verify they're actually deleted
      const getResponse = await authenticatedAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(getResponse.body.data).toBeNull();
    });

    it("should handle deletion when no selections exist", async () => {
      // Create a new conversation to ensure no existing data
      const { conversationId: newConversationId } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 1,
      });

      // Create a Delphi job for this conversation
      const _jobId = await createCompletedDelphiJob(newConversationId);

      const response = await authenticatedAgent.delete(
        `/api/v3/topicAgenda/selections?conversation_id=${newConversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.message).toBe("No selections to delete");

      // Clean up
      await cleanupDelphiJobs(newConversationId);
    });

    it("should require conversation_id parameter", async () => {
      const response = await authenticatedAgent.delete(
        "/api/v3/topicAgenda/selections"
      );

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
    });

    it("should require authentication", async () => {
      const unauthenticatedAgent = await newAgent();

      const response = await unauthenticatedAgent.delete(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(401);
      expect(response.text).toMatch(/No authentication token found/);
    });
  });

  describe("Anonymous participant scenarios", () => {
    it("should allow anonymous participants to create selections", async () => {
      const { agent: anonymousAgent } = await initializeParticipant(
        conversationId
      );

      const selections = [{ topic_id: "topic1", priority: 1 }];

      const response = await anonymousAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.data.selections_count).toBe(1);
    });

    it("should allow anonymous participants to retrieve their selections", async () => {
      const { agent: anonymousAgent } = await initializeParticipant(
        conversationId
      );

      // First create selections
      const selections = [{ topic_id: "topic1", priority: 1 }];

      const createResponse = await anonymousAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      // Capture JWT token from response and set it on the agent
      if (createResponse.body.auth?.token) {
        anonymousAgent.set(
          "Authorization",
          `Bearer ${createResponse.body.auth.token}`
        );
      }

      // Then retrieve them
      const response = await anonymousAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data?.archetypal_selections).toEqual(selections);
    });

    it("should allow anonymous participants to update their selections", async () => {
      const { agent: anonymousAgent } = await initializeParticipant(
        conversationId
      );

      // First create selections
      const initialSelections = [{ topic_id: "topic1", priority: 1 }];

      const createResponse = await anonymousAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: initialSelections,
        });

      // Capture JWT token from response and set it on the agent
      if (createResponse.body.auth?.token) {
        anonymousAgent.set(
          "Authorization",
          `Bearer ${createResponse.body.auth.token}`
        );
      }

      // Then update them
      const updatedSelections = [{ topic_id: "topic2", priority: 1 }];

      const response = await anonymousAgent
        .put("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: updatedSelections,
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe(
        "Topic agenda selections updated successfully"
      );
    });

    it("should allow anonymous participants to delete their selections", async () => {
      const { agent: anonymousAgent } = await initializeParticipant(
        conversationId
      );

      // First create selections
      const selections = [{ topic_id: "topic1", priority: 1 }];

      const createResponse = await anonymousAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      // Capture JWT token from response and set it on the agent
      if (createResponse.body.auth?.token) {
        anonymousAgent.set(
          "Authorization",
          `Bearer ${createResponse.body.auth.token}`
        );
      }

      // Then delete them
      const response = await anonymousAgent.delete(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.message).toBe(
        "Topic agenda selections deleted successfully"
      );
    });
  });

  describe("XID participant scenarios", () => {
    it("should allow XID participants to create selections", async () => {
      const { agent: xidAgent } = await initializeParticipantWithXid(
        conversationId
      );

      const selections = [{ topic_id: "topic1", priority: 1 }];

      const response = await xidAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.data.selections_count).toBe(1);
    });

    it("should allow XID participants to retrieve their selections", async () => {
      const { agent: xidAgent } = await initializeParticipantWithXid(
        conversationId
      );

      // First create selections
      const selections = [{ topic_id: "topic1", priority: 1 }];

      const createResponse = await xidAgent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections,
        });

      // Capture JWT token from response and set it on the agent
      if (createResponse.body.auth?.token) {
        xidAgent.set(
          "Authorization",
          `Bearer ${createResponse.body.auth.token}`
        );
      }

      // Then retrieve them
      const response = await xidAgent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data?.archetypal_selections).toEqual(selections);
    });
  });

  describe("Data isolation", () => {
    it("should isolate selections between different participants", async () => {
      // Create two different participants
      const { agent: participant1Agent } = await initializeParticipant(
        conversationId
      );
      const { agent: participant2Agent } = await initializeParticipant(
        conversationId
      );

      // Participant 1 creates selections
      const selections1 = [{ topic_id: "topic1", priority: 1 }];

      const createResponse1 = await participant1Agent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: selections1,
        });

      // Capture JWT token for participant 1
      if (createResponse1.body.auth?.token) {
        participant1Agent.set(
          "Authorization",
          `Bearer ${createResponse1.body.auth.token}`
        );
      }

      // Participant 2 creates different selections
      const selections2 = [{ topic_id: "topic2", priority: 1 }];

      const createResponse2 = await participant2Agent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: selections2,
        });

      // Capture JWT token for participant 2
      if (createResponse2.body.auth?.token) {
        participant2Agent.set(
          "Authorization",
          `Bearer ${createResponse2.body.auth.token}`
        );
      }

      // Verify each participant sees their own selections
      const response1 = await participant1Agent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      const response2 = await participant2Agent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      expect(response1.body.data?.archetypal_selections).toEqual(selections1);
      expect(response2.body.data?.archetypal_selections).toEqual(selections2);
      expect(response1.body.data?.participant_id).not.toBe(
        response2.body.data?.participant_id
      );
    });

    it("should isolate selections between different conversations", async () => {
      // Create a second conversation
      const { conversationId: conversation2Id } = await setupAuthAndConvo({
        createConvo: true,
        commentCount: 1,
      });

      // Create a Delphi job for the second conversation
      const _jobId2 = await createCompletedDelphiJob(conversation2Id);

      // Create participants for each conversation
      const { agent: participant1Agent } = await initializeParticipant(
        conversationId
      );
      const { agent: participant2Agent } = await initializeParticipant(
        conversation2Id
      );

      // Create selections in first conversation
      const selections1 = [{ topic_id: "topic1", priority: 1 }];

      const createResponse1 = await participant1Agent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversationId,
          selections: selections1,
        });

      // Capture JWT token from first conversation
      if (createResponse1.body.auth?.token) {
        participant1Agent.set(
          "Authorization",
          `Bearer ${createResponse1.body.auth.token}`
        );
      }

      // Create selections in second conversation
      const selections2 = [{ topic_id: "topic2", priority: 1 }];

      const createResponse2 = await participant2Agent
        .post("/api/v3/topicAgenda/selections")
        .send({
          conversation_id: conversation2Id,
          selections: selections2,
        });

      // Capture JWT token from second conversation
      if (createResponse2.body.auth?.token) {
        participant2Agent.set(
          "Authorization",
          `Bearer ${createResponse2.body.auth.token}`
        );
      }

      // Verify each conversation has its own selections
      const response1 = await participant1Agent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversationId}`
      );

      const response2 = await participant2Agent.get(
        `/api/v3/topicAgenda/selections?conversation_id=${conversation2Id}`
      );

      expect(response1.body.data?.archetypal_selections).toEqual(selections1);
      expect(response2.body.data?.archetypal_selections).toEqual(selections2);

      // Clean up
      await cleanupDelphiJobs(conversation2Id);
    });
  });
});
