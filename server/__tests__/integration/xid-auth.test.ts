import { beforeAll, describe, expect, test } from '@jest/globals';
import type { Response } from 'supertest';
import {
  createConversation,
  generateRandomXid,
  initializeParticipantWithXid,
  registerAndLoginUser,
  submitVote
} from '../setup/api-test-helpers';

interface UserInfo {
  uid: number;
  hasXid: boolean;
  xInfo: {
    xid: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface ParticipationResponse {
  user: UserInfo;
  conversation: {
    conversation_id: string;
    [key: string]: any;
  };
  nextComment: {
    tid?: number;
    currentPid?: string;
    [key: string]: any;
  };
  votes: Array<{
    tid: number;
    vote: number;
    [key: string]: any;
  }>;
  [key: string]: any;
}

describe('XID-based Authentication', () => {
  let agent: ReturnType<typeof registerAndLoginUser>['agent'];
  let conversationId: string;
  let commentId: number;

  beforeAll(async () => {
    // Create an authenticated user
    const auth = await registerAndLoginUser();
    agent = auth.agent;

    // Create a conversation
    conversationId = await createConversation(agent);

    // Create a comment in the conversation
    const response: Response = await agent.post('/api/v3/comments').send({
      conversation_id: conversationId,
      txt: 'Test comment for XID authentication testing'
    });

    expect(response.status).toBe(200);
    commentId = response.body.tid;
  });

  test('should initialize participation with XID', async () => {
    const xid = generateRandomXid();

    const { status, body } = await initializeParticipantWithXid(conversationId, xid);

    expect(status).toBe(200);
    expect(body).toHaveProperty('conversation');
    expect(body).toHaveProperty('nextComment');
    expect(body.conversation.conversation_id).toBe(conversationId);

    // Should have the comment we created
    expect(body.nextComment.tid).toBe(commentId);

    // The participant should be associated with the XID
    // but we can't easily verify that directly from the response
  });

  test('should maintain XID association across multiple sessions', async () => {
    const xid = generateRandomXid();

    // First session
    const { agent: firstSessionAgent } = await initializeParticipantWithXid(conversationId, xid);

    // Vote on a comment
    const firstVoteResponse = await submitVote(firstSessionAgent, {
      conversation_id: conversationId,
      tid: commentId,
      vote: -1, // Agree
      xid: xid
    });

    expect(firstVoteResponse.status).toBe(200);

    // Second session with same XID
    const { body: secondSessionBody } = await initializeParticipantWithXid(conversationId, xid);
    const responseBody = secondSessionBody as ParticipationResponse;

    const { user, nextComment, votes } = responseBody;

    // user should be defined and have the xid info
    expect(user.uid).toBeDefined();
    expect(user.hasXid).toBe(true);
    expect(user.xInfo.xid).toBe(xid);

    // nextComment should not comtain a comment
    expect(nextComment.tid).toBeUndefined();
    expect(nextComment.currentPid).toBeDefined();

    // the vote should be the same as the one we made in the first session
    expect(votes).toBeInstanceOf(Array);
    expect(votes.length).toBe(1);
    expect(votes[0].vote).toBe(-1);
    expect(votes[0].tid).toBe(commentId);
  });

  test('should format XID whitelist properly', async () => {
    // Create XIDs to whitelist
    const xids = [generateRandomXid(), generateRandomXid(), generateRandomXid()];

    // Attempt to whitelist string XIDs (expect error)
    const whitelistResponse: Response = await agent.post('/api/v3/xidWhitelist').send({
      xid_whitelist: xids.join(',')
    });

    // Returns 200 with empty body
    // There is no endpoint to get the whitelist
    expect(whitelistResponse.status).toBe(200);
    expect(whitelistResponse.body).toEqual({});
  });
});