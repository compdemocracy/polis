import { describe, expect, test, beforeAll } from '@jest/globals';
import request from 'supertest';
import type { Response } from 'supertest';
import { getApp } from '../app-loader';
import type { Express } from 'express';

describe('Simple Supertest Tests', () => {
  let app: Express;

  // Initialize the app before tests run
  beforeAll(async () => {
    app = await getApp();
  });

  test('Health check works', async () => {
    const response: Response = await request(app).get('/api/v3/testConnection');
    expect(response.status).toBe(200);
  });

  test('Basic auth check works', async () => {
    const response: Response = await request(app).post('/api/v3/auth/login').send({});
    expect(response.status).toBe(400);
    // Response should contain error about missing password
    expect(response.text).toContain('polis_err_param_missing_password');
  });
});
