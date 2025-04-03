import { beforeAll, describe, expect, test } from '@jest/globals';
import { createConversation, populateConversationWithVotes, registerAndLoginUser } from '../setup/api-test-helpers';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import type { AuthData } from '../../types/test-helpers';

interface TestData {
  comments: number[];
  stats: {
    totalVotes: number;
    [key: string]: any;
  };
  [key: string]: any;
}

describe('Data Export API', () => {
  let agent: Agent;
  let textAgent: Agent;
  let conversationId: string;
  let testData: TestData;
  let reportId: string;

  const numParticipants = 3;
  const numComments = 3;
  const testTopic = 'Test Data Export Conversation';
  const testDescription = 'This is a test conversation created for data export testing';

  beforeAll(async () => {
    // Register a user (conversation owner)
    const auth: AuthData = await registerAndLoginUser();
    agent = auth.agent;
    textAgent = auth.textAgent;

    // Create a conversation
    conversationId = await createConversation(agent, {
      topic: testTopic,
      description: testDescription
    });

    // Populate the conversation with test data
    testData = await populateConversationWithVotes({
      conversationId,
      numParticipants,
      numComments
    });

    // Create a report for this conversation
    await agent.post('/api/v3/reports').send({
      conversation_id: conversationId
    });

    // Get the report ID
    const getReportsResponse: Response = await agent.get(`/api/v3/reports?conversation_id=${conversationId}`);
    reportId = getReportsResponse.body[0].report_id;
  });

  test('GET /api/v3/dataExport - should initiate a data export task', async () => {
    const currentTimeInSeconds: number = Math.floor(Date.now() / 1000);

    const response: Response = await agent.get(
      `/api/v3/dataExport?conversation_id=${conversationId}&unixTimestamp=${currentTimeInSeconds}&format=csv`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  test('GET /api/v3/reportExport/:report_id/summary.csv - should export report summary', async () => {
    const response: Response = await agent.get(`/api/v3/reportExport/${reportId}/summary.csv`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    expect(response.text).toContain(`topic,"${testTopic}"`);
    expect(response.text).toContain('url');
    expect(response.text).toContain(`voters,${numParticipants}`);
    expect(response.text).toContain(`voters-in-conv,${numParticipants}`);
    expect(response.text).toContain('commenters,1'); // owner is the only commenter
    expect(response.text).toContain(`comments,${numComments}`);
    expect(response.text).toContain('groups,');
    expect(response.text).toContain(`conversation-description,"${testDescription}"`);
  });

  test('GET /api/v3/reportExport/:report_id/comments.csv - should export comments', async () => {
    const response: Response = await agent.get(`/api/v3/reportExport/${reportId}/comments.csv`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    // Should contain expected headers
    expect(response.text).toContain('timestamp');
    expect(response.text).toContain('datetime');
    expect(response.text).toContain('comment-id');
    expect(response.text).toContain('author-id');
    expect(response.text).toContain('agrees');
    expect(response.text).toContain('disagrees');
    expect(response.text).toContain('moderated');
    expect(response.text).toContain('comment-body');

    // Should contain all our test comments
    testData.comments.forEach((commentId) => {
      expect(response.text).toContain(commentId.toString());
    });
  });

  test('GET /api/v3/reportExport/:report_id/votes.csv - should export votes', async () => {
    const response: Response = await textAgent.get(`/api/v3/reportExport/${reportId}/votes.csv`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');

    // Should contain expected headers
    expect(response.text).toContain('timestamp');
    expect(response.text).toContain('datetime');
    expect(response.text).toContain('comment-id');
    expect(response.text).toContain('voter-id');
    expect(response.text).toContain('vote');

    // Verify we have the expected number of votes
    const voteLines = response.text.split('\n').filter((line) => line.trim().length > 0);
    expect(voteLines.length - 1).toBe(testData.stats.totalVotes); // -1 for header row
  });

  test('GET /api/v3/reportExport/:report_id/unknown.csv - should handle unknown report type', async () => {
    const response: Response = await textAgent.get(`/api/v3/reportExport/${reportId}/unknown.csv`);

    expect(response.status).toBe(404);
    expect(response.text).toContain('polis_error_data_unknown_report');
  });

  test('GET /api/v3/reportExport/nonexistent/comments.csv - should handle nonexistent report ID', async () => {
    const response: Response = await textAgent.get('/api/v3/reportExport/nonexistent/comments.csv');

    expect(response.status).toBe(400);
    expect(response.text).toContain('polis_err_param_parse_failed_report_id');
  });
});