/**
 * Special test for detecting comment repetition bug
 *
 * This test creates a conversation with many comments, then has a participant
 * vote on comments until there are none remaining. It checks that:
 * 1. Each comment is seen exactly once
 * 2. No comments are repeated for a participant who has already voted on them
 */

import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  initializeParticipant,
  setupAuthAndConvo,
  submitVote
} from '../setup/api-test-helpers';
import type { VoteResponse } from '../../types/test-helpers';

interface CommentRepetition {
  commentId: number;
  count: number;
}

interface NextComment {
  tid: number;
  [key: string]: any;
}

// Constants
const NUM_COMMENTS = 10; // Total number of comments to create

describe('Comment Repetition Bug Test', () => {
  // Test state
  let conversationId: string;
  const allCommentIds: number[] = [];

  // Setup: Register admin, create conversation, and create comments
  beforeAll(async () => {
    try {
      const setup = await setupAuthAndConvo({
        commentCount: NUM_COMMENTS,
        conversationOptions: {
          topic: `Comment Repetition Test ${Date.now()}`,
          description: 'A conversation to test for the comment repetition bug'
        }
      });

      conversationId = setup.conversationId;
      
      // Add the created comments to our tracking array
      allCommentIds.push(...setup.commentIds);
      
      console.log(`Created ${NUM_COMMENTS} total comments for the test conversation`);
    } catch (error) {
      console.error('Setup failed:', error);
      throw error;
    }
  });

  test('A participant should never see the same comment twice', async () => {
    // Track seen comments to detect repetitions
    const seenCommentIds = new Set<number>();
    const commentRepetitions = new Map<number, number>(); // Track how many times each comment is seen
    let votedCount = 0;
    // Add an array to track the order of comments seen
    const orderedCommentIds: number[] = [];
    
    // STEP 1: Initialize anonymous participant
    const { agent: participantAgent, body: initBody } = await initializeParticipant(conversationId);

    let nextComment = initBody.nextComment as NextComment;
    let commentId = nextComment.tid;
    let currentPid: string | undefined;

    // STEP 2: Process each comment one by one
    const MAX_ALLOWED_COMMENTS = NUM_COMMENTS + 1; // Allow one extra to detect repetition
    let processedComments = 0;

    while (commentId) {
      processedComments++;
      if (processedComments > MAX_ALLOWED_COMMENTS) {
        // Instead of throwing an error, use expect to fail the test properly
        expect(processedComments).toBeLessThanOrEqual(
          MAX_ALLOWED_COMMENTS,
          `Processed ${processedComments} comments which exceeds maximum allowed (${MAX_ALLOWED_COMMENTS}). This indicates a comment repetition issue.`
        );
        break;
      }

      // Add the comment ID to our ordered list
      orderedCommentIds.push(commentId);

      // Check if we've seen this comment before
      if (seenCommentIds.has(commentId)) {
        // Update repetition count
        commentRepetitions.set(commentId, (commentRepetitions.get(commentId) || 1) + 1);
        console.warn(`REPETITION DETECTED: Comment ${commentId} seen again`);
      } else {
        seenCommentIds.add(commentId);
        commentRepetitions.set(commentId, 1);
        votedCount++;
      }

      // Vote on the current comment (randomly agree, disagree, or pass)
      const voteOptions = [-1, 1, 0]; // -1 agree, 1 disagree, 0 pass
      const randomVote = voteOptions[Math.floor(Math.random() * voteOptions.length)] as -1 | 0 | 1;

      // Build vote payload
      const voteData = {
        conversation_id: conversationId,
        tid: commentId,
        vote: randomVote,
        pid: currentPid
      };

      // Submit vote using our improved helper
      const voteResponse: VoteResponse = await submitVote(participantAgent, voteData);

      // Check for error in response
      expect(voteResponse.status).toBe(200, 'Failed to submit vote');

      // Update the participant ID from the vote response for the next vote
      currentPid = voteResponse.body.currentPid;
      
      // Update nextComment with the vote response
      nextComment = voteResponse.body.nextComment as NextComment;
      commentId = nextComment?.tid;

      // Log progress periodically
      if ((votedCount + 1) % 5 === 0) {
        console.log(`Voted on ${votedCount} unique comments out of ${NUM_COMMENTS} total.`);
      }
    }

    // STEP 3: Analyze results
    console.log('\nFINAL RESULTS:');
    console.log(`Seen ${seenCommentIds.size} unique comments out of ${NUM_COMMENTS} total`);
    console.log(`Voted on ${votedCount} comments`);

    // Print the ordered sequence of comments
    console.log('\nORDERED COMMENT SEQUENCE:');
    console.log(orderedCommentIds);
    console.log(`Total comments in sequence: ${orderedCommentIds.length}`);

    // Check for repeats
    const repeatedComments: CommentRepetition[] = Array.from(commentRepetitions.entries())
      .filter(([_, count]) => count > 1)
      .map(([commentId, count]) => ({ commentId, count }));

    if (repeatedComments.length > 0) {
      console.warn('Found repeated comments:', repeatedComments);
    }

    // Check if all comments were seen
    const unseenComments = allCommentIds.filter((id) => !seenCommentIds.has(id));
    if (unseenComments.length > 0) {
      console.log(`Comments never seen: ${unseenComments.length} of ${NUM_COMMENTS}`);
    }

    // Test assertions
    expect(repeatedComments.length).toBe(0, `Found ${repeatedComments.length} repeated comments`); // No comment should be repeated
  });
});