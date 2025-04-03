import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  createComment,
  createConversation,
  generateTestUser,
  getTestAgent,
  newAgent,
  registerAndLoginUser
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { AuthData, TestUser } from '../../types/test-helpers';

interface Conversation {
  conversation_id: string;
  topic: string;
  description?: string;
  is_active?: boolean;
  is_anon?: boolean;
  [key: string]: any;
}

interface ConversationStats {
  voteTimes: any[];
  firstVoteTimes: any[];
  commentTimes: any[];
  firstCommentTimes: any[];
  votesHistogram: any;
  burstHistogram: any;
  [key: string]: any;
}

describe('Conversation Details API', () => {
  let agent: Agent;

  beforeEach(async () => {
    // Initialize agent
    agent = await getTestAgent();
    
    const testUser: TestUser = generateTestUser();
    await registerAndLoginUser(testUser);
  });

  test('should retrieve conversation details using conversation_id', async () => {
    // Create a public conversation
    const conversationId: string = await createConversation(agent, {
      is_active: true,
      is_anon: true,
      topic: 'Test Public Conversation',
      description: 'This is a test public conversation for the details endpoint'
    });

    // Add a comment to the conversation
    await createComment(agent, conversationId, {
      txt: 'This is a test comment for the conversation'
    });

    const response: Response = await agent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    // Check that the response is successful
    expect(response.status).toBe(200);
    // The endpoint returns one conversation when conversation_id is specified
    expect(response.body).toBeDefined();
    // Verify the conversation has the expected topic
    const conversation = response.body as Conversation;
    expect(conversation.topic).toBe('Test Public Conversation');
  });

  test('should retrieve conversation list for an authenticated user', async () => {
    // Create a public conversation
    const conversation1Id: string = await createConversation(agent, {
      topic: 'My Test Conversation 1'
    });

    const conversation2Id: string = await createConversation(agent, {
      topic: 'My Test Conversation 2'
    });

    // Fetch conversation list for the user - use the correct path without API_PREFIX
    const response: Response = await agent.get('/api/v3/conversations');

    // Check that the response is successful
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBe(2);

    // Find our created conversation in the list
    const conversations = response.body as Conversation[];
    const foundConversation1 = conversations.find((conv) => conv.conversation_id === conversation1Id);
    const foundConversation2 = conversations.find((conv) => conv.conversation_id === conversation2Id);

    expect(foundConversation1).toBeDefined();
    expect(foundConversation1?.topic).toBe('My Test Conversation 1');
    expect(foundConversation2).toBeDefined();
    expect(foundConversation2?.topic).toBe('My Test Conversation 2');
  });

  test('should retrieve public conversation by conversation_id', async () => {
    // Create a public conversation
    const conversationId: string = await createConversation(agent, {
      is_active: true,
      is_anon: true,
      topic: 'Public Test Conversation',
      description: 'This is a public test conversation'
    });

    const publicAgent = await newAgent();

    // Fetch conversation details without auth token
    const response: Response = await publicAgent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    // Check that the response is successful
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    const conversation = response.body as Conversation;
    expect(conversation.topic).toBe('Public Test Conversation');
  });

  test('should return 400 for non-existent conversation', async () => {
    // Try to fetch a conversation with an invalid ID
    const response: Response = await agent.get('/api/v3/conversations?conversation_id=nonexistent-conversation-id');

    // The endpoint returns a 400 error for a non-existent conversation
    expect(response.status).toBe(400);
    expect(response.text).toContain('polis_err_param_parse_failed_conversation_id');
    expect(response.text).toContain('polis_err_fetching_zid_for_conversation_id');
  });

  test('should retrieve conversation stats', async () => {
    // Create a public conversation
    const conversationId: string = await createConversation(agent, {
      is_active: true,
      is_anon: true,
      topic: 'Test Stats Conversation'
    });

    // Get conversation stats
    const response: Response = await agent.get(`/api/v3/conversationStats?conversation_id=${conversationId}`);

    // Check that the response is successful
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    const stats = response.body as ConversationStats;
    expect(stats.voteTimes).toBeDefined();
    expect(stats.firstVoteTimes).toBeDefined();
    expect(stats.commentTimes).toBeDefined();
    expect(stats.firstCommentTimes).toBeDefined();
    expect(stats.votesHistogram).toBeDefined();
    expect(stats.burstHistogram).toBeDefined();
  });
});