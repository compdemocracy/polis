/**
 * Centralized logic for determining if a topic can generate a collective statement
 */

const MIN_CONSENSUS = 0.8;
const MIN_COMMENTS = 3;
const MIN_GROUP_PARTICIPATION = 0.05; // 5% of each group must have voted

/**
 * Checks if a comment has sufficient participation from all groups
 * @param {number} tid - Comment ID
 * @param {Object} groupVotes - The group-votes data from math
 * @returns {Object} { hasMinParticipation: boolean, details: string }
 */
function checkGroupParticipation(tid, groupVotes) {
  if (!groupVotes) {
    return { hasMinParticipation: false, details: "No group vote data" };
  }

  const groupParticipation = [];
  let allGroupsMeetThreshold = true;

  for (const gid in groupVotes) {
    const group = groupVotes[gid];
    const groupSize = group["n-members"] || 0;
    const votes = group.votes?.[tid];
    
    if (!votes) {
      groupParticipation.push(`Group ${gid}: No votes`);
      allGroupsMeetThreshold = false;
      continue;
    }

    const totalVotes = (votes.A || 0) + (votes.D || 0) + (votes.S || 0);
    const participationRate = groupSize > 0 ? totalVotes / groupSize : 0;
    
    if (participationRate < MIN_GROUP_PARTICIPATION) {
      allGroupsMeetThreshold = false;
      groupParticipation.push(`Group ${gid}: ${(participationRate * 100).toFixed(1)}% (need ${(MIN_GROUP_PARTICIPATION * 100)}%)`);
    } else {
      groupParticipation.push(`Group ${gid}: ${(participationRate * 100).toFixed(1)}% ✓`);
    }
  }

  return {
    hasMinParticipation: allGroupsMeetThreshold,
    details: groupParticipation.join(", ")
  };
}

/**
 * Determines if a topic has enough high-consensus comments to generate a collective statement
 * 
 * @param {Array<number>} commentTids - Array of comment IDs in this topic
 * @param {Object} math - Math object containing consensus data and group votes
 * @returns {Object} { canGenerate: boolean, count: number, message: string, details: Array }
 */
export function canGenerateCollectiveStatement(commentTids, math) {
  if (!commentTids || !math) {
    return {
      canGenerate: false,
      count: 0,
      message: "Missing required data",
      details: []
    };
  }

  // Use normalized consensus if available, fall back to raw
  const consensusData = math["group-consensus-normalized"] || math["group-aware-consensus"];
  const groupVotes = math["group-votes"];
  
  if (!consensusData) {
    return {
      canGenerate: false,
      count: 0,
      message: "No consensus data available",
      details: []
    };
  }

  // Check each comment for both consensus threshold AND group participation
  const qualifyingComments = [];
  const failureReasons = [];

  commentTids.forEach(tid => {
    const consensus = consensusData[tid];
    if (consensus === undefined) return;

    const meetsConsensus = consensus >= MIN_CONSENSUS;
    const participationCheck = checkGroupParticipation(tid, groupVotes);

    if (meetsConsensus && participationCheck.hasMinParticipation) {
      qualifyingComments.push({
        tid,
        consensus,
        participationDetails: participationCheck.details
      });
    } else {
      const reasons = [];
      if (!meetsConsensus) {
        reasons.push(`consensus ${consensus.toFixed(2)} < ${MIN_CONSENSUS}`);
      }
      if (!participationCheck.hasMinParticipation) {
        reasons.push(`insufficient group participation`);
      }
      failureReasons.push(`Comment ${tid}: ${reasons.join(", ")}`);
    }
  });

  const canGenerate = qualifyingComments.length >= MIN_COMMENTS;
  let message;
  
  if (canGenerate) {
    message = `${qualifyingComments.length} comments meet all requirements`;
  } else {
    message = `Need at least ${MIN_COMMENTS} comments with ≥${MIN_CONSENSUS} consensus AND ≥${(MIN_GROUP_PARTICIPATION * 100)}% participation from EVERY group. Only ${qualifyingComments.length} qualify.`;
  }

  return {
    canGenerate,
    count: qualifyingComments.length,
    message,
    details: canGenerate ? qualifyingComments : failureReasons
  };
}

/**
 * Gets the consensus values for a set of comments
 * @param {Array<number>} commentTids - Array of comment IDs
 * @param {Object} math - Math object containing consensus data
 * @returns {Object} Map of tid to consensus value
 */
export function getTopicConsensusValues(commentTids, math) {
  const consensusData = math?.["group-consensus-normalized"] || math?.["group-aware-consensus"];
  const values = {};
  
  if (consensusData && commentTids) {
    commentTids.forEach(tid => {
      if (consensusData[tid] !== undefined) {
        values[tid] = consensusData[tid];
      }
    });
  }
  
  return values;
}

// Export the thresholds if other components need them for display
export const THRESHOLDS = {
  MIN_CONSENSUS,
  MIN_COMMENTS,
  MIN_GROUP_PARTICIPATION
};