import { beforeEach, describe, expect, test } from '@jest/globals';
import { generateTestUser, newAgent, registerAndLoginUser } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { AuthData } from '../../types/test-helpers';
import { Agent } from 'supertest';

interface DomainWhitelistResponse {
  domain_whitelist: string;
}

describe('Domain Whitelist API', () => {
  let agent: Agent;

  // Setup with a registered and authenticated user
  beforeEach(async () => {
    const testUser = generateTestUser();
    const auth: AuthData = await registerAndLoginUser(testUser);
    agent = auth.agent;
  });

  test('GET /domainWhitelist - should retrieve domain whitelist settings for auth user', async () => {
    const response: Response = await agent.get('/api/v3/domainWhitelist');

    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // Domain whitelist is returned as a list of domains or an empty string
    expect(response.body).toHaveProperty('domain_whitelist');
    expect((response.body as DomainWhitelistResponse).domain_whitelist).toEqual('');
  });

  test('GET /domainWhitelist - authentication behavior', async () => {
    // Create an unauthenticated agent
    const unauthAgent = await newAgent();

    const response: Response = await unauthAgent.get('/api/v3/domainWhitelist');

    expect(response.status).toBe(500);
    expect(response.text).toMatch(/polis_err_auth_token_not_supplied/);
  });

  test('POST /domainWhitelist - should update domain whitelist settings', async () => {
    const testDomains = 'example.com,test.org';

    // Update whitelist
    const updateResponse: Response = await agent.post('/api/v3/domainWhitelist').send({
      domain_whitelist: testDomains
    });

    expect(updateResponse.status).toBe(200);

    // Verify update was successful by getting the whitelist
    const getResponse: Response = await agent.get('/api/v3/domainWhitelist');

    expect(getResponse.status).toBe(200);
    expect((getResponse.body as DomainWhitelistResponse)).toHaveProperty('domain_whitelist', testDomains);
  });

  test('POST /domainWhitelist - should accept empty domain whitelist', async () => {
    // Update with empty whitelist
    const updateResponse: Response = await agent.post('/api/v3/domainWhitelist').send({
      domain_whitelist: ''
    });

    expect(updateResponse.status).toBe(200);

    // Verify update
    const getResponse: Response = await agent.get('/api/v3/domainWhitelist');

    expect(getResponse.status).toBe(200);
    expect((getResponse.body as DomainWhitelistResponse)).toHaveProperty('domain_whitelist', '');
  });

  // Note: The API doesn't validate domain format
  // This test documents the current behavior rather than the expected behavior
  test('POST /domainWhitelist - domain format validation behavior', async () => {
    // Test with invalid domain format
    const invalidResponse: Response = await agent.post('/api/v3/domainWhitelist').send({
      domain_whitelist: 'invalid domain with spaces'
    });

    // Current behavior: The API accepts invalid domain formats
    expect(invalidResponse.status).toBe(200);

    const getResponse: Response = await agent.get('/api/v3/domainWhitelist');

    expect(getResponse.status).toBe(200);
    expect((getResponse.body as DomainWhitelistResponse)).toHaveProperty('domain_whitelist', 'invalid domain with spaces');
  });

  test('POST /domainWhitelist - authentication behavior', async () => {
    const unauthAgent = await newAgent();

    const response: Response = await unauthAgent.post('/api/v3/domainWhitelist').send({
      domain_whitelist: 'example.com'
    });

    expect(response.status).toBe(500);
    expect(response.text).toMatch(/polis_err_auth_token_not_supplied/);
  });
});