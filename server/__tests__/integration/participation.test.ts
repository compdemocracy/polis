import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  generateRandomXid,
  getTestAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  setupAuthAndConvo
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import { Agent } from 'supertest';

interface ParticipationResponse {
  agent: Agent;
  body: any;
  cookies: string[] | string | undefined;
  status: number;
}

describe('Participation Endpoints', () => {
  // Declare agent variable
  let agent: Agent;
  const testXid = generateRandomXid();
  let conversationId: string;

  beforeAll(async () => {
    // Initialize agent
    agent = await getTestAgent();
    
    // Setup auth and create test conversation with comments
    const setup = await setupAuthAndConvo({
      commentCount: 3
    });

    conversationId = setup.conversationId;
  });

  test('Regular participation lifecycle', async () => {
    // STEP 1: Initialize anonymous participant
    const { agent: anonAgent, body, cookies, status }: ParticipationResponse = await initializeParticipant(conversationId);

    expect(status).toBe(200);
    expect(cookies).toBeDefined();
    expect(cookies).toBeTruthy();
    expect(body).toBeDefined();

    // STEP 2: Get next comment for participant
    const nextCommentResponse: Response = await anonAgent.get(`/api/v3/nextComment?conversation_id=${conversationId}`);

    expect(nextCommentResponse.status).toBe(200);
    expect(JSON.parse(nextCommentResponse.text)).toBeDefined();
  });

  test('XID participation lifecycle', async () => {
    // STEP 1: Initialize participation with XID
    const { agent: xidAgent, body, cookies, status }: ParticipationResponse = await initializeParticipantWithXid(conversationId, testXid);

    expect(status).toBe(200);
    expect(cookies).toBeDefined();
    expect(cookies).toBeTruthy();
    expect(body).toBeDefined();

    // STEP 2: Get next comment for participant
    const nextCommentResponse: Response = await xidAgent.get(
      `/api/v3/nextComment?conversation_id=${conversationId}&xid=${testXid}`
    );

    expect(nextCommentResponse.status).toBe(200);
    expect(JSON.parse(nextCommentResponse.text)).toBeDefined();
  });

  test('Participation validation', async () => {
    // Test missing conversation ID in participation
    const missingConvResponse: Response = await agent.get('/api/v3/participation');
    expect(missingConvResponse.status).toBe(400);

    // Test missing conversation ID in participationInit
    const missingConvInitResponse: Response = await agent.get('/api/v3/participationInit');
    expect(missingConvInitResponse.status).toBe(200);
    const responseBody = JSON.parse(missingConvInitResponse.text);
    expect(responseBody).toBeDefined();
    expect(responseBody.conversation).toBeNull();
  });
});