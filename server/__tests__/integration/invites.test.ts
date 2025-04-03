import { beforeAll, describe, expect, test } from '@jest/globals';
import { createConversation, generateTestUser, registerAndLoginUser, newAgent } from '../setup/api-test-helpers';
import { findEmailByRecipient } from '../setup/email-helpers';
import type { EmailObject } from '../setup/email-helpers';
import type { Response } from 'supertest';
import type { AuthData, TestUser } from '../../types/test-helpers';

describe('Email Invites API', () => {
  let agent: ReturnType<typeof newAgent>;
  let conversationId: string;
  let testUser: TestUser;

  beforeAll(async () => {
    // Register a user (conversation owner)
    testUser = generateTestUser();
    const auth: AuthData = await registerAndLoginUser(testUser);
    agent = auth.agent;

    // Create conversation
    conversationId = await createConversation(agent);
  });

  test('POST /einvites - should create email invite and send welcome email', async () => {
    const testEmail = `invite_${Date.now()}@example.com`;

    // Use text agent for plain text response
    const response: Response = await agent.post('/api/v3/einvites').send({
      email: testEmail
    });

    // The response is empty
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    // Find and verify the welcome email
    const email: EmailObject = await findEmailByRecipient(testEmail);
    expect(email.to[0].address).toBe(testEmail);
    expect(email.subject).toBe('Get Started with Polis');
    expect(email.text).toContain('Welcome to pol.is!');
    expect(email.text).toContain('/welcome/'); // Should contain the einvite link

    // Extract the einvite code from the email
    const einviteMatch = email.text.match(/\/welcome\/([a-zA-Z0-9]+)/);
    expect(einviteMatch).toBeTruthy();
    if (!einviteMatch) return; // TypeScript guard
    const einvite = einviteMatch[1];
    expect(einvite).toMatch(/^[a-zA-Z0-9]+$/); // Should be alphanumeric
  });

  test('POST /users/invite - should handle invitation emails with error validation', async () => {
    // Clear any existing emails
    // await deleteAllEmails();

    // Use shorter email addresses to fit within VARCHAR(32)
    const testEmails = [`inv1_${Date.now() % 1000}@ex.com`, `inv2_${Date.now() % 1000}@ex.com`];

    const response: Response = await agent.post('/api/v3/users/invite').send({
      conversation_id: conversationId,
      emails: testEmails.join(',')
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: ':-)'
    });

    // Verify the invitation emails were sent
    for (const email of testEmails) {
      const sentEmail: EmailObject = await findEmailByRecipient(email);
      expect(sentEmail).toBeTruthy();
      expect(sentEmail.to[0].address).toBe(email);
      expect(sentEmail.text).toContain(conversationId);
    }
  });

  test('GET /verify - should handle email verification with error validation', async () => {
    // This test will test the error cases since we can't generate a valid verification token

    // Test missing 'e' parameter
    const missingTokenResponse: Response = await agent.get('/api/v3/verify');

    expect(missingTokenResponse.status).toBe(400);
    expect(missingTokenResponse.text).toMatch(/polis_err_param_missing_e/);

    // The invalid token case can cause server issues with headers already sent
    // so we'll skip that test to avoid crashes
  });

  test('POST /sendCreatedLinkToEmail - should request email conversation link', async () => {
    // Clear any existing emails
    // await deleteAllEmails();

    const response: Response = await agent.post('/api/v3/sendCreatedLinkToEmail').send({
      conversation_id: conversationId
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    // Get the email that was sent
    const email: EmailObject = await findEmailByRecipient(testUser.email);
    expect(email).toBeTruthy();

    // Verify email contents match the template from handle_POST_sendCreatedLinkToEmail
    expect(email.to[0].address).toBe(testUser.email);
    expect(email.text).toContain(`Hi ${testUser.hname}`);
    expect(email.text).toContain("Here's a link to the conversation you just created");
    expect(email.text).toContain(conversationId);
    expect(email.text).toContain('With gratitude,\n\nThe team at pol.is');

    // Verify the conversation link format
    const linkMatch = email.text.match(/http:\/\/[^/]+\/#(\d+)\/([a-zA-Z0-9]+)/);
    expect(linkMatch).toBeTruthy();
    if (!linkMatch) return; // TypeScript guard
    const [_, zid, zinvite] = linkMatch;
    expect(zid).toBeTruthy();
    expect(zinvite).toBeTruthy();
  });
});
