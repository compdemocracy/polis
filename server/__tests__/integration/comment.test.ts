import { beforeAll, describe, expect, test } from '@jest/globals';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import {
  createComment,
  generateRandomXid,
  getTestAgent,
  getTextAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo
} from '../setup/api-test-helpers';

interface Comment {
  tid: number;
  txt: string;
  conversation_id: string;
  created: number;
  [key: string]: any;
}

describe('Comment Endpoints', () => {
  // Declare agent variables
  let agent: Agent;
  let textAgent: Agent;
  let conversationId: string | null = null;

  beforeAll(async () => {
    // Initialize agents
    agent = await getTestAgent();
    textAgent = await getTextAgent();
    
    // Setup auth and create test conversation
    const setup = await setupAuthAndConvo();
    conversationId = setup.conversationId;
  });

  test('Comment lifecycle', async () => {
    // STEP 1: Create a new comment
    const timestamp = Date.now();
    const commentText = `Test comment ${timestamp}`;
    const commentId = await createComment(agent, conversationId!, {
      conversation_id: conversationId!,
      txt: commentText
    });

    expect(commentId).toBeDefined();

    // STEP 2: Verify comment appears in conversation
    const listResponse: Response = await agent.get(`/api/v3/comments?conversation_id=${conversationId}`);
    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find((comment) => comment.tid === commentId);
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });

  test('Comment validation', async () => {
    // Test invalid conversation ID
    const invalidResponse = await textAgent.post('/api/v3/comments').send({
      conversation_id: 'invalid-conversation-id',
      txt: 'This comment should fail'
    });

    expect(invalidResponse.status).toBe(400);

    // Test missing conversation ID in comments list
    const missingConvResponse = await agent.get('/api/v3/comments');
    expect(missingConvResponse.status).toBe(400);
  });

  test('Anonymous participant can submit a comment', async () => {
    // Initialize anonymous participant
    const { agent } = await initializeParticipant(conversationId!);

    // Create a comment as anonymous participant using the helper
    const timestamp = Date.now();
    const commentText = `Anonymous participant comment ${timestamp}`;
    const commentId = await createComment(agent, conversationId!, {
      conversation_id: conversationId!,
      txt: commentText
    });

    expect(commentId).toBeDefined();

    // Verify the comment appears in the conversation
    const listResponse: Response = await agent.get(`/api/v3/comments?conversation_id=${conversationId}`);

    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find((comment) => comment.tid === commentId);
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });

  test('XID participant can submit a comment', async () => {
    // Initialize participant with XID
    const xid = generateRandomXid();
    const { agent } = await initializeParticipantWithXid(conversationId!, xid);

    // Create a comment as XID participant using the helper
    const timestamp = Date.now();
    const commentText = `XID participant comment ${timestamp}`;
    const commentId = await createComment(agent, conversationId!, {
      conversation_id: conversationId!,
      txt: commentText
    });

    expect(commentId).toBeDefined();

    // Verify the comment appears in the conversation
    const listResponse: Response = await agent.get(`/api/v3/comments?conversation_id=${conversationId}`);

    expect(listResponse.status).toBe(200);
    const responseBody: Comment[] = JSON.parse(listResponse.text);
    expect(Array.isArray(responseBody)).toBe(true);
    const foundComment = responseBody.find((comment) => comment.tid === commentId);
    expect(foundComment).toBeDefined();
    expect(foundComment!.txt).toBe(commentText);
  });
});