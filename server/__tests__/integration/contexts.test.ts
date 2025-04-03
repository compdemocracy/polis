import { describe, expect, test, beforeAll } from '@jest/globals';
import { generateTestUser, newAgent, registerAndLoginUser, getTestAgent } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { AuthData } from '../../types/test-helpers';
import { Agent } from 'supertest';

interface Context {
  name: string;
  [key: string]: any;
}

describe('GET /contexts', () => {
  let agent: Agent;

  // Initialize the agent before tests run
  beforeAll(async () => {
    agent = await newAgent();
  });

  test('Returns available contexts to anonymous users', async () => {
    // Call the contexts endpoint
    const response: Response = await agent.get('/api/v3/contexts');

    // Verify response status is 200
    expect(response.status).toBe(200);

    // Verify response contains expected keys
    expect(response.body).toBeDefined();
    expect(Array.isArray(response.body)).toBe(true);

    // Each context should have basic properties
    if (response.body.length > 0) {
      const context = response.body[0] as Context;
      expect(context).toHaveProperty('name');
    }
  });

  test('Returns available contexts to authenticated users', async () => {
    // Register and login a test user
    const testUser = generateTestUser();
    const auth: AuthData = await registerAndLoginUser(testUser);
    const authAgent = auth.agent;

    // Call the contexts endpoint with authentication
    const response: Response = await authAgent.get('/api/v3/contexts');

    // Verify response status is 200
    expect(response.status).toBe(200);

    // Verify response contains an array of contexts
    expect(Array.isArray(response.body)).toBe(true);

    // Each context should have basic properties
    if (response.body.length > 0) {
      const context = response.body[0] as Context;
      expect(context).toHaveProperty('name');
    }
  });
});