import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  createConversation,
  generateTestUser,
  getTestAgent,
  registerAndLoginUser,
  updateConversation
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { TestUser } from '../../types/test-helpers';

interface Conversation {
  conversation_id: string;
  topic: string;
  description?: string;
  is_active?: boolean;
  strict_moderation?: boolean;
  profanity_filter?: boolean;
  bgcolor?: string | null;
  help_color?: string | null;
  help_bgcolor?: string | null;
  [key: string]: any;
}

interface ConversationUpdateData {
  conversation_id: string;
  topic?: string;
  description?: string;
  is_active?: boolean;
  strict_moderation?: boolean;
  profanity_filter?: boolean;
  bgcolor?: string;
  help_color?: string;
  help_bgcolor?: string;
  [key: string]: any;
}

describe('Conversation Update API', () => {
  let agent: Agent;
  let testUser: TestUser;
  let conversationId: string;

  beforeEach(async () => {
    // Initialize agent
    agent = await getTestAgent();
    
    // Create a test user for each test
    testUser = generateTestUser();
    await registerAndLoginUser(testUser);

    // Create a test conversation for each test
    conversationId = await createConversation(agent, {
      is_active: true,
      is_anon: true,
      topic: 'Original Topic',
      description: 'Original Description',
      strict_moderation: false
    });
  });

  test('should update basic conversation properties', async () => {
    // Update the conversation with new values
    const updateResponse: Response = await updateConversation(agent, {
      conversation_id: conversationId,
      topic: 'Updated Topic',
      description: 'Updated Description'
    });

    // Verify update was successful
    expect(updateResponse.status).toBe(200);

    // Verify the changes by getting the conversation details
    const getResponse: Response = await agent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toBeDefined();
    const conversation = getResponse.body as Conversation;
    expect(conversation.topic).toBe('Updated Topic');
    expect(conversation.description).toBe('Updated Description');
  });

  test('should update boolean settings', async () => {
    // Update various boolean settings
    const updateData: ConversationUpdateData = {
      conversation_id: conversationId,
      is_active: false,
      strict_moderation: true,
      profanity_filter: true
    };

    const updateResponse: Response = await updateConversation(agent, updateData);

    // Verify update was successful
    expect(updateResponse.status).toBe(200);

    // Verify the changes by getting the conversation details
    const getResponse: Response = await agent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toBeDefined();
    const conversation = getResponse.body as Conversation;
    expect(conversation.is_active).toBe(false);
    expect(conversation.strict_moderation).toBe(true);
    expect(conversation.profanity_filter).toBe(true);
  });

  test('should update appearance settings', async () => {
    // Update appearance settings
    const updateData: ConversationUpdateData = {
      conversation_id: conversationId,
      bgcolor: '#f5f5f5',
      help_color: '#333333',
      help_bgcolor: '#ffffff'
    };

    const updateResponse: Response = await updateConversation(agent, updateData);

    // Verify update was successful
    expect(updateResponse.status).toBe(200);

    // Verify the changes by getting the conversation details
    const getResponse: Response = await agent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toBeDefined();
    const conversation = getResponse.body as Conversation;
    expect(conversation.bgcolor).toBe('#f5f5f5');
    expect(conversation.help_color).toBe('#333333');
    expect(conversation.help_bgcolor).toBe('#ffffff');
  });

  test('should handle non-existent conversation', async () => {
    const updateData: ConversationUpdateData = {
      conversation_id: 'non-existent-conversation',
      topic: 'This Should Fail'
    };

    const updateResponse: Response = await updateConversation(agent, updateData);

    // Verify update fails appropriately
    expect(updateResponse.status).not.toBe(200);
  });

  test('should reset appearance settings to default values', async () => {
    // First, set some appearance values
    await updateConversation(agent, {
      conversation_id: conversationId,
      bgcolor: '#f5f5f5',
      help_color: '#333333'
    });

    // Then reset them to default
    const updateData: ConversationUpdateData = {
      conversation_id: conversationId,
      bgcolor: 'default',
      help_color: 'default'
    };

    const updateResponse: Response = await updateConversation(agent, updateData);

    // Verify update was successful
    expect(updateResponse.status).toBe(200);

    // Verify the changes by getting the conversation details
    const getResponse: Response = await agent.get(`/api/v3/conversations?conversation_id=${conversationId}`);

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toBeDefined();
    const conversation = getResponse.body as Conversation;
    expect(conversation.bgcolor).toBeNull();
    expect(conversation.help_color).toBeNull();
  });

  test('should fail when updating conversation without permission', async () => {
    // Create another user without permission to update the conversation
    const unauthorizedUser: TestUser = generateTestUser();
    const { textAgent: unauthorizedAgent } = await registerAndLoginUser(unauthorizedUser);

    // Attempt to update the conversation
    const updateData: ConversationUpdateData = {
      conversation_id: conversationId,
      topic: 'Unauthorized Topic Update'
    };

    const updateResponse: Response = await updateConversation(unauthorizedAgent, updateData);

    // Verify update fails with permission error
    expect(updateResponse.status).toBe(403);
    expect(updateResponse.text).toMatch(/polis_err_update_conversation_permission/);
  });
});