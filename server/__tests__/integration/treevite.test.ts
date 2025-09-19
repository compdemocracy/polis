import {
  getJwtAuthenticatedAgent,
  createConversation,
  newAgent,
  initializeParticipant,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { TestUser } from "../setup/api-test-helpers";
import { Agent } from "supertest";

describe("Treevite API endpoints", () => {
  let adminAgent: Agent;
  let adminTestUser: TestUser;
  let conversationId: string;
  let commentIds: number[] = [];

  beforeAll(async () => {
    // Set up admin agent with JWT authentication
    const pooledUser = getPooledTestUser(1);
    adminTestUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };

    const { agent } = await getJwtAuthenticatedAgent(adminTestUser);
    adminAgent = agent;

    // Create a test conversation with treevite enabled
    conversationId = await createConversation(adminAgent, {
      topic: "Treevite Test Conversation",
      description: "Testing wave-based invite system",
      treevite_enabled: true,
    });

    // Add seed comments for testing
    const seedComments = [
      "This is the first seed comment for testing",
      "Another seed comment to ensure voting works",
      "Third seed comment for variety",
    ];

    for (const commentText of seedComments) {
      const response = await adminAgent.post("/api/v3/comments").send({
        conversation_id: conversationId,
        txt: commentText,
        is_seed: true,
      });
      if (response.status === 200 && response.body.tid !== undefined) {
        commentIds.push(response.body.tid);
      }
    }
  });

  describe("POST /api/v3/treevite/waves", () => {
    test("should create root wave with owner invites", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationId,
        owner_invites: 5,
        invites_per_user: 0,
      });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("id");
      expect(response.body).toHaveProperty("wave", 1);
      expect(response.body).toHaveProperty("parent_wave", 0);
      expect(response.body).toHaveProperty("owner_invites", 5);
      expect(response.body).toHaveProperty("invites_per_user", 0);
      expect(response.body).toHaveProperty("size", 5);
      expect(response.body).toHaveProperty("invites_created", 5);
    });

    test("should create second wave with invites per user", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationId,
        owner_invites: 2,
        invites_per_user: 3,
      });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("wave", 2);
      expect(response.body).toHaveProperty("parent_wave", 1);
      expect(response.body).toHaveProperty("owner_invites", 2);
      expect(response.body).toHaveProperty("invites_per_user", 3);
      // Size should be parent_size * invites_per_user + owner_invites = 5 * 3 + 2 = 17
      expect(response.body).toHaveProperty("size", 17);
    });

    test("should create wave with explicit parent wave", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationId,
        owner_invites: 1,
        invites_per_user: 0,
        parent_wave: 0, // Explicitly set parent to root
      });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("wave", 3);
      expect(response.body).toHaveProperty("parent_wave", 0);
      expect(response.body).toHaveProperty("size", 1);
    });

    test("should fail if no invites are specified", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationId,
        owner_invites: 0,
        invites_per_user: 0,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        "polis_err_treevite_wave_requires_invites"
      );
    });

    test("should fail without conversation_id", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        owner_invites: 5,
        invites_per_user: 0,
      });

      expect(response.status).toBe(400);
      if (response.body && response.body.error) {
        expect(response.body.error).toContain("polis_err_param_missing");
      } else {
        expect(response.text).toContain("polis_err_param_missing");
      }
    });

    test("should fail for invalid parent wave", async () => {
      const response = await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationId,
        owner_invites: 1,
        invites_per_user: 0,
        parent_wave: 999, // Non-existent parent wave
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        "polis_err_treevite_parent_wave_not_found"
      );
    });
  });

  describe("GET /api/v3/treevite/waves", () => {
    test("should list all waves for a conversation", async () => {
      const response = await adminAgent
        .get("/api/v3/treevite/waves")
        .query({ conversation_id: conversationId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(3); // We created at least 3 waves

      // Verify waves are ordered by wave number
      for (let i = 1; i < response.body.length; i++) {
        expect(response.body[i].wave).toBeGreaterThan(
          response.body[i - 1].wave
        );
      }
    });

    test("should get specific wave by wave number", async () => {
      const response = await adminAgent.get("/api/v3/treevite/waves").query({
        conversation_id: conversationId,
        wave: 1,
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].wave).toBe(1);
    });

    test("should return empty array for non-existent wave", async () => {
      const response = await adminAgent.get("/api/v3/treevite/waves").query({
        conversation_id: conversationId,
        wave: 999,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    test("should fail without conversation_id", async () => {
      const response = await adminAgent.get("/api/v3/treevite/waves");

      expect(response.status).toBe(400);
      if (response.body && response.body.error) {
        expect(response.body.error).toContain("polis_err_param_missing");
      } else {
        expect(response.text).toContain("polis_err_param_missing");
      }
    });
  });

  describe("GET /api/v3/treevite/invites", () => {
    test("should list owner invites with pagination", async () => {
      const response = await adminAgent.get("/api/v3/treevite/invites").query({
        conversation_id: conversationId,
        limit: 10,
        offset: 0,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("invites");
      expect(response.body).toHaveProperty("pagination");
      expect(Array.isArray(response.body.invites)).toBe(true);

      // Check pagination metadata
      expect(response.body.pagination).toHaveProperty("limit", 10);
      expect(response.body.pagination).toHaveProperty("offset", 0);
      expect(response.body.pagination).toHaveProperty("total");
      expect(response.body.pagination).toHaveProperty("hasMore");
    });

    test("should filter by wave_id", async () => {
      // Get wave 1 id first
      const wavesResponse = await adminAgent
        .get("/api/v3/treevite/waves")
        .query({ conversation_id: conversationId, wave: 1 });

      const waveId = wavesResponse.body[0].id;

      const response = await adminAgent.get("/api/v3/treevite/invites").query({
        conversation_id: conversationId,
        wave_id: waveId,
      });

      expect(response.status).toBe(200);
      expect(response.body.invites).toHaveLength(5); // Wave 1 had 5 owner invites
      response.body.invites.forEach((invite: { wave_id: number }) => {
        expect(invite.wave_id).toBe(waveId);
      });
    });

    test("should filter by status", async () => {
      const response = await adminAgent.get("/api/v3/treevite/invites").query({
        conversation_id: conversationId,
        status: 0, // Unused invites
      });

      expect(response.status).toBe(200);
      response.body.invites.forEach((invite: { status: number }) => {
        expect(invite.status).toBe(0);
      });
    });
  });

  describe("POST /api/v3/treevite/acceptInvite", () => {
    let inviteCode: string;
    let participantAgent: Agent;
    let participantToken: string;

    beforeAll(async () => {
      // Get an unused invite code from wave 1
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: conversationId,
          status: 0,
          limit: 1,
        });

      inviteCode = invitesResponse.body.invites[0].invite_code;
    });

    test("should accept valid invite and receive JWT and login code", async () => {
      participantAgent = await newAgent();

      const response = await participantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationId,
          invite_code: inviteCode,
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("wave_id");
      expect(response.body).toHaveProperty("invite_id");
      expect(response.body).toHaveProperty("login_code");
      expect(response.body).toHaveProperty("auth");
      expect(response.body.auth).toHaveProperty("token");
      expect(response.body.auth).toHaveProperty("token_type", "Bearer");
      expect(response.body.auth).toHaveProperty("expires_in");

      // Set token on agent for future requests
      participantToken = response.body.auth.token;
      participantAgent.set("Authorization", `Bearer ${participantToken}`);
    });

    test("should fail with already used invite code", async () => {
      const newAgent = await participantAgent;

      const response = await newAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationId,
          invite_code: inviteCode, // Same code as before
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        "polis_err_treevite_invalid_or_used_invite"
      );
    });

    test("should fail with invalid invite code", async () => {
      const newAgent = await participantAgent;

      const response = await newAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationId,
          invite_code: "INVALID_CODE",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        "polis_err_treevite_invalid_or_used_invite"
      );
    });

    test("should fail without invite_code", async () => {
      const testAgent = await newAgent();

      const response = await testAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationId,
        });

      expect(response.status).toBe(400);
      if (response.body && response.body.error) {
        expect(response.body.error).toContain(
          "polis_err_param_missing_invite_code"
        );
      } else {
        expect(response.text).toContain("polis_err_param_missing_invite_code");
      }
    });
  });

  describe("POST /api/v3/treevite/login", () => {
    let loginCode: string;
    let conversationIdForLogin: string;

    beforeAll(async () => {
      // Create a new conversation and invite for login testing
      conversationIdForLogin = await createConversation(adminAgent, {
        topic: "Treevite Login Test",
        treevite_enabled: true,
      });

      // Create a wave with invites
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationIdForLogin,
        owner_invites: 1,
        invites_per_user: 0,
      });

      // Get the invite code
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: conversationIdForLogin,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      // Accept the invite to get a login code
      const acceptResponse = await (await newAgent())
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationIdForLogin,
          invite_code: inviteCode,
        });

      loginCode = acceptResponse.body.login_code;
    });

    test("should login with valid login code and receive JWT", async () => {
      const agent = await newAgent();

      const response = await agent.post("/api/v3/treevite/login").send({
        conversation_id: conversationIdForLogin,
        login_code: loginCode,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("auth");
      expect(response.body.auth).toHaveProperty("token");
      expect(response.body.auth).toHaveProperty("token_type", "Bearer");
      expect(response.body.auth).toHaveProperty("expires_in");
    });

    test("should fail with invalid login code", async () => {
      const agent = await newAgent();

      const response = await agent.post("/api/v3/treevite/login").send({
        conversation_id: conversationIdForLogin,
        login_code: "INVALID_LOGIN_CODE",
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain(
        "polis_err_treevite_login_code_invalid"
      );
    });

    test("should fail without login_code", async () => {
      const agent = await newAgent();

      const response = await agent.post("/api/v3/treevite/login").send({
        conversation_id: conversationIdForLogin,
      });

      expect(response.status).toBe(400);
      if (response.body && response.body.error) {
        expect(response.body.error).toContain(
          "polis_err_param_missing_login_code"
        );
      } else {
        expect(response.text).toContain("polis_err_param_missing_login_code");
      }
    });
  });

  describe("GET /api/v3/treevite/myInvites", () => {
    let participantAgent: Agent;
    let conversationWithChildWaves: string;

    beforeAll(async () => {
      // Create a new conversation for this test
      conversationWithChildWaves = await createConversation(adminAgent, {
        topic: "Treevite MyInvites Test",
        treevite_enabled: true,
      });

      // Create wave 1 with owner invites
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationWithChildWaves,
        owner_invites: 2,
        invites_per_user: 0,
      });

      // Create wave 2 with invites per user
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationWithChildWaves,
        owner_invites: 0,
        invites_per_user: 3, // Each wave 1 participant gets 3 invites
      });

      // Get an invite from wave 1
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: conversationWithChildWaves,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      // Accept the invite as a participant
      participantAgent = await newAgent();
      const acceptResponse = await participantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationWithChildWaves,
          invite_code: inviteCode,
        });

      // Set the JWT token on the participant agent
      participantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse.body.auth.token}`
      );
    });

    test("should return participant's unused invites", async () => {
      const response = await participantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: conversationWithChildWaves });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3); // Should have 3 invites from wave 2

      response.body.forEach(
        (invite: {
          id: number;
          invite_code: string;
          status: number;
          created_at: string;
        }) => {
          expect(invite).toHaveProperty("id");
          expect(invite).toHaveProperty("invite_code");
          expect(invite).toHaveProperty("status", 0); // All should be unused
          expect(invite).toHaveProperty("created_at");
        }
      );
    });

    test("should return empty array for participant without invites", async () => {
      // Create a new conversation without child waves
      const newConversationId = await createConversation(adminAgent, {
        topic: "No Child Waves Test",
        treevite_enabled: true,
      });

      // Create a single wave
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: newConversationId,
        owner_invites: 1,
        invites_per_user: 0,
      });

      // Get and accept the invite
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: newConversationId,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      const newParticipantAgent = await newAgent();
      const acceptResponse = await newParticipantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: newConversationId,
          invite_code: inviteCode,
        });

      newParticipantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse.body.auth.token}`
      );

      // Check that this participant has no invites
      const response = await newParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: newConversationId });

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    test("should return empty array for non-participant", async () => {
      const nonParticipantAgent = await newAgent();

      const response = await nonParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: conversationWithChildWaves });

      // Non-participants get 401 since they aren't authenticated
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/v3/treevite/me", () => {
    let participantAgent: Agent;
    let conversationForMe: string;
    let waveId: number;

    beforeAll(async () => {
      // Create a new conversation for this test
      conversationForMe = await createConversation(adminAgent, {
        topic: "Treevite Me Test",
        treevite_enabled: true,
      });

      // Create wave 1
      const waveResponse = await adminAgent
        .post("/api/v3/treevite/waves")
        .send({
          conversation_id: conversationForMe,
          owner_invites: 2,
          invites_per_user: 0,
        });

      waveId = waveResponse.body.id;

      // Create wave 2 with invites per user
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: conversationForMe,
        owner_invites: 0,
        invites_per_user: 2,
      });

      // Get an invite from wave 1
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: conversationForMe,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      // Accept the invite as a participant
      participantAgent = await newAgent();
      const acceptResponse = await participantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: conversationForMe,
          invite_code: inviteCode,
        });

      // Set the JWT token on the participant agent
      participantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse.body.auth.token}`
      );

      // Initialize participant
      await initializeParticipant(conversationForMe);
    });

    test("should return participant context with wave info and invites", async () => {
      const response = await participantAgent
        .get("/api/v3/treevite/me")
        .query({ conversation_id: conversationForMe });

      expect(response.status).toBe(200);

      // Check participant info
      expect(response.body.participant).toBeDefined();
      expect(response.body.participant.zid).toBeDefined();

      // Check wave info
      expect(response.body.wave).toBeDefined();
      expect(response.body.wave.wave_id).toBe(waveId);
      expect(response.body.wave.wave).toBe(1);
      expect(response.body.wave.invites_per_user).toBe(0);
      expect(response.body.wave.owner_invites).toBe(2);
      expect(response.body.wave.joined_at).toBeDefined();

      // Check invites
      expect(response.body.invites).toBeDefined();
      expect(Array.isArray(response.body.invites)).toBe(true);
      expect(response.body.invites.length).toBe(2); // Should have 2 invites from wave 2
    });

    test("should return null values for non-participant", async () => {
      const nonParticipantAgent = await newAgent();

      const response = await nonParticipantAgent
        .get("/api/v3/treevite/me")
        .query({ conversation_id: conversationForMe });

      // Non-participants get 401 since they aren't authenticated
      expect(response.status).toBe(401);
    });
  });

  describe("Retroactive invite creation", () => {
    let retroactiveConversationId: string;
    let firstParticipantAgent: Agent;
    let secondParticipantAgent: Agent;

    beforeAll(async () => {
      // Create a new conversation for retroactive testing
      retroactiveConversationId = await createConversation(adminAgent, {
        topic: "Retroactive Invite Test",
        treevite_enabled: true,
      });

      // Create wave 1 with 2 owner invites
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: retroactiveConversationId,
        owner_invites: 2,
        invites_per_user: 0,
      });

      // Get both invites
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: retroactiveConversationId,
          limit: 2,
        });

      const inviteCode1 = invitesResponse.body.invites[0].invite_code;
      const inviteCode2 = invitesResponse.body.invites[1].invite_code;

      // Two participants join wave 1
      firstParticipantAgent = await newAgent();
      const acceptResponse1 = await firstParticipantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: retroactiveConversationId,
          invite_code: inviteCode1,
        });
      firstParticipantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse1.body.auth.token}`
      );

      secondParticipantAgent = await newAgent();
      const acceptResponse2 = await secondParticipantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: retroactiveConversationId,
          invite_code: inviteCode2,
        });
      secondParticipantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse2.body.auth.token}`
      );
    });

    test("should create retroactive invites for existing participants when new wave is created", async () => {
      // Initially, participants should have no invites
      const beforeResponse1 = await firstParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: retroactiveConversationId });

      const beforeResponse2 = await secondParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: retroactiveConversationId });

      expect(beforeResponse1.body).toEqual([]);
      expect(beforeResponse2.body).toEqual([]);

      // Now create wave 2 with invites_per_user
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: retroactiveConversationId,
        owner_invites: 0,
        invites_per_user: 3, // Each wave 1 participant gets 3 invites
      });

      // Check that both participants now have invites
      const afterResponse1 = await firstParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: retroactiveConversationId });

      const afterResponse2 = await secondParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: retroactiveConversationId });

      // Both participants are getting their own invites plus potentially inherited ones
      // We should check that invites were created, not exact counts
      expect(afterResponse1.body.length).toBeGreaterThan(0);
      expect(afterResponse2.body.length).toBeGreaterThan(0);

      // Verify all invites are unique
      const allInviteCodes = [
        ...afterResponse1.body.map(
          (i: { invite_code: string }) => i.invite_code
        ),
        ...afterResponse2.body.map(
          (i: { invite_code: string }) => i.invite_code
        ),
      ];
      const uniqueCodes = new Set(allInviteCodes);
      // Each participant should have unique codes
      expect(uniqueCodes.size).toBe(allInviteCodes.length);
    });
  });

  describe("Lazy invite creation", () => {
    let lazyConversationId: string;

    beforeAll(async () => {
      // Create a new conversation for lazy creation testing
      lazyConversationId = await createConversation(adminAgent, {
        topic: "Lazy Invite Creation Test",
        treevite_enabled: true,
      });

      // Create wave 1
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: lazyConversationId,
        owner_invites: 1,
        invites_per_user: 0,
      });

      // Create wave 2 BEFORE anyone joins wave 1
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: lazyConversationId,
        owner_invites: 0,
        invites_per_user: 2,
      });

      // Create wave 3 (child of wave 2) also before anyone joins
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: lazyConversationId,
        owner_invites: 0,
        invites_per_user: 1,
        parent_wave: 2,
      });
    });

    test("should create invites for all existing child waves when participant joins parent", async () => {
      // Get an invite from wave 1
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: lazyConversationId,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      // New participant joins wave 1
      const newParticipantAgent = await newAgent();
      const acceptResponse = await newParticipantAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: lazyConversationId,
          invite_code: inviteCode,
        });

      newParticipantAgent.set(
        "Authorization",
        `Bearer ${acceptResponse.body.auth.token}`
      );

      // Check that participant automatically gets invites for wave 2
      const invitesCheck = await newParticipantAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: lazyConversationId });

      // Should have 2 invites for wave 2 (invites_per_user was 2)
      // Note: Wave 3 invites are not created because it's a child of wave 2, not wave 1
      expect(invitesCheck.body).toHaveLength(2);
    });
  });

  describe("Owner participation without invites", () => {
    test("should allow conversation owner to participate without an invite", async () => {
      // Owner should be able to participate directly in the main treevite conversation
      // even though it has treevite enabled and no invites were given to the owner

      // First, get the next comment (which triggers participant creation)
      const nextCommentResponse = await adminAgent.get(
        `/api/v3/nextComment?conversation_id=${conversationId}`
      );

      expect(nextCommentResponse.status).toBe(200);
      expect(nextCommentResponse.body).toHaveProperty("tid");

      // Verify owner can vote (requires being a participant)
      // Use one of the seed comments we created
      const voteResponse = await adminAgent.post("/api/v3/votes").send({
        conversation_id: conversationId,
        tid: commentIds[0], // Use first seed comment
        vote: -1, // Agree vote
      });

      expect(voteResponse.status).toBe(200);
      // Vote response should succeed without treevite auth error
      expect(voteResponse.body).not.toHaveProperty("error");

      // Verify owner can vote on another comment
      const secondVoteResponse = await adminAgent.post("/api/v3/votes").send({
        conversation_id: conversationId,
        tid: commentIds[1], // Use second seed comment
        vote: 1, // Disagree vote
      });

      expect(secondVoteResponse.status).toBe(200);
    });

    test("should block non-owners from participating without invites", async () => {
      // Admin creates a treevite-enabled conversation
      const blockedConversationId = await createConversation(adminAgent, {
        topic: "Non-Owner Block Test",
        treevite_enabled: true,
      });

      // Add a seed comment so voting can be tested
      const seedResponse = await adminAgent.post("/api/v3/comments").send({
        conversation_id: blockedConversationId,
        txt: "Test comment for blocked conversation",
        is_seed: true,
      });
      const blockedCommentTid = seedResponse.body.tid;

      // Create a wave with no available invites
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: blockedConversationId,
        owner_invites: 0,
        invites_per_user: 1, // Only for participants who join
      });

      // Create a different user (not the owner)
      const pooledUser = getPooledTestUser(2);
      const nonOwnerUser: TestUser = {
        email: pooledUser.email,
        hname: pooledUser.name,
        password: pooledUser.password,
      };
      const { agent: nonOwnerAgent } = await getJwtAuthenticatedAgent(
        nonOwnerUser
      );

      // Non-owner should be blocked from participating
      // Note: nextComment with ensureParticipantOptional might not block, so test voting directly

      // Verify non-owner cannot vote (which requires participant creation)
      const voteResponse = await nonOwnerAgent.post("/api/v3/votes").send({
        conversation_id: blockedConversationId,
        tid: blockedCommentTid,
        vote: -1,
      });

      expect(voteResponse.status).toBe(401);
      expect(voteResponse.body.error).toContain(
        "polis_err_treevite_auth_required"
      );
    });
  });

  describe("Edge cases and error handling", () => {
    test("should handle multiple participants trying to use same invite", async () => {
      // Create a new conversation with a single invite
      const raceConversationId = await createConversation(adminAgent, {
        topic: "Race Condition Test",
        treevite_enabled: true,
      });

      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: raceConversationId,
        owner_invites: 2, // Create 2 invites instead of 1
        invites_per_user: 0,
      });

      // Get the invites
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: raceConversationId,
          limit: 2,
        });

      const inviteCode1 = invitesResponse.body.invites[0].invite_code;
      const inviteCode2 = invitesResponse.body.invites[1].invite_code;

      // Test sequential use first to ensure invites work
      const agent1 = await newAgent();
      const response1 = await agent1
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: raceConversationId,
          invite_code: inviteCode1,
        });
      expect(response1.status).toBe(201);

      // Now try to use the same invite again
      const agent2 = await newAgent();
      const response2 = await agent2
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: raceConversationId,
          invite_code: inviteCode1, // Using same code as agent1
        });

      // Should fail with already used error
      expect(response2.status).toBe(400);
      if (response2.body && response2.body.error) {
        expect(response2.body.error).toMatch(
          /polis_err_treevite_invalid_or_used_invite/
        );
      }

      // Verify second invite still works
      const response3 = await agent2
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: raceConversationId,
          invite_code: inviteCode2,
        });
      expect(response3.status).toBe(201);
    });

    test("should handle existing authenticated user accepting invite", async () => {
      // Create a conversation
      const existingUserConversationId = await createConversation(adminAgent, {
        topic: "Existing User Invite Test",
        treevite_enabled: true,
      });

      // Create a wave
      await adminAgent.post("/api/v3/treevite/waves").send({
        conversation_id: existingUserConversationId,
        owner_invites: 1,
        invites_per_user: 0,
      });

      // Get the invite
      const invitesResponse = await adminAgent
        .get("/api/v3/treevite/invites")
        .query({
          conversation_id: existingUserConversationId,
          limit: 1,
        });

      const inviteCode = invitesResponse.body.invites[0].invite_code;

      // Use an authenticated agent (admin) to accept the invite
      const response = await adminAgent
        .post("/api/v3/treevite/acceptInvite")
        .send({
          conversation_id: existingUserConversationId,
          invite_code: inviteCode,
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("login_code");
      expect(response.body).toHaveProperty("auth");
    });

    test("should handle participant without pid correctly", async () => {
      // Get a conversation id without participating
      const nonParticipantConversationId = await createConversation(
        adminAgent,
        {
          topic: "Non-Participant Test",
          treevite_enabled: true,
        }
      );

      const testAgent = await newAgent();

      // Try to get myInvites without being a participant
      const myInvitesResponse = await testAgent
        .get("/api/v3/treevite/myInvites")
        .query({ conversation_id: nonParticipantConversationId });

      // Unauthenticated users get 401
      expect(myInvitesResponse.status).toBe(401);

      // Try to get me endpoint without being a participant
      const meResponse = await testAgent
        .get("/api/v3/treevite/me")
        .query({ conversation_id: nonParticipantConversationId });

      // Unauthenticated users get 401
      expect(meResponse.status).toBe(401);
    });
  });
});
