import { beforeAll, describe, expect, test } from '@jest/globals';
import { registerAndLoginUser } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { AuthData } from '../../types/test-helpers';

describe('Conversation Activity API', () => {
  let textAgent: Agent;

  beforeAll(async () => {
    // Register a regular user
    const auth: AuthData = await registerAndLoginUser();
    textAgent = auth.textAgent;
  });

  test('GET /api/v3/conversations/recent_activity - should return 403 for non-admin users', async () => {
    const response: Response = await textAgent.get('/api/v3/conversations/recent_activity');
    expect(response.status).toBe(403);
    expect(response.text).toContain('polis_err_no_access_for_this_user');
  });

  test('GET /api/v3/conversations/recently_started with sinceUnixTimestamp - should return 403', async () => {
    // Get current time in seconds
    const currentTimeInSeconds: number = Math.floor(Date.now() / 1000);
    const timeOneWeekAgo: number = currentTimeInSeconds - 7 * 24 * 60 * 60;

    const response: Response = await textAgent.get(`/api/v3/conversations/recently_started?sinceUnixTimestamp=${timeOneWeekAgo}`);
    expect(response.status).toBe(403);
    expect(response.text).toContain('polis_err_no_access_for_this_user');
  });
});