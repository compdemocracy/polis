import { beforeAll, describe, expect, test } from '@jest/globals';
import { createConversation, getTextAgent, registerAndLoginUser } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { AuthData } from '../../types/test-helpers';

interface ConversationPreloadResponse {
  conversation_id: string;
  topic: string;
  description: string;
  created: number;
  vis_type: number;
  write_type: number;
  help_type: number;
  socialbtn_type: number;
  bgcolor: string;
  help_color: string;
  help_bgcolor: string;
  style_btn: string;
  auth_needed_to_vote: boolean;
  auth_needed_to_write: boolean;
  auth_opt_allow_3rdparty: boolean;
  [key: string]: any;
}

describe('Conversation Preload API', () => {
  let agent: Agent;
  let textAgent: Agent;
  let conversationId: string;

  beforeAll(async () => {
    // Register a user (conversation owner)
    const auth: AuthData = await registerAndLoginUser();
    agent = auth.agent;
    textAgent = await getTextAgent();

    // Create a conversation
    conversationId = await createConversation(agent);
  });

  test('GET /api/v3/conversations/preload - should return preload info for a conversation', async () => {
    const response: Response = await agent.get(`/api/v3/conversations/preload?conversation_id=${conversationId}`);
    const { body, status } = response;

    // Should return successful response
    expect(status).toBe(200);

    const preloadInfo = body as ConversationPreloadResponse;
    expect(preloadInfo).toHaveProperty('conversation_id', conversationId);
    expect(preloadInfo).toHaveProperty('topic');
    expect(preloadInfo).toHaveProperty('description');
    expect(preloadInfo).toHaveProperty('created');
    expect(preloadInfo).toHaveProperty('vis_type');
    expect(preloadInfo).toHaveProperty('write_type');
    expect(preloadInfo).toHaveProperty('help_type');
    expect(preloadInfo).toHaveProperty('socialbtn_type');
    expect(preloadInfo).toHaveProperty('bgcolor');
    expect(preloadInfo).toHaveProperty('help_color');
    expect(preloadInfo).toHaveProperty('help_bgcolor');
    expect(preloadInfo).toHaveProperty('style_btn');
    expect(preloadInfo).toHaveProperty('auth_needed_to_vote', false);
    expect(preloadInfo).toHaveProperty('auth_needed_to_write', false);
    expect(preloadInfo).toHaveProperty('auth_opt_allow_3rdparty', true);
  });

  test('GET /api/v3/conversations/preload - should return 500 with invalid conversation_id', async () => {
    const response: Response = await textAgent.get('/api/v3/conversations/preload?conversation_id=invalid_id');

    // Should return error response
    expect(response.status).toBe(500);
    expect(response.text).toContain('polis_err_get_conversation_preload_info');
  });

  test('GET /api/v3/conversations/preload - should return 500 with non-existent conversation_id', async () => {
    const response: Response = await textAgent.get('/api/v3/conversations/preload?conversation_id=99999999');

    // Should return error response
    expect(response.status).toBe(500);
    expect(response.text).toContain('polis_err_get_conversation_preload_info');
  });

  test('GET /api/v3/conversations/preload - should require conversation_id parameter', async () => {
    const response: Response = await textAgent.get('/api/v3/conversations/preload');

    // Should return error response
    expect(response.status).toBe(400);
    expect(response.text).toContain('polis_err_param_missing_conversation_id');
  });
});