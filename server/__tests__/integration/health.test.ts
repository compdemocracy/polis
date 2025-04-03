import { describe, expect, test, beforeAll } from '@jest/globals';
import { newAgent } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import { Agent } from 'supertest';

describe('Health Check Endpoints', () => {
  // Create a dedicated agent for this test suite
  let agent: Agent;
  
  // Initialize agent before tests run
  beforeAll(async () => {
    // Initialize the agent asynchronously
    agent = await newAgent();
    console.log('Agent created, ready to run health tests.');
  });

  describe('GET /api/v3/testConnection', () => {
    test('should return 200 OK', async () => {
      const response: Response = await agent
        .get('/api/v3/testConnection');
      
      console.log('Response:', response.status, response.body);
      
      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /api/v3/testDatabase', () => {
    test('should return 200 OK when database is connected', async () => {
      const response: Response = await agent
        .get('/api/v3/testDatabase');
      
      console.log('Database Response:', response.status, response.body);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
      expect(response.body.status).toBe('ok');
    });
  });
});