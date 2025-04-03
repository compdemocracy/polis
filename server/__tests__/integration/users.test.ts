import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  getTestAgent,
  getTextAgent,
  initializeParticipantWithXid,
  newAgent,
  newTextAgent,
  setupAuthAndConvo,
  submitVote
} from '../setup/api-test-helpers';
import { findEmailByRecipient } from '../setup/email-helpers';
import type { Response } from 'supertest';
import type { TestUser } from '../../types/test-helpers';
import { Agent } from 'supertest';

interface EmailResult {
  subject: string;
  html?: string;
  text?: string;
  [key: string]: any;
}

interface UserInfo {
  uid: number;
  email: string;
  hname: string;
  hasXid?: boolean;
  [key: string]: any;
}

describe('User Management Endpoints', () => {
  // Declare agent variables
  let agent: Agent;
  let textAgent: Agent;
  
  // Initialize agents before running tests
  beforeAll(async () => {
    agent = await getTestAgent();
    textAgent = await getTextAgent();
  });

  let ownerUserId: number;
  let testUser: TestUser;
  let conversationId: string;

  // Setup - Create a test user with admin privileges and a conversation
  beforeAll(async () => {
    // Setup auth and create test conversation
    const setup = await setupAuthAndConvo({ commentCount: 3 });
    ownerUserId = setup.userId;
    testUser = setup.testUser;
    conversationId = setup.conversationId;
  });

  describe('GET /users', () => {
    test('should get the current user info when authenticated', async () => {
      const response: Response = await agent.get('/api/v3/users');

      expect(response.status).toBe(200);
      const userInfo = response.body as UserInfo;
      expect(userInfo).toHaveProperty('uid', ownerUserId);
      expect(userInfo).toHaveProperty('email', testUser.email);
      expect(userInfo).toHaveProperty('hname', testUser.hname);
    });

    test('should require authentication when errIfNoAuth is true', async () => {
      // Create a new agent without auth
      const unauthAgent = await newTextAgent();
      const response: Response = await unauthAgent.get('/api/v3/users?errIfNoAuth=true');

      // The server responds with 401 (authorization required)
      expect(response.status).toBe(401);

      // Check for error message in text
      expect(response.text).toMatch(/polis_error_auth_needed/);
    });

    test('should return empty response for anonymous users when errIfNoAuth is false', async () => {
      // Create a new agent without auth
      const unauthAgent = await newAgent();
      const response: Response = await unauthAgent.get('/api/v3/users?errIfNoAuth=false');

      expect(response.status).toBe(200);

      // Legacy API returns an empty object for anonymous users
      expect(response.body).toEqual({});
    });

    test('should handle user lookup by XID', async () => {
      // Create a random XID for testing
      const testXid = `test-xid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      // Initialize an XID-based participant in the conversation
      const { agent: xidAgent, body, status } = await initializeParticipantWithXid(conversationId, testXid);

      expect(status).toBe(200);
      expect(body).toHaveProperty('nextComment');
      const nextComment = body.nextComment;
      expect(nextComment).toBeDefined();
      expect(nextComment.tid).toBeDefined();

      // Vote to establish the xid user in the conversation
      await submitVote(xidAgent, {
        conversation_id: conversationId,
        vote: -1, // upvote
        tid: nextComment.tid,
        xid: testXid
      });

      const lookupResponse: Response = await agent.get(`/api/v3/users?owner_uid=${ownerUserId}&xid=${testXid}`);

      expect(lookupResponse.status).toBe(200);

      // Returns the caller's user info, not the xid user info
      // This is a legacy behavior, and is not what we want.
      const userInfo = lookupResponse.body as UserInfo;
      expect(userInfo).toHaveProperty('email', testUser.email);
      expect(userInfo).toHaveProperty('hasXid', false);
      expect(userInfo).toHaveProperty('hname', testUser.hname);
      expect(userInfo).toHaveProperty('uid', ownerUserId);
    });
  });

  describe('PUT /users', () => {
    test('should update user information', async () => {
      const newName = `Updated Test User ${Date.now()}`;

      const response: Response = await agent.put('/api/v3/users').send({
        hname: newName
      });

      expect(response.status).toBe(200);

      // Verify the update by getting user info
      const userInfo: Response = await agent.get('/api/v3/users');
      expect(userInfo.status).toBe(200);
      expect(userInfo.body).toHaveProperty('hname', newName);
    });

    test('should require authentication', async () => {
      // Use an unauthenticated agent
      const unauthAgent = await newAgent();
      const response: Response = await unauthAgent.put('/api/v3/users').send({
        hname: 'Unauthenticated Update'
      });

      expect(response.status).toBe(500);
      expect(response.text).toMatch(/polis_err_auth_token_not_supplied/);
    });

    test('should validate email format', async () => {
      const response: Response = await textAgent.put('/api/v3/users').send({
        email: 'invalid-email'
      });

      // The server should reject invalid email formats
      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_parse_failed_email/);
      expect(response.text).toMatch(/polis_fail_parse_email/);
    });
  });

  describe('POST /users/invite', () => {
    test('should send invites to a conversation', async () => {
      const timestamp = Date.now();
      // NOTE: The DB restricts emails to 32 characters!
      const testEmails = [`invite.${timestamp}.1@test.com`, `invite.${timestamp}.2@test.com`];

      const response: Response = await agent.post('/api/v3/users/invite').send({
        conversation_id: conversationId,
        emails: testEmails.join(',')
      });

      expect(response.status).toBe(200);
      // The legacy server returns a 200 with a status property of ':-)'. Yep.
      expect(response.body).toHaveProperty('status', ':-)');

      // Find the emails in MailDev
      const email1 = await findEmailByRecipient(testEmails[0]) as EmailResult | null;
      const email2 = await findEmailByRecipient(testEmails[1]) as EmailResult | null;

      // Test should fail if we don't find both emails
      if (!email1) {
        throw new Error(
          `Email verification failed: No email found for recipient ${testEmails[0]}. Is MailDev running?`
        );
      }
      if (!email2) {
        throw new Error(
          `Email verification failed: No email found for recipient ${testEmails[1]}. Is MailDev running?`
        );
      }

      // Verify email content
      expect(email1.subject).toMatch(/Join the pol.is conversation!/i);
      expect(email1.html || email1.text).toContain(conversationId);

      expect(email2.subject).toMatch(/Join the pol.is conversation!/i);
      expect(email2.html || email2.text).toContain(conversationId);
    });

    test('should require authentication', async () => {
      // Use an unauthenticated agent
      const unauthAgent = await newAgent();
      const response: Response = await unauthAgent.post('/api/v3/users/invite').send({
        conversation_id: conversationId,
        emails: `unauthenticated.${Date.now()}@example.com`
      });

      expect(response.status).toBe(500);
      expect(response.text).toMatch(/polis_err_auth_token_not_supplied/);
    });

    test('should require valid conversation ID', async () => {
      const response: Response = await textAgent.post('/api/v3/users/invite').send({
        conversation_id: 'invalid-conversation-id',
        emails: `invalid-convo.${Date.now()}@example.com`
      });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_parse_failed_conversation_id/);
      expect(response.text).toMatch(/polis_err_fetching_zid_for_conversation_id/);
    });

    test('should require email addresses', async () => {
      const response: Response = await textAgent.post('/api/v3/users/invite').send({
        conversation_id: conversationId
      });

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_emails/);
    });

    test('should validate email format', async () => {
      const response: Response = await agent.post('/api/v3/users/invite').send({
        conversation_id: conversationId,
        emails: 'invalid-email'
      });

      // The server should reject invalid email formats
      // However, the legacy server just returns a 200
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', ':-)');
    });
  });
});
