import { getMathConsensus, mathConsensusFor, MATH_CONSENSUS_KEY } from "./mathConsensus";
import { enrichMathWithNormalizedConsensus } from "./normalizeConsensus";
import { DB_VOTE, cellFromVotes } from "./voteCounts";

// Generated fixture where the engine's consensus and the client-normalized mean
// disagree on the order of two comments.
const ENGINE_CONSENSUS = { 10: 0.2, 20: 0.4 };

function generatedMath() {
  const agree = (n) => Array(n).fill(DB_VOTE.AGREE);
  const disagree = (n) => Array(n).fill(DB_VOTE.DISAGREE);
  return {
    [MATH_CONSENSUS_KEY]: { ...ENGINE_CONSENSUS },
    "group-votes": {
      0: { "n-members": 10, votes: { 10: cellFromVotes(agree(10)), 20: cellFromVotes(agree(5).concat(disagree(5))) } },
      1: { "n-members": 10, votes: { 10: cellFromVotes(agree(10)), 20: cellFromVotes(agree(5).concat(disagree(5))) } },
    },
  };
}

const rank = (tids, consensus) => [...tids].sort((a, b) => (consensus[b] || 0) - (consensus[a] || 0));

describe("math consensus is the one ordering", () => {
  it("reads the engine's group-aware-consensus even after normalization is added", () => {
    const math = enrichMathWithNormalizedConsensus(generatedMath());
    const normalized = math["group-consensus-normalized"];
    // The two numbers order these comments differently...
    expect(rank([10, 20], normalized)).toEqual([10, 20]);
    expect(rank([10, 20], ENGINE_CONSENSUS)).toEqual([20, 10]);
    // ...and the report ranks by the engine's.
    expect(getMathConsensus(math)).toEqual(ENGINE_CONSENSUS);
    expect(rank([10, 20], getMathConsensus(math))).toEqual([20, 10]);
    expect(mathConsensusFor(math, 20)).toBe(ENGINE_CONSENSUS[20]);
  });

  it("is empty, not undefined, when math has no consensus", () => {
    expect(getMathConsensus(undefined)).toEqual({});
    expect(mathConsensusFor({}, 1)).toBeUndefined();
  });
});
