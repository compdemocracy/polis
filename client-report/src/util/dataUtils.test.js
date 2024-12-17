import dataUtils from './dataUtils';

describe('dataUtils', () => {
  describe('getVoteTotals', () => {
    it('should return an empty object if math_main is empty or has no group-votes', () => {
      expect(dataUtils.getVoteTotals({})).toEqual({});
      expect(dataUtils.getVoteTotals({ otherData: 'something' })).toEqual({});
      expect(dataUtils.getVoteTotals({ "group-votes": null })).toEqual({});
      expect(dataUtils.getVoteTotals({ "group-votes": undefined })).toEqual({});
    });

    it('should calculate vote totals correctly for a single group', () => {
      const math_main = {
        "group-votes": {
          0: {
            votes: {
              1: { A: 10, D: 5, S: 15 },
              2: { A: 5, D: 10, S: 15 },
            },
          },
        },
      };
      const expected = {
        1: { agreed: 10, disagreed: 5, saw: 15, pctAgreed: 10/15, pctDisagreed: 5/15, pctVoted: 0/15 },
        2: { agreed: 5, disagreed: 10, saw: 15, pctAgreed: 5/15, pctDisagreed: 10/15, pctVoted: 0/15 },
      };
      expect(dataUtils.getVoteTotals(math_main)).toEqual(expected);
    });

    it('should calculate vote totals correctly for multiple groups', () => {
      const math_main = {
        "group-votes": {
          0: {
            votes: {
              1: { A: 10, D: 5, S: 15 },
              2: { A: 5, D: 10, S: 15 },
            },
          },
          1: {
            votes: {
              1: { A: 2, D: 3, S: 5 },
              3: { A: 7, D: 1, S: 8 },
            },
          },
        },
      };
      const expected = {
        1: { agreed: 12, disagreed: 8, saw: 20, pctAgreed: 12/20, pctDisagreed: 8/20, pctVoted: 0/20 },
        2: { agreed: 5, disagreed: 10, saw: 15, pctAgreed: 5/15, pctDisagreed: 10/15, pctVoted: 0/15 },
        3: { agreed: 7, disagreed: 1, saw: 8, pctAgreed: 7/8, pctDisagreed: 1/8, pctVoted: 0/8 },
      };
      expect(dataUtils.getVoteTotals(math_main)).toEqual(expected);
    });

    it('should handle missing A, D, or S counts', () => {
      const math_main = {
        "group-votes": {
          0: {
            votes: {
              1: { A: 10, D: 5 }, // Missing S
              2: { S: 15 }, // Missing A and D
            },
          },
        },
      };
      const expected = {
        1: { agreed: 10, disagreed: 5, saw: 0, pctAgreed: 0, pctDisagreed: 0, pctVoted: 0 },
        2: { agreed: 0, disagreed: 0, saw: 15, pctAgreed: 0, pctDisagreed: 0, pctVoted: 1 },
      };
      expect(dataUtils.getVoteTotals(math_main)).toEqual(expected);
    });

    it('should handle empty votes object', () => {
      const math_main = {
        "group-votes": {
          0: {
            votes: {},
          },
        },
      };
        const expected = {};
        expect(dataUtils.getVoteTotals(math_main)).toEqual(expected);
    });

    it('should handle saw = 0 to prevent division by zero', () => {
      const math_main = {
        "group-votes": {
          0: {
            votes: {
              1: { A: 10, D: 5, S: 0 },
            },
          },
        },
      };
      const expected = {
        1: { agreed: 10, disagreed: 5, saw: 0, pctAgreed: 0, pctDisagreed: 0, pctVoted: 0 },
      };
      expect(dataUtils.getVoteTotals(math_main)).toEqual(expected);
    });
  });
});