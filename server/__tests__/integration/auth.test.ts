import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  extractCookieValue,
  generateTestUser,
  getTestAgent,
  getTextAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo,
  submitVote
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { TestUser, VoteResponse as ActualVoteResponse } from '../../types/test-helpers';
import { Agent } from 'supertest';

interface UserResponse {
  uid: number;
  email: string;
  hname?: string;
  [key: string]: any;
}

interface ParticipantResponse {
  agent: Agent;
  body: {
    conversation: {
      conversation_id: string;
      [key: string]: any;
    };
    nextComment: {
      tid: number;
      [key: string]: any;
    };
    [key: string]: any;
  };
  cookies: string[] | string | undefined;
  status: number;
}

describe('Authentication with Supertest', () => {
  // Define agents
  let agent: Agent;
  let textAgent: Agent;
  const testUser: TestUser = generateTestUser();
  
  // Initialize agents before tests
  beforeAll(async () => {
    agent = await getTestAgent();
    textAgent = await getTextAgent();
  });

  describe('Login Endpoint', () => {
    test('should validate login parameters', async () => {
      // Test missing password
      const noPasswordResponse: Response = await textAgent.post('/api/v3/auth/login').send({});
      expect(noPasswordResponse.status).toBe(400);
      expect(noPasswordResponse.text).toContain('polis_err_param_missing_password');

      // Test missing email
      const noEmailResponse: Response = await textAgent.post('/api/v3/auth/login').send({ password: 'testpass' });
      expect(noEmailResponse.status).toBe(403);
      expect(noEmailResponse.text).toMatch(/polis_err_login_unknown_user_or_password_noresults/);

      // Test invalid credentials
      const invalidResponse: Response = await textAgent.post('/api/v3/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'wrongpassword'
      });
      expect(invalidResponse.status).toBe(403);
      expect(invalidResponse.text).toContain('polis_err_login_unknown_user_or_password');
    });
  });

  describe('Registration Endpoint', () => {
    const validRegistration = {
      email: `test-${Date.now()}@example.com`,
      password: 'testPassword123!',
      password2: 'testPassword123!',
      hname: 'Test User',
      gatekeeperTosPrivacy: true
    };

    test('should validate registration parameters', async () => {
      // Test password mismatch
      const mismatchResponse: Response = await textAgent.post('/api/v3/auth/new').send({
        ...validRegistration,
        password2: 'DifferentPassword123!'
      });
      expect(mismatchResponse.status).toBe(400);
      expect(mismatchResponse.text).toContain('Passwords do not match');

      // Test missing required fields
      const missingFieldsResponse: Response = await textAgent.post('/api/v3/auth/new').send({
        email: validRegistration.email
      });
      expect(missingFieldsResponse.status).toBe(400);
      expect(missingFieldsResponse.text).toContain('polis_err_reg_need_tos');

      // Test terms not accepted
      const noTosResponse: Response = await textAgent.post('/api/v3/auth/new').send({
        ...validRegistration,
        gatekeeperTosPrivacy: false
      });
      expect(noTosResponse.status).toBe(400);
      expect(noTosResponse.text).toContain('polis_err_reg_need_tos');
    });
  });

  describe('Deregister (Logout) Endpoint', () => {
    test('should handle logout parameters', async () => {
      // Test missing showPage
      const noShowPageResponse: Response = await textAgent.post('/api/v3/auth/deregister').send({});
      expect(noShowPageResponse.status).toBe(200);

      // Test null showPage
      const nullShowPageResponse: Response = await textAgent.post('/api/v3/auth/deregister').send({
        showPage: null
      });
      expect(nullShowPageResponse.status).toBe(200);
    });
  });

  describe('Register-Login Flow', () => {
    test('should complete full registration and login flow', async () => {
      // STEP 1: Register a new user
      const registerResponse: Response = await agent.post('/api/v3/auth/new').send({
        email: testUser.email,
        password: testUser.password,
        password2: testUser.password,
        hname: testUser.hname,
        gatekeeperTosPrivacy: true
      });

      expect(registerResponse.status).toBe(200);
      const registerBody = JSON.parse(registerResponse.text) as UserResponse;
      expect(registerBody).toHaveProperty('uid');
      expect(registerBody).toHaveProperty('email', testUser.email);
      const userId = registerBody.uid;

      // STEP 2: Login with registered user
      const loginResponse: Response = await agent.post('/api/v3/auth/login').send({
        email: testUser.email,
        password: testUser.password
      });

      expect(loginResponse.status).toBe(200);
      const loginBody = JSON.parse(loginResponse.text) as UserResponse;
      expect(loginBody).toHaveProperty('uid', userId);
      expect(loginBody).toHaveProperty('email', testUser.email);

      const authCookies = loginResponse.headers['set-cookie'];
      expect(authCookies).toBeDefined();
      expect(authCookies!.length).toBeGreaterThan(0);

      const token = extractCookieValue(authCookies, 'token2');
      expect(token).toBeDefined();
    });
  });

  describe('Complete Auth Flow', () => {
    test('should handle complete auth lifecycle', async () => {
      const completeFlowUser: TestUser = generateTestUser();

      // STEP 1: Register new user
      const registerResponse: Response = await agent.post('/api/v3/auth/new').send({
        email: completeFlowUser.email,
        password: completeFlowUser.password,
        password2: completeFlowUser.password,
        hname: completeFlowUser.hname,
        gatekeeperTosPrivacy: true
      });

      expect(registerResponse.status).toBe(200);
      const registerBody = JSON.parse(registerResponse.text) as UserResponse;
      expect(registerBody).toHaveProperty('uid');

      // STEP 2: Login user (agent maintains cookies)
      const loginResponse: Response = await agent.post('/api/v3/auth/login').send({
        email: completeFlowUser.email,
        password: completeFlowUser.password
      });

      expect(loginResponse.status).toBe(200);
      const authCookies = loginResponse.headers['set-cookie'];
      expect(authCookies).toBeDefined();
      expect(authCookies!.length).toBeGreaterThan(0);

      // STEP 3: Logout user
      const logoutResponse: Response = await textAgent.post('/api/v3/auth/deregister').send({});
      expect(logoutResponse.status).toBe(200);

      // STEP 4: Verify protected resource access fails
      const protectedResponse: Response = await textAgent.get('/api/v3/conversations');
      expect(protectedResponse.status).toBe(403);
      expect(protectedResponse.text).toContain('polis_err_need_auth');

      // STEP 5: Verify can login again
      const reloginResponse: Response = await agent.post('/api/v3/auth/login').send({
        email: completeFlowUser.email,
        password: completeFlowUser.password
      });

      expect(reloginResponse.status).toBe(200);
      expect(reloginResponse.headers['set-cookie']).toBeDefined();
      expect(reloginResponse.headers['set-cookie']!.length).toBeGreaterThan(0);
    });
  });

  describe('Participant Authentication', () => {
    let conversationId: string;
    let commentId: number;

    beforeAll(async () => {
      // Create owner and conversation using the agent helper function
      const setup = await setupAuthAndConvo();

      conversationId = setup.conversationId;
      commentId = setup.commentIds[0];
    });

    test('should initialize participant session', async () => {
      // Initialize participant
      const { body, cookies, status }: ParticipantResponse = await initializeParticipant(conversationId);

      expect(status).toBe(200);
      expect(cookies).toBeDefined();
      expect(cookies!.length).toBeGreaterThan(0);

      const pcCookie = extractCookieValue(cookies, 'pc');
      expect(pcCookie).toBeDefined();

      expect(body).toHaveProperty('conversation');
      expect(body).toHaveProperty('nextComment');
      expect(body.conversation.conversation_id).toBe(conversationId);
      expect(body.nextComment.tid).toBe(commentId);
    });

    test('should authenticate participant upon voting', async () => {
      // STEP 1: Initialize participant
      const { agent, cookies, status }: ParticipantResponse = await initializeParticipant(conversationId);

      expect(status).toBe(200);
      expect(cookies!.length).toBeGreaterThan(0);

      // STEP 2: Submit vote
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: -1
      });

      expect(voteResponse.status).toBe(200);

      expect(voteResponse.body).toHaveProperty('currentPid');

      // Verify participant cookies
      expect(voteResponse.cookies!.length).toBeGreaterThan(0);

      const uc = extractCookieValue(voteResponse.cookies, 'uc');
      const uid2 = extractCookieValue(voteResponse.cookies, 'uid2');
      const token2 = extractCookieValue(voteResponse.cookies, 'token2');

      expect(uc).toBeDefined();
      expect(uid2).toBeDefined();
      expect(token2).toBeDefined();
    });

    test('should initialize participant with XID', async () => {
      const xid = `test-xid-${Date.now()}`;
      const { agent, body, cookies, status }: ParticipantResponse = 
        await initializeParticipantWithXid(conversationId, xid);

      expect(status).toBe(200);
      expect(cookies!.length).toBeGreaterThan(0);

      expect(body).toHaveProperty('conversation');
      expect(body).toHaveProperty('nextComment');

      // Submit a vote to verify XID association works
      const voteResponse: ActualVoteResponse = await submitVote(agent, {
        conversation_id: conversationId,
        tid: commentId,
        vote: 1
      });

      expect(voteResponse.status).toBe(200);
    });
  });
});