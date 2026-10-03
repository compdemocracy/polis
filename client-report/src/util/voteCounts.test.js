import { DB_VOTE, cellFromVotes, voteCounts, voteShares } from "./voteCounts";

// Generated fixture: one comment, twelve participants who saw it.
const AGREES = 6;
const DISAGREES = 3;
const PASSES = 3;
const SEEN = AGREES + DISAGREES + PASSES;

function generatedVotes() {
  return [
    ...Array(AGREES).fill(DB_VOTE.AGREE),
    ...Array(DISAGREES).fill(DB_VOTE.DISAGREE),
    ...Array(PASSES).fill(DB_VOTE.PASS),
  ];
}

describe("cellFromVotes (engine cell from database-sign votes)", () => {
  it("counts S as everyone who saw the comment, passes included", () => {
    expect(cellFromVotes(generatedVotes())).toEqual({ A: AGREES, D: DISAGREES, S: SEEN });
  });

  it("ignores values that are not a vote", () => {
    expect(cellFromVotes([DB_VOTE.AGREE, null, undefined, NaN])).toEqual({ A: 1, D: 0, S: 1 });
  });
});

describe("voteCounts", () => {
  it("decodes A/D/S into agree/disagree/pass/seen without double counting", () => {
    const counts = voteCounts(cellFromVotes(generatedVotes()));
    expect(counts).toEqual({ agree: AGREES, disagree: DISAGREES, pass: PASSES, seen: SEEN });
    expect(counts.agree + counts.disagree + counts.pass).toBe(counts.seen);
  });

  it("treats a missing cell as no votes", () => {
    expect(voteCounts(undefined)).toEqual({ agree: 0, disagree: 0, pass: 0, seen: 0 });
  });

  it("never reports fewer seen than agrees plus disagrees", () => {
    const cell = { A: AGREES, D: DISAGREES };
    expect(voteCounts(cell)).toEqual({
      agree: AGREES,
      disagree: DISAGREES,
      pass: 0,
      seen: AGREES + DISAGREES,
    });
  });
});

describe("voteShares", () => {
  it("gives agree/disagree/pass percentages of everyone who saw the comment", () => {
    const shares = voteShares(voteCounts(cellFromVotes(generatedVotes())));
    expect(shares.agree).toBeCloseTo(AGREES / SEEN);
    expect(shares.disagree).toBeCloseTo(DISAGREES / SEEN);
    expect(shares.pass).toBeCloseTo(PASSES / SEEN);
    // 50% / 25% / 25%, where A + D + S as a denominator gave 6/21 = 28.6% agree.
    expect(Math.round(shares.agree * 100)).toBe(50);
    expect(Math.round(shares.disagree * 100)).toBe(25);
    expect(Math.round(shares.pass * 100)).toBe(25);
  });

  it("is all zero when nobody saw the comment", () => {
    expect(voteShares(voteCounts({}))).toEqual({ agree: 0, disagree: 0, pass: 0 });
  });
});
