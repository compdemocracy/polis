import { beforeAll, describe, expect, test } from '@jest/globals';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import {
  getTestAgent,
  getTextAgent,
  initializeParticipant,
  setupAuthAndConvo,
  submitVote
} from '../setup/api-test-helpers';

interface Comment {
  tid: number;
  txt: string;
  [key: string]: any;
}

describe('Next Comment Endpoint', () => {
  // Declare agent variables
  let agent: Agent;
  let textAgent: Agent;
  let conversationId: string | null = null;
  let commentIds: number[] = [];

  beforeAll(async () => {
    // Initialize agents
    agent = await getTestAgent();
    textAgent = await getTextAgent();
    
    // Setup auth and create test conversation with multiple comments
    const setup = await setupAuthAndConvo({
      commentCount: 5
    });

    conversationId = setup.conversationId;
    commentIds = setup.commentIds;

    // Ensure we have comments to work with
    expect(commentIds.length).toBe(5);
  });

  test('GET /nextComment - Get next comment for voting', async () => {
    // Request the next comment for voting
    const response: Response = await agent.get(`/api/v3/nextComment?conversation_id=${conversationId}`);

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // The response should have a tid (comment ID) and txt (comment text)
    expect(response.body.tid).toBeDefined();
    expect(response.body.txt).toBeDefined();

    // The returned comment should be one of our test comments
    expect(commentIds).toContain(response.body.tid);
  });

  test('GET /nextComment - Anonymous users can get next comment', async () => {
    // Initialize anonymous participant
    const { agent: anonAgent } = await initializeParticipant(conversationId!);

    // Request next comment as anonymous user
    const response: Response = await anonAgent.get(`/api/v3/nextComment?conversation_id=${conversationId}`);

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    expect(response.body.tid).toBeDefined();
    expect(response.body.txt).toBeDefined();
  });

  test('GET /nextComment - Respect not_voted_by_pid parameter', async () => {
    // Initialize a new participant
    const { agent: firstAgent, body: initBody } = await initializeParticipant(conversationId!);
    expect(initBody.nextComment).toBeDefined();
    const { nextComment: firstComment } = initBody;

    // Submit vote to get auth token
    const firstVoteResponse = await submitVote(firstAgent, {
      tid: firstComment.tid,
      conversation_id: conversationId!,
      vote: 0
    });

    expect(firstVoteResponse.status).toBe(200);
    expect(firstVoteResponse.body).toHaveProperty('currentPid');
    expect(firstVoteResponse.body).toHaveProperty('nextComment');

    const { currentPid: firstVoterPid, nextComment: secondComment } = firstVoteResponse.body;

    // Vote on 3 more comments
    const secondVoteResponse = await submitVote(firstAgent, {
      pid: firstVoterPid,
      tid: secondComment.tid,
      conversation_id: conversationId!,
      vote: 0
    });

    const thirdVoteResponse = await submitVote(firstAgent, {
      pid: firstVoterPid,
      tid: secondVoteResponse.body.nextComment.tid,
      conversation_id: conversationId!,
      vote: 0
    });

    const fourthVoteResponse = await submitVote(firstAgent, {
      pid: firstVoterPid,
      tid: thirdVoteResponse.body.nextComment.tid,
      conversation_id: conversationId!,
      vote: 0
    });

    const lastComment = fourthVoteResponse.body.nextComment;

    // Initialize a new participant
    const { agent: secondAgent } = await initializeParticipant(conversationId!);

    // Get next comment
    const nextResponse: Response = await secondAgent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&not_voted_by_pid=${firstVoterPid}`
    );

    // Validate response - should return the comment not voted on by the first participant
    expect(nextResponse.status).toBe(200);
    expect(nextResponse.body).toBeDefined();
    expect(nextResponse.body.tid).toBe(lastComment.tid);
  });

  test('GET /nextComment - 400 for missing conversation_id', async () => {
    // Request without required conversation_id
    const response: Response = await textAgent.get('/api/v3/nextComment');

    // Validate response
    expect(response.status).toBe(400);
    expect(response.text).toMatch(/polis_err_param_missing_conversation_id/);
  });

  test('GET /nextComment - Handles `without` parameter', async () => {
    const withoutCommentIds = commentIds.slice(0, 4);

    // Request next comment without comments 0-3
    const response: Response = await agent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&without=${withoutCommentIds}`
    );

    // Validate response is the last comment
    expect(response.status).toBe(200);
    expect(response.body.tid).toBe(commentIds[4]);
    expect(withoutCommentIds).not.toContain(response.body.tid);
  });
});