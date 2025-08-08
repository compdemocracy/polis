import { normalizeGroupConsensus, enrichMathWithNormalizedConsensus } from './normalizeConsensus';

describe('normalizeGroupConsensus', () => {
  it('returns 1.0 when all groups agree', () => {
    const groupVotes = {
      0: { votes: { 123: { A: 10, D: 0 } } },
      1: { votes: { 123: { A: 8, D: 0 } } },
      2: { votes: { 123: { A: 12, D: 0 } } }
    };
    
    // With Laplace smoothing: (10+1)/(10+0+2) ≈ 0.917 for each group
    // Should be close to 1 but not exactly 1 due to smoothing
    const result = normalizeGroupConsensus(groupVotes, 123);
    expect(result).toBeCloseTo(0.917, 2);
  });

  it('returns 0.0 when all groups disagree', () => {
    const groupVotes = {
      0: { votes: { 123: { A: 0, D: 10 } } },
      1: { votes: { 123: { A: 0, D: 8 } } },
      2: { votes: { 123: { A: 0, D: 12 } } }
    };
    
    // With Laplace smoothing: (0+1)/(0+10+2) ≈ 0.083 for each group
    const result = normalizeGroupConsensus(groupVotes, 123);
    expect(result).toBeCloseTo(0.083, 2);
  });

  it('returns 0.5 when groups are evenly split', () => {
    const groupVotes = {
      0: { votes: { 123: { A: 0, D: 10 } } },  // Disagree
      1: { votes: { 123: { A: 10, D: 0 } } }   // Agree
    };
    
    // Group 0: (0+1)/(0+10+2) = 1/12 ≈ 0.083
    // Group 1: (10+1)/(10+0+2) = 11/12 ≈ 0.917
    // Average: (0.083 + 0.917) / 2 = 0.5
    const result = normalizeGroupConsensus(groupVotes, 123);
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('returns 0.5 when no votes exist', () => {
    const groupVotes = {};
    const result = normalizeGroupConsensus(groupVotes, 123);
    expect(result).toBe(0.5);
  });

  it('handles missing votes for a comment', () => {
    const groupVotes = {
      0: { votes: { 456: { A: 5, D: 5 } } },  // Different tid
      1: { votes: {} }  // No votes for tid 123
    };
    
    const result = normalizeGroupConsensus(groupVotes, 123);
    expect(result).toBe(0.5);  // No data, returns neutral
  });
});

describe('enrichMathWithNormalizedConsensus', () => {
  it('adds normalized consensus to math results', () => {
    const mathResult = {
      "group-votes": {
        0: { votes: { 
          123: { A: 10, D: 0 },
          456: { A: 0, D: 10 }
        } },
        1: { votes: { 
          123: { A: 8, D: 2 },
          456: { A: 1, D: 9 }
        } }
      },
      "group-aware-consensus": {
        123: 0.0123,  // Raw value (product of probabilities)
        456: 0.0001   // Raw value (very small due to multiplication)
      }
    };

    const enriched = enrichMathWithNormalizedConsensus(mathResult);
    
    expect(enriched["group-consensus-normalized"]).toBeDefined();
    expect(enriched["group-consensus-normalized"][123]).toBeCloseTo(0.833, 2);
    expect(enriched["group-consensus-normalized"][456]).toBeCloseTo(0.167, 2);
  });
});