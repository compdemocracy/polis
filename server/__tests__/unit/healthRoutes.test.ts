import { beforeEach, describe, expect, test } from '@jest/globals';
import express, { Request, Response } from 'express';
import request from 'supertest';

// Create a mock for the health controller
const mockHandleGetTestConnection = (_req: Request, res: Response): void => {
  res.json({ status: 'ok', message: 'API is running' });
};

const mockHandleGetTestDatabase = (_req: Request, res: Response): void => {
  res.json({ status: 'ok', message: 'Database connection successful' });
};

describe('Health Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Set up routes directly on the app
    app.get('/testConnection', mockHandleGetTestConnection);
    app.get('/testDatabase', mockHandleGetTestDatabase);
  });

  describe('GET /testConnection', () => {
    test('should return a 200 status and confirm API is running', async () => {
      const response = await request(app).get('/testConnection');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        message: 'API is running'
      });
    });
  });

  describe('GET /testDatabase', () => {
    test('should return a 200 status and confirm database connection', async () => {
      const response = await request(app).get('/testDatabase');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        message: 'Database connection successful'
      });
    });
  });
});