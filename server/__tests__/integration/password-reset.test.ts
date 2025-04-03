import { beforeAll, describe, expect, test } from '@jest/globals';
import { generateTestUser, getTestAgent, getTextAgent, registerAndLoginUser } from '../setup/api-test-helpers';
import { getPasswordResetUrl } from '../setup/email-helpers';
import type { Response } from 'supertest';
import type { TestUser } from '../../types/test-helpers';
import { Agent } from 'supertest';

describe('Password Reset API', () => {
  // Declare agent variables
  let agent: Agent;
  let textAgent: Agent;
  let testUser: TestUser;
  
  // Setup - create a test user for password reset tests and clear mailbox
  beforeAll(async () => {
    // Initialize agents
    agent = await getTestAgent();
    textAgent = await getTextAgent();
    testUser = generateTestUser();

    // Register the user
    await registerAndLoginUser(testUser);
  });

  describe('POST /auth/pwresettoken', () => {
    test('should generate a password reset token for a valid email', async () => {
      const response: Response = await textAgent.post('/api/v3/auth/pwresettoken').send({
        email: testUser.email
      });

      // Check successful response
      expect(response.status).toBe(200);
      expect(response.text).toMatch(/Password reset email sent, please check your email./);
    });

    // Existence of an email address in the system should not be inferable from the response
    test('should behave normally for non-existent email', async () => {
      const nonExistentEmail = `nonexistent-${testUser.email}`;
      
      const response: Response = await textAgent.post('/api/v3/auth/pwresettoken').send({
        email: nonExistentEmail
      });

      // The API should return success even for non-existent emails
      expect(response.status).toBe(200);
      expect(response.text).toMatch(/Password reset email sent, please check your email./);
    });

    test('should return an error for missing email parameter', async () => {
      const response: Response = await textAgent.post('/api/v3/auth/pwresettoken').send({});

      expect(response.status).toBe(400);
      expect(response.text).toMatch(/polis_err_param_missing_email/);
    });
  });

  describe('Password Reset Flow', () => {
    const newPassword = 'NewTestPassword123!';

    test('should request a reset token, reset password, and login with new password', async () => {
      // Step 1: Request reset token
      const tokenResponse: Response = await agent.post('/api/v3/auth/pwresettoken').send({
        email: testUser.email
      });

      expect(tokenResponse.status).toBe(200);

      // Get the reset URL from the email
      const resetResult = await getPasswordResetUrl(testUser.email);

      expect(resetResult.url).toBeTruthy();
      expect(resetResult.token).toBeTruthy();
      const pwResetUrl = resetResult.url as string;
      const resetToken = resetResult.token as string;

      // Step 2: GET the reset page with token
      const url = new URL(pwResetUrl);
      const resetPageResponse: Response = await agent.get(url.pathname);
      expect(resetPageResponse.status).toBe(200);

      // Step 3: Submit the reset with new password
      const resetResponse: Response = await agent.post('/api/v3/auth/password').send({
        newPassword: newPassword,
        pwresettoken: resetToken
      });
      expect(resetResponse.status).toBe(200);

      // Step 4: Verify we can login with the new password
      const loginResponse: Response = await agent.post('/api/v3/auth/login').send({
        email: testUser.email,
        password: newPassword
      });

      expect(loginResponse.status).toBe(200);
      const cookies = loginResponse.headers['set-cookie'];
      expect(cookies).toBeTruthy();
      expect(Array.isArray(cookies)).toBe(true);
      const cookiesArray = (cookies as unknown) as string[];
      expect(cookiesArray.some((cookie) => cookie.startsWith('token2='))).toBe(true);
      expect(cookiesArray.some((cookie) => cookie.startsWith('uid2='))).toBe(true);
    });

    test('should reject reset attempts with invalid tokens', async () => {
      const invalidToken = `invalid_token_${Date.now()}`;

      const resetResponse: Response = await textAgent.post('/api/v3/auth/password').send({
        newPassword: 'AnotherPassword123!',
        pwresettoken: invalidToken
      });

      // Should be an error response
      expect(resetResponse.status).toBe(500);
      expect(resetResponse.text).toMatch(/Password Reset failed. Couldn't find matching pwresettoken./);
    });

    test('should reject reset attempts with missing parameters', async () => {
      // Missing token
      const resetResponse1: Response = await textAgent.post('/api/v3/auth/password').send({
        newPassword: 'AnotherPassword123!'
      });

      expect(resetResponse1.status).toBe(400);
      expect(resetResponse1.text).toMatch(/polis_err_param_missing_pwresettoken/);

      // Missing password
      const resetResponse2: Response = await textAgent.post('/api/v3/auth/password').send({
        pwresettoken: 'some_token'
      });

      expect(resetResponse2.status).toBe(400);
      expect(resetResponse2.text).toMatch(/polis_err_param_missing_newPassword/);
    });
  });
});
