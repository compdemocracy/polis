import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  createComment,
  getTestAgent,
  getTextAgent,
  initializeParticipant,
  setupAuthAndConvo,
  submitVote
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';

interface Comment {
  tid: number;
  txt: string;
  active?: boolean;
  mod?: number;
  is_meta?: boolean;
  velocity?: number;
  [key: string]: any;
}

interface VoteResponse {
  currentPid: string;
  [key: string]: any;
}

describe('Extended Comment Endpoints', () => {
  let conversationId: string;
  let commentId: number;
  let agent: Agent;
  let textAgent: Agent;

  beforeAll(async () => {
    agent = await getTestAgent();
    textAgent = await getTextAgent();

    // Set up auth and conversation with comments
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0];
  });

  test('GET /comments with tids - Get specific comment by ID', async () => {
    // Create a new comment to ensure clean test data
    const timestamp = Date.now();
    const commentText = `Test comment for individual retrieval ${timestamp}`;
    const newCommentId: number = await createComment(agent, conversationId, {
      txt: commentText
    });

    // Retrieve the specific comment by ID using the tids parameter
    const commentsResponse: Response = await agent.get(`/api/v3/comments?conversation_id=${conversationId}&tids=${newCommentId}`);

    expect(commentsResponse.status).toBe(200);
    const comments: Comment[] = JSON.parse(commentsResponse.text);

    // Validate response
    expect(Array.isArray(comments)).toBe(true);
    expect(comments.length).toBe(1);

    const [comment] = comments;
    expect(comment).toBeDefined();
    expect(comment.tid).toBe(newCommentId);
    expect(comment.txt).toBe(commentText);
  });

  test('GET /comments with non-existent tid returns empty array', async () => {
    // Request a comment with an invalid ID
    const nonExistentId: number = 999999999;
    const commentsResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&tids=${nonExistentId}`
    );

    expect(commentsResponse.status).toBe(200);
    const comments: Comment[] = JSON.parse(commentsResponse.text);

    // Validate response - should be an empty array
    expect(Array.isArray(comments)).toBe(true);
    expect(comments.length).toBe(0);
  });

  test('PUT /comments - Moderate a comment', async () => {
    // Create a new comment to test moderation
    const timestamp = Date.now();
    const commentText = `Comment for moderation test ${timestamp}`;
    const moderationCommentId: number = await createComment(agent, conversationId, {
      txt: commentText
    });

    // Moderate the comment - this endpoint is for moderation, not updating text
    const updateResponse: Response = await agent.put('/api/v3/comments').send({
      tid: moderationCommentId,
      conversation_id: conversationId,
      active: true, // Required - determines if comment is active
      mod: 1, // Required - moderation status (0=ok, 1=hidden, etc.)
      is_meta: false, // Required - meta comment flag
      velocity: 1 // Required - comment velocity (0-1)
    });

    // Validate update response
    expect(updateResponse.status).toBe(200);

    // Get the comment to verify the moderation
    const commentsResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&tids=${moderationCommentId}`
    );

    expect(commentsResponse.status).toBe(200);
    const comments: Comment[] = JSON.parse(commentsResponse.text);

    // Validate get response
    expect(Array.isArray(comments)).toBe(true);
    expect(comments.length).toBe(1);

    const [moderatedComment] = comments;
    expect(moderatedComment.tid).toBe(moderationCommentId);
    // Original text should remain unchanged as this endpoint only updates moderation status
    expect(moderatedComment.txt).toBe(commentText);
  });

  test('PUT /comments - Validation fails for missing required fields', async () => {
    // Try to update a comment with missing required fields
    const response: Response = await textAgent.put('/api/v3/comments').send({
      // Missing various required fields
      tid: commentId,
      conversation_id: conversationId
      // Missing: active, mod, is_meta, velocity
    });

    expect(response.status).toBe(400);
    expect(response.text).toMatch(/polis_err_param_missing/);
  });

  test('GET /comments - Filtering by multiple parameters', async () => {
    // Create multiple comments with different attributes
    const comment1Id: number = await createComment(agent, conversationId, {
      txt: `Comment for filtering test 1 ${Date.now()}`
    });

    const comment2Id: number = await createComment(agent, conversationId, {
      txt: `Comment for filtering test 2 ${Date.now()}`
    });

    const comment3Id: number = await createComment(agent, conversationId, {
      txt: `Comment for filtering test 3 ${Date.now()}`
    });

    // Moderate comment 2
    const moderateResponse: Response = await agent.put('/api/v3/comments').send({
      tid: comment2Id,
      conversation_id: conversationId,
      active: true,
      mod: 1,
      is_meta: false,
      velocity: 1
    });

    expect(moderateResponse.status).toBe(200);

    // Test filtering by specific tids
    const filteredByTidsResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&tids=${comment2Id},${comment3Id}`
    );

    expect(filteredByTidsResponse.status).toBe(200);
    const filteredByTids: Comment[] = JSON.parse(filteredByTidsResponse.text);

    expect(Array.isArray(filteredByTids)).toBe(true);
    expect(filteredByTids.length).toBe(2);

    // The comment IDs we just created should be in the results
    const filteredCommentIds = filteredByTids.map((c) => c.tid);
    expect(filteredCommentIds).toContain(comment2Id);
    expect(filteredCommentIds).toContain(comment3Id);

    // Test filtering by moderation status and tids
    const filteredByModResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&tids=${comment1Id},${comment2Id},${comment3Id}&mod=1`
    );

    expect(filteredByModResponse.status).toBe(200);
    const filteredByMod: Comment[] = JSON.parse(filteredByModResponse.text);

    expect(Array.isArray(filteredByMod)).toBe(true);
    expect(filteredByMod.length).toBe(1);

    // The comment ID we just moderated should be in the results
    const moderatedCommentIds = filteredByMod.map((c) => c.tid);
    expect(moderatedCommentIds).toContain(comment2Id);
  });

  test('GET /comments - Filtering by not_voted_by_pid parameter', async () => {
    // Create two new comments
    const comment1Id: number = await createComment(agent, conversationId, {
      txt: `Comment for not_voted_by_pid test 1 ${Date.now()}`
    });

    const comment2Id: number = await createComment(agent, conversationId, {
      txt: `Comment for not_voted_by_pid test 2 ${Date.now()}`
    });

    // Initialize a participant
    const { agent: participantAgent } = await initializeParticipant(conversationId);

    // Vote on one of the comments as the participant
    const voteResponse: Response = await submitVote(participantAgent, {
      tid: comment1Id,
      conversation_id: conversationId,
      vote: 1 // 1 is disagree in this system
    });

    expect(voteResponse.status).toBe(200);

    const voteData = voteResponse.body as VoteResponse;
    expect(voteData).toHaveProperty('currentPid');
    const currentPid: string = voteData.currentPid;

    // Get comments not voted on by this participant
    const notVotedResponse: Response = await agent.get(
      `/api/v3/comments?conversation_id=${conversationId}&not_voted_by_pid=${currentPid}`
    );

    expect(notVotedResponse.status).toBe(200);
    const notVotedComments: Comment[] = JSON.parse(notVotedResponse.text);

    // Should only return the second comment (not voted on)
    expect(Array.isArray(notVotedComments)).toBe(true);

    // Confirm comment1Id is not in the results (since we voted on it)
    const returnedIds = notVotedComments.map((c) => c.tid);
    expect(returnedIds).not.toContain(comment1Id);

    // Confirm comment2Id is in the results (since we didn't vote on it)
    expect(returnedIds).toContain(comment2Id);
  });

  test('GET /comments/translations - returns 400 for missing conversation_id', async () => {
    const response: Response = await agent.get(
      `/api/v3/comments/translations?conversation_id=${conversationId}&tid=${commentId}&lang=en`
    );

    // NOTE: The legacy implementation has a bug (does not use moveToBody for GET params)
    // so it is expected to always return a 400 error
    expect(response.status).toBe(400);
    expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
  });
});