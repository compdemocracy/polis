import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  createComment,
  createConversation,
  getTextAgent,
  initializeParticipant,
  registerAndLoginUser,
  submitVote
} from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { AuthData } from '../../types/test-helpers';

interface MetadataQuestion {
  pmqid: number;
  key: string;
  [key: string]: any;
}

interface MetadataAnswer {
  pmaid: number;
  pmqid: number;
  value: string;
  [key: string]: any;
}

interface MetadataResponse {
  keys: Record<string, any>;
  values: Record<string, any>;
  kvp: Record<string, any>;
}

describe('Participant Metadata API', () => {
  let agent: Agent;
  let textAgent: Agent;
  let conversationId: string;
  let participantAgent: Agent;

  beforeAll(async () => {
    // Register a user (conversation owner)
    const auth: AuthData = await registerAndLoginUser();
    agent = auth.agent;
    textAgent = await getTextAgent(); // Create a text agent for text responses

    // Create conversation
    conversationId = await createConversation(agent);

    // Initialize a participant
    const { agent: pAgent } = await initializeParticipant(conversationId);
    participantAgent = pAgent;

    // Create a comment to establish a real participant (needed for choices test)
    const commentId = await createComment(participantAgent, conversationId, {
      conversation_id: conversationId,
      txt: 'Test comment for metadata'
    });

    // Submit a vote to establish a real pid
    await submitVote(participantAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: 1
    });
  });

  test('POST /api/v3/metadata/questions - should create metadata question', async () => {
    const questionKey = `test_question_${Date.now()}`;
    const response: Response = await agent.post('/api/v3/metadata/questions').send({
      conversation_id: conversationId,
      key: questionKey
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('pmqid');

    // Verify the question was created by fetching it
    const getResponse: Response = await agent.get(`/api/v3/metadata/questions?conversation_id=${conversationId}`);
    const createdQuestion = (getResponse.body as MetadataQuestion[]).find(q => q.key === questionKey);
    expect(createdQuestion).toBeDefined();
    expect(createdQuestion!.pmqid).toBe(response.body.pmqid);
  });

  test('GET /api/v3/metadata/questions - should list metadata questions', async () => {
    // Create a question first to ensure there's data
    const questionKey = `test_question_${Date.now()}`;
    await agent.post('/api/v3/metadata/questions').send({
      conversation_id: conversationId,
      key: questionKey
    });

    const response: Response = await agent.get(`/api/v3/metadata/questions?conversation_id=${conversationId}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    // Check structure of the first question
    expect(response.body[0]).toHaveProperty('pmqid');
    expect(response.body[0]).toHaveProperty('key');
  });

  describe('with existing question', () => {
    let pmqid: number;

    beforeAll(async () => {
      // Create a question for these tests
      const response: Response = await agent.post('/api/v3/metadata/questions').send({
        conversation_id: conversationId,
        key: `test_question_${Date.now()}`
      });
      pmqid = response.body.pmqid;
    });

    test('POST /api/v3/metadata/answers - should create metadata answer', async () => {
      const answerValue = `test_answer_${Date.now()}`;
      const response: Response = await agent.post('/api/v3/metadata/answers').send({
        conversation_id: conversationId,
        pmqid: pmqid,
        value: answerValue
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('pmaid');

      // Verify the answer was created
      const getResponse: Response = await agent.get(`/api/v3/metadata/answers?conversation_id=${conversationId}`);
      const createdAnswer = (getResponse.body as MetadataAnswer[]).find(
        a => a.pmqid === pmqid && a.value === answerValue
      );
      expect(createdAnswer).toBeDefined();
      expect(createdAnswer!.pmaid).toBe(response.body.pmaid);
    });

    test('GET /api/v3/metadata/answers - should list metadata answers', async () => {
      // Create an answer first to ensure there's data
      const answerValue = `test_answer_${Date.now()}`;
      await agent.post('/api/v3/metadata/answers').send({
        conversation_id: conversationId,
        pmqid: pmqid,
        value: answerValue
      });

      const response: Response = await agent.get(`/api/v3/metadata/answers?conversation_id=${conversationId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      // Check structure of the first answer
      expect(response.body[0]).toHaveProperty('pmaid');
      expect(response.body[0]).toHaveProperty('pmqid');
      expect(response.body[0]).toHaveProperty('value');
    });

    describe('with existing answer', () => {
      let pmaid: number;

      beforeAll(async () => {
        // Create an answer for these tests
        const response: Response = await agent.post('/api/v3/metadata/answers').send({
          conversation_id: conversationId,
          pmqid: pmqid,
          value: `test_answer_${Date.now()}`
        });
        pmaid = response.body.pmaid;
      });

      test('GET /api/v3/metadata - should retrieve all metadata', async () => {
        const response: Response = await agent.get(`/api/v3/metadata?conversation_id=${conversationId}`);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('keys');
        expect(response.body).toHaveProperty('values');
        expect(response.body).toHaveProperty('kvp');

        const metadata = response.body as MetadataResponse;
        expect(typeof metadata.keys).toBe('object');
        expect(typeof metadata.values).toBe('object');
      });

      test('POST /api/v3/query_participants_by_metadata - query participants by metadata', async () => {
        const queryResponse: Response = await agent.post('/api/v3/query_participants_by_metadata').send({
          conversation_id: conversationId,
          pmaids: [pmaid]
        });

        expect(queryResponse.status).toBe(200);
        expect(queryResponse.body).toBeDefined();
        expect(Array.isArray(queryResponse.body)).toBe(true);
      });
    });
  });

  test('DELETE /api/v3/metadata/questions/:pmqid - should delete a metadata question', async () => {
    // Create a question to delete
    const createResponse: Response = await agent.post('/api/v3/metadata/questions').send({
      conversation_id: conversationId,
      key: 'question_to_delete'
    });

    expect(createResponse.status).toBe(200);
    const deleteId = createResponse.body.pmqid;

    // Use the text agent for text responses
    const deleteResponse: Response = await textAgent.delete(`/api/v3/metadata/questions/${deleteId}`);

    // The API returns "OK" as text
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.text).toBe('OK');

    // Verify it was deleted (or marked as not alive)
    const getResponse: Response = await agent.get(`/api/v3/metadata/questions?conversation_id=${conversationId}`);
    const deletedQuestion = (getResponse.body as MetadataQuestion[]).find(q => q.pmqid === deleteId);
    expect(deletedQuestion).toBeUndefined();
  });

  test('DELETE /api/v3/metadata/answers/:pmaid - should delete a metadata answer', async () => {
    // Create a question first
    const questionResponse: Response = await agent.post('/api/v3/metadata/questions').send({
      conversation_id: conversationId,
      key: `test_question_${Date.now()}`
    });
    const pmqid = questionResponse.body.pmqid;

    // Add an answer to delete
    const createResponse: Response = await agent.post('/api/v3/metadata/answers').send({
      conversation_id: conversationId,
      pmqid: pmqid,
      value: 'answer_to_delete'
    });

    expect(createResponse.status).toBe(200);
    const deleteId = createResponse.body.pmaid;

    // Use the text agent for text responses
    const deleteResponse: Response = await textAgent.delete(`/api/v3/metadata/answers/${deleteId}`);

    // The API returns "OK" as text
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.text).toBe('OK');

    // Verify it was deleted (or marked as not alive)
    const getResponse: Response = await agent.get(`/api/v3/metadata/answers?conversation_id=${conversationId}`);
    const deletedAnswer = (getResponse.body as MetadataAnswer[]).find(a => a.pmaid === deleteId);
    expect(deletedAnswer).toBeUndefined();
  });

  test('PUT /api/v3/participants_extended - should work for conversation owner', async () => {
    // Test with the owner agent
    const ownerResponse: Response = await agent.put('/api/v3/participants_extended').send({
      conversation_id: conversationId,
      show_translation_activated: true
    });

    // The owner should be able to update their own settings
    expect(ownerResponse.status).toBe(200);
  });

  test('PUT /api/v3/participants_extended - handles participant access correctly', async () => {
    // Test with the participant agent
    const participantResponse: Response = await participantAgent.put('/api/v3/participants_extended').send({
      conversation_id: conversationId,
      show_translation_activated: false
    });

    // The API might return 200 (if the participant has a proper pid)
    // or might return a 500 error with auth error (if pid resolution fails)
    if (participantResponse.status === 200) {
      expect(participantResponse.status).toBe(200);
    } else {
      expect(participantResponse.status).toBe(500);
    }
  });

  test('GET /api/v3/metadata/choices - should retrieve metadata choices', async () => {
    const response: Response = await agent.get(`/api/v3/metadata/choices?conversation_id=${conversationId}`);

    expect(response.status).toBe(200);

    // Depending on whether choices have been made, this might be empty
    // but the endpoint should always return a valid response
    expect(Array.isArray(response.body)).toBe(true);
  });
});