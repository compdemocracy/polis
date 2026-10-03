import { canGenerateCollectiveStatement, THRESHOLDS } from "./consensusThreshold";
import { DB_VOTE, cellFromVotes } from "./voteCounts";

// Generated fixture: two groups of GROUP_SIZE members, three comments that
// clear the consensus threshold. Only participation decides eligibility.
const GROUP_SIZE = 100;
const TIDS = [1, 2, 3];
const HIGH_CONSENSUS = THRESHOLDS.MIN_CONSENSUS + 0.1;

function votes(agrees, disagrees, passes) {
  return [
    ...Array(agrees).fill(DB_VOTE.AGREE),
    ...Array(disagrees).fill(DB_VOTE.DISAGREE),
    ...Array(passes).fill(DB_VOTE.PASS),
  ];
}

function mathWith(cell) {
  const group = { "n-members": GROUP_SIZE, votes: {} };
  const consensus = {};
  TIDS.forEach((tid) => {
    group.votes[tid] = cell;
    consensus[tid] = HIGH_CONSENSUS;
  });
  return {
    "group-votes": { 0: group, 1: { ...group } },
    "group-consensus-normalized": consensus,
  };
}

describe("canGenerateCollectiveStatement participation count", () => {
  const minSeen = Math.ceil(THRESHOLDS.MIN_GROUP_PARTICIPATION * GROUP_SIZE);

  it("does not count agrees and disagrees twice", () => {
    // Seen by one fewer member than the minimum. A + D + S would have counted
    // this cell as nearly twice the minimum and let it through.
    const agrees = 2;
    const disagrees = 1;
    const passes = minSeen - 1 - agrees - disagrees;
    const cell = cellFromVotes(votes(agrees, disagrees, passes));
    expect(cell.A + cell.D + cell.S).toBeGreaterThanOrEqual(minSeen);

    const result = canGenerateCollectiveStatement(TIDS, mathWith(cell));
    expect(result.canGenerate).toBe(false);
    expect(result.count).toBe(0);
  });

  it("counts every member who saw the comment, passes included", () => {
    const agrees = 2;
    const disagrees = 1;
    const passes = minSeen - agrees - disagrees;
    const cell = cellFromVotes(votes(agrees, disagrees, passes));

    const result = canGenerateCollectiveStatement(TIDS, mathWith(cell));
    expect(result.canGenerate).toBe(true);
    expect(result.count).toBe(TIDS.length);
  });
});
