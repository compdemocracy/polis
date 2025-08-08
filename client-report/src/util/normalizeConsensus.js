/**
 * Normalizes group-aware consensus values to a 0-1 scale where:
 * - 1.0 = all groups agree
 * - 0.0 = all groups disagree  
 * - 0.5 = groups are split
 * 
 * This fixes the issue where raw consensus values shrink with more groups
 * because they're products of probabilities.
 * 
 * @param {Object} groupVotes - The group-votes object from math results
 * @param {number} tid - The comment ID
 * @returns {number} Normalized consensus value between 0 and 1
 */
export function normalizeGroupConsensus(groupVotes, tid) {
  if (!groupVotes) return 0.5; // neutral default
  
  let sum = 0;
  let groupCount = 0;
  
  // Calculate arithmetic mean of per-group agreement probabilities
  for (const gid in groupVotes) {
    const votes = groupVotes[gid].votes[tid];
    if (!votes) continue;
    
    // Use Laplace smoothing: (agrees + 1) / (agrees + disagrees + 2)
    const agrees = votes.A || 0;
    const disagrees = votes.D || 0;
    const probability = (agrees + 1) / (agrees + disagrees + 2);
    
    sum += probability;
    groupCount += 1;
  }
  
  if (groupCount === 0) return 0.5; // No votes, neutral
  
  return sum / groupCount;
}

/**
 * Enriches a math result object with normalized consensus values
 * 
 * @param {Object} mathResult - The raw math results from server
 * @returns {Object} Math results with added 'group-consensus-normalized' field
 */
export function enrichMathWithNormalizedConsensus(mathResult) {
  if (!mathResult || !mathResult["group-votes"]) return mathResult;
  
  const groupVotes = mathResult["group-votes"];
  const normalized = {};
  
  // Get all unique tids across all groups
  const allTids = new Set();
  for (const gid in groupVotes) {
    for (const tid in groupVotes[gid].votes) {
      allTids.add(tid);
    }
  }
  
  // Calculate normalized consensus for each tid
  for (const tid of allTids) {
    normalized[tid] = normalizeGroupConsensus(groupVotes, tid);
  }
  
  // Add to math results
  mathResult["group-consensus-normalized"] = normalized;
  
  return mathResult;
}