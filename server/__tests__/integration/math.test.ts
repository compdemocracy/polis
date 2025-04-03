import { beforeAll, describe, expect, test } from '@jest/globals';
import type { Response } from 'supertest';
import type { Agent } from 'supertest';
import {
  createConversation,
  getTestAgent,
  populateConversationWithVotes,
  setupAuthAndConvo
} from '../setup/api-test-helpers';

const NUM_PARTICIPANTS = 5;
const NUM_COMMENTS = 5;

interface PCAResponse {
  pca: {
    center: number[];
    comps: number[][];
    'comment-extremity': number[];
    'comment-projection': number[][];
    [key: string]: any;
  };
  consensus: any;
  lastModTimestamp: number;
  lastVoteTimestamp: number;
  math_tick: number;
  n: number;
  repness: any;
  tids: number[];
  'base-clusters': any;
  'comment-priorities': any;
  'group-aware-consensus': any;
  'group-clusters': any;
  'group-votes': any;
  'in-conv': any;
  'meta-tids': any;
  'mod-in': any;
  'mod-out': any;
  'n-cmts': number;
  'user-vote-counts': any;
  'votes-base': any;
  [key: string]: any;
}

interface CorrelationResponse {
  matrix?: number[][];
  correlations?: any;
  [key: string]: any;
}

describe('Math and Analysis Endpoints', () => {
  let agent: Agent;
  let conversationId: string | null = null;

  beforeAll(async () => {
    // Initialize the test agent
    agent = await getTestAgent();
    
    // Setup conversation with comments and votes to have data for analysis
    const setup = await setupAuthAndConvo();
    conversationId = setup.conversationId;

    await populateConversationWithVotes({
      conversationId,
      numParticipants: NUM_PARTICIPANTS,
      numComments: NUM_COMMENTS
    });
  });

  test('GET /math/pca2 - Get Principal Component Analysis', async () => {
    // Request PCA results for the conversation
    // The response will be automatically decompressed by our supertest agent
    const { body, status } = await agent.get(`/api/v3/math/pca2?conversation_id=${conversationId}`);

    // Validate response
    expect(status).toBe(200);
    expect(body).toBeDefined();

    // The response has been decompressed and parsed from gzip
    if (body) {
      const pcaResponse = body as PCAResponse;
      expect(pcaResponse.pca).toBeDefined();
      const { pca } = pcaResponse;

      // Check that the body has the expected fields
      expect(pcaResponse.consensus).toBeDefined();
      expect(pcaResponse.lastModTimestamp).toBeDefined();
      expect(pcaResponse.lastVoteTimestamp).toBeDefined();
      expect(pcaResponse.math_tick).toBeDefined();
      expect(pcaResponse.n).toBeDefined();
      expect(pcaResponse.repness).toBeDefined();
      expect(pcaResponse.tids).toBeDefined();
      expect(pcaResponse['base-clusters']).toBeDefined();
      expect(pcaResponse['comment-priorities']).toBeDefined();
      expect(pcaResponse['group-aware-consensus']).toBeDefined();
      expect(pcaResponse['group-clusters']).toBeDefined();
      expect(pcaResponse['group-votes']).toBeDefined();
      expect(pcaResponse['in-conv']).toBeDefined();
      expect(pcaResponse['meta-tids']).toBeDefined();
      expect(pcaResponse['mod-in']).toBeDefined();
      expect(pcaResponse['mod-out']).toBeDefined();
      expect(pcaResponse['n-cmts']).toBeDefined();
      expect(pcaResponse['user-vote-counts']).toBeDefined();
      expect(pcaResponse['votes-base']).toBeDefined();

      // Check that the PCA results are defined
      expect(pca.center).toBeDefined();
      expect(pca.comps).toBeDefined();
      expect(pca['comment-extremity']).toBeDefined();
      expect(pca['comment-projection']).toBeDefined();
    }
  });

  // Requires Report ID to exist first.
  // TODO: Revisit this after Reports have been covered in tests.
  test.skip('GET /api/v3/math/correlationMatrix - Get correlation matrix', async () => {
    // Request correlation matrix for the conversation
    const response: Response = await agent.get(`/api/v3/math/correlationMatrix?conversation_id=${conversationId}`);

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // Correlation matrix should be an array or object with correlation data
    if (response.body) {
      const correlationResponse = response.body as CorrelationResponse;
      
      // Check for structure - could be:
      // 1. A 2D array/matrix
      // 2. An object with correlation data
      // 3. An object with a matrix property

      const hasCorrelationData = Array.isArray(correlationResponse) || correlationResponse.matrix || correlationResponse.correlations;

      expect(hasCorrelationData).toBeTruthy();
    }
  });

  test('Math endpoints - Return 400 for missing conversation_id', async () => {
    // Request PCA without conversation_id
    const pcaResponse: Response = await agent.get('/api/v3/math/pca2');

    expect(pcaResponse.status).toBe(400);
    expect(pcaResponse.text).toMatch(/polis_err_param_missing_conversation_id/);

    // Request correlation matrix without report_id
    const corrResponse: Response = await agent.get(`/api/v3/math/correlationMatrix?conversation_id=${conversationId}`);

    expect(corrResponse.status).toBe(400);
    expect(corrResponse.text).toMatch(/polis_err_param_missing_report_id/);
  });

  test('Math endpoints - Return appropriate error for invalid conversation_id', async () => {
    const invalidId = 'nonexistent-conversation-id';

    // Request PCA with invalid conversation_id
    const pcaResponse: Response = await agent.get(`/api/v3/math/pca2?conversation_id=${invalidId}`);

    // Should return an error status
    expect(pcaResponse.status).toBeGreaterThanOrEqual(400);
    expect(pcaResponse.text).toMatch(/polis_err_param_parse_failed_conversation_id/);
    expect(pcaResponse.text).toMatch(/polis_err_fetching_zid_for_conversation_id/);

    // Request correlation matrix with invalid report_id
    const corrResponse: Response = await agent.get(`/api/v3/math/correlationMatrix?report_id=${invalidId}`);

    // Should return an error status
    expect(corrResponse.status).toBeGreaterThanOrEqual(400);
    expect(corrResponse.text).toMatch(/polis_err_param_parse_failed_report_id/);
    expect(corrResponse.text).toMatch(/polis_err_fetching_rid_for_report_id/);
  });

  test('Math endpoints - Require sufficient data for meaningful analysis', async () => {
    // Create a new empty conversation
    const emptyConvoId = await createConversation(agent);

    // Request PCA for empty conversation
    const { body, status } = await agent.get(`/api/v3/math/pca2?conversation_id=${emptyConvoId}`);

    expect(status).toBe(304);
    expect(body).toBe('');

    // TODO: Request correlation matrix for empty conversation
  });

  test('Math endpoints - Support math_tick parameter', async () => {
    // Request PCA with math_tick parameter
    const pcaResponse: Response = await agent.get(`/api/v3/math/pca2?conversation_id=${conversationId}&math_tick=2`);

    // Validate response
    expect(pcaResponse.status).toBe(200);

    // TODO: Check that the math_tick is respected

    // TODO: Request correlation matrix with math_tick parameter
  });
});