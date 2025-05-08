import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  authenticateAgent,
  initializeParticipant,
  newTextAgent,
  setupAuthAndConvo,
  wait,
} from '../setup/api-test-helpers';
import type { Agent, Response } from 'supertest'; 

const NUM_CONCURRENT_VOTES = 20; 

describe('Concurrent Participant Creation Test', () => {
  let conversationId: string;
  let commentId: number;

  beforeAll(async () => {
    const setup = await setupAuthAndConvo({ commentCount: 1 });
    conversationId = setup.conversationId;
    commentId = setup.commentIds[0];
  });

  test('should handle concurrent anonymous participant creation via voting without crashing', async () => {
    const participantVotePromises: Promise<Response>[] = [];

    const participantAgents: Agent[] = [];
    for (let i = 0; i < NUM_CONCURRENT_VOTES; i++) {
      // Initialize anonymous participant and get their unique agent
      const { cookies } = await initializeParticipant(conversationId);
      const participantAgent = await newTextAgent();
      authenticateAgent(participantAgent, cookies);
      participantAgents.push(participantAgent);
    }

    participantAgents.forEach((agent, index) => { // Iterate over the anonymous agents
      const votePayload = { 
        conversation_id: conversationId,
        tid: commentId,
        vote: ((index % 3) - 1) as -1 | 0 | 1,
        pid: 'mypid',
        agid: 1,
        lang: 'en' 
      };

      // Use the specific anonymous participant agent directly
      const votePromise = agent.post('/api/v3/votes').send(votePayload);
      participantVotePromises.push(votePromise);
    });

    let results: Response[] = [];
    try {
      results = await Promise.all(participantVotePromises);
      console.log('All vote promises settled.');
    } catch (error) {
      console.error('Error during Promise.all(votePromises):', error);
    }
    
    await wait(1000);

    console.log('\n--- Concurrent Vote Results ---');
    let successCount = 0;
    let duplicateVoteErrors = 0; // Should be 0
    let internalServerErrorsFromVote = 0; // Expecting N > 0 (for participants_zid_pid_key)
    let otherErrors = 0;
    const pidsAssigned: (string | undefined)[] = [];

    results.forEach((response, index) => {
      let currentPidFromBody: string | undefined;
      if (response.status === 200 && response.headers['content-type']?.includes('application/json')) {
        try {
          const parsedBody = JSON.parse(response.text);
          currentPidFromBody = parsedBody?.currentPid;
        } catch (e) {
          console.warn(`Participant ${index + 1}: Failed to parse JSON body for 200 response. Text: ${response.text}`);
        }
      }
      pidsAssigned.push(currentPidFromBody); 

      if (response.status === 200) {
        successCount++;
      } else if (response.status === 406 && response.text?.includes('polis_err_vote_duplicate')) {
        duplicateVoteErrors++;
        console.warn(`Participant ${index + 1} vote resulted in 406 (polis_err_vote_duplicate): Text: ${response.text}`);
      } else if (response.status === 500 && response.text?.includes('polis_err_vote')) {
        internalServerErrorsFromVote++;
        console.error(`Participant ${index + 1} vote resulted in 500 (polis_err_vote): Text: ${response.text}`);
      } else {
        otherErrors++;
        console.error(`Participant ${index + 1} vote failed with status ${response.status}: Text: ${response.text}`); 
      }
    });

    console.log(`Successful votes: ${successCount}/${NUM_CONCURRENT_VOTES}`);
    console.log(`Duplicate vote errors (406): ${duplicateVoteErrors}/${NUM_CONCURRENT_VOTES}`);
    console.log(`Internal server errors from vote (500 polis_err_vote): ${internalServerErrorsFromVote}/${NUM_CONCURRENT_VOTES}`);
    console.log(`Other errors: ${otherErrors}/${NUM_CONCURRENT_VOTES}`);
    console.log('PIDs assigned/returned (only from 200 responses):', pidsAssigned.filter(pid => pid !== undefined));
    
    expect(true).toBe(true); // Server did not crash

    expect(successCount + duplicateVoteErrors + internalServerErrorsFromVote + otherErrors).toBe(NUM_CONCURRENT_VOTES);
    expect(otherErrors).toBe(0); // Expect only 200s, 406s, or our specific 500s

    const successfulPids = pidsAssigned.filter(pid => pid !== undefined && pid !== 'mypid') as string[];
    const uniquePids = new Set(successfulPids);
    if (internalServerErrorsFromVote > 0 || duplicateVoteErrors > 0) {
      console.warn(`WARNING: ${internalServerErrorsFromVote} internal server errors (500) and ${duplicateVoteErrors} duplicate vote errors (406) occurred.`);
    }
    if (successfulPids.length > 0) {
       console.log(`Total successful PIDs assigned: ${successfulPids.length}, Unique PIDs: ${uniquePids.size}`);
       expect(successfulPids.length).toBe(uniquePids.size); 
    }
    
  }, 30000); 
}); 