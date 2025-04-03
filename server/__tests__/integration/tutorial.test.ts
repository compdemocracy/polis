import { describe, expect, test, beforeAll } from '@jest/globals';
import {
  generateTestUser,
  getTestAgent,
  getTextAgent,
  newAgent,
  registerAndLoginUser
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { TestUser } from '../../types/test-helpers';
import { Agent } from 'supertest';

describe('POST /tutorial', () => {
  let agent: Agent;
  let textAgent: Agent;

  // Initialize agents before running tests
  beforeAll(async () => {
    agent = await getTestAgent();
    textAgent = await getTextAgent();
  });

  test('should update tutorial step for authenticated user', async () => {
    // Register and login a user
    const testUser: TestUser = generateTestUser();
    await registerAndLoginUser(testUser);

    // Update tutorial step
    const response: Response = await agent.post('/api/v3/tutorial').send({ step: 1 });

    // Check response
    expect(response.status).toBe(200);
  });

  test('should require authentication', async () => {
    const testAgent = await newAgent();
    // Try to update tutorial step without authentication
    const response: Response = await testAgent.post('/api/v3/tutorial').send({ step: 1 });

    // Expect authentication error
    expect(response.status).toBe(500);
    expect(response.text).toContain('polis_err_auth_token_not_supplied');
  });

  test('should require valid step parameter', async () => {
    // Register and login a user
    const testUser: TestUser = generateTestUser();
    await registerAndLoginUser(testUser);

    // Try to update with invalid step
    const response: Response = await textAgent.post('/api/v3/tutorial').send({ step: 'invalid' });

    // Expect validation error
    expect(response.status).toBe(400);
    expect(response.text).toContain('polis_err_param_parse_failed_step');
    expect(response.text).toContain('polis_fail_parse_int invalid');
  });
});
