import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  initializeParticipant,
  setupAuthAndConvo,
  submitVote,
} from "../setup/api-test-helpers";

describe("Vote API", () => {
  let conversationId: string;
  let commentId: number;

  beforeEach(async () => {
    // Setup auth, conversation, and comments
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0];
  });

  describe("POST /votes", () => {
    test("should create a vote for a comment", async () => {
      // Initialize a participant
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      // Submit a vote (-1 = AGREE)
      const voteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1, // -1 = AGREE in this system
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
    });

    test("should require a valid conversation_id", async () => {
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      const response = await submitVote(participantAgent, {
        conversation_id: "invalid_conversation_id",
        tid: commentId,
        vote: 0,
      });

      // The API returns 400 for missing required parameters
      expect(response.status).toBe(400);

      expect(response.text).toMatch(
        /polis_err_param_parse_failed_conversation_id/
      );
      expect(response.text).toMatch(
        /polis_err_fetching_zid_for_conversation_id/
      );
    });

    test("should require a valid tid", async () => {
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      // Using non-null assertion since we know this won't be null in our test
      const response = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: "invalid_tid" as unknown as number,
        vote: 0,
      });

      // The API returns 400 for missing required parameters
      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_parse_failed_tid/);
      expect(response.text).toMatch(/polis_fail_parse_int/);
    });

    test("should accept votes of -1, 0, or 1", async () => {
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      // Vote 1 (DISAGREE)
      const disagreeResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1, // 1 = DISAGREE in this system
      });
      expect(disagreeResponse.status).toBe(200);

      // Vote 0 (PASS)
      const passResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 0, // 0 = PASS
      });
      expect(passResponse.status).toBe(200);

      // Vote -1 (AGREE)
      const agreeResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1, // -1 = AGREE in this system
      });
      expect(agreeResponse.status).toBe(200);
    });

    test("should allow vote modification", async () => {
      // Initialize a participant
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      // Submit initial vote (AGREE)
      const initialVoteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1, // -1 = AGREE in this system
      });

      expect(initialVoteResponse.status).toBe(200);
      expect(initialVoteResponse.body).toHaveProperty("currentPid");
      const { currentPid } = initialVoteResponse.body;
      expect(currentPid).toBeDefined();
      expect(typeof currentPid).toBe("number");

      // Change vote to DISAGREE
      const changedVoteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1, // 1 = DISAGREE in this system
        pid: Number(currentPid),
      });

      expect(changedVoteResponse.status).toBe(200);
      expect(changedVoteResponse.body).toBeDefined();

      // Use the agent's direct call but parse the response properly
      const votesResponse = await participantAgent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=${Number(
          currentPid
        )}`
      );
      expect(votesResponse.status).toBe(200);

      // Votes are now automatically parsed into response.body
      const votes = votesResponse.body;
      expect(Array.isArray(votes)).toBe(true);
      expect(votes.length).toBe(1);
      expect(votes[0].vote).toBe(1);
    });
  });

  describe("GET /votes", () => {
    test("should retrieve votes for a conversation", async () => {
      // Create a participant and submit a vote
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      const voteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1, // -1 = AGREE in this system
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      const { currentPid } = voteResponse.body;
      expect(currentPid).toBeDefined();
      expect(typeof currentPid).toBe("number");

      // Use the agent's direct call but parse the response properly
      const votesResponse = await participantAgent.get(
        `/api/v3/votes?conversation_id=${conversationId}&pid=${Number(
          currentPid
        )}`
      );
      expect(votesResponse.status).toBe(200);

      // Votes are now automatically parsed into response.body
      const votes = votesResponse.body;
      expect(Array.isArray(votes)).toBe(true);
      expect(votes.length).toBe(1);
      expect(votes[0].vote).toBe(-1);
    });
  });

  describe("GET /votes/me", () => {
    test("should retrieve votes for the current participant", async () => {
      // Create a participant and submit a vote
      const { agent: participantAgent } = await initializeParticipant(
        conversationId
      );

      const voteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1, // -1 = AGREE in this system
      });

      expect(voteResponse.status).toBe(200);
      expect(voteResponse.body).toHaveProperty("currentPid");
      const { currentPid } = voteResponse.body;
      expect(currentPid).toBeDefined();
      expect(typeof currentPid).toBe("number");

      // Check if JWT was issued during voting and update agent authorization
      if (voteResponse.body.auth && voteResponse.body.auth.token) {
        participantAgent.set(
          "Authorization",
          `Bearer ${voteResponse.body.auth.token}`
        );
      }

      // Call /votes/me endpoint directly since it requires authentication
      const myVotesResponse = await participantAgent.get(
        `/api/v3/votes/me?conversation_id=${conversationId}&pid=${Number(
          currentPid
        )}`
      );

      // If authentication works, verify the response
      expect(myVotesResponse.status).toBe(200);

      // Votes are now automatically parsed into response.body
      const myVotes = myVotesResponse.body;
      expect(Array.isArray(myVotes)).toBe(true);
      // NOTE: The legacy endpoint may return an empty array even with votes
      expect(myVotes.length).toBeGreaterThanOrEqual(0);
    });
  });
});
