import { describe, expect, test } from '@jest/globals'
import { DB_VOTE, cellFromVotes, voteCounts, voteShares } from '../voteCounts'

// Generated fixture: one statement, twelve participants who saw it.
const AGREES = 6
const DISAGREES = 3
const PASSES = 3
const SEEN = AGREES + DISAGREES + PASSES
const PERCENT = 100
// The shares a reader sees for this vote set: 6, 3 and 3 of 12 who saw it.
const EXPECTED_AGREE_PERCENT = 50
const EXPECTED_DISAGREE_PERCENT = 25
const EXPECTED_PASS_PERCENT = 25

const generatedVotes = (): number[] => [
  ...Array<number>(AGREES).fill(DB_VOTE.AGREE),
  ...Array<number>(DISAGREES).fill(DB_VOTE.DISAGREE),
  ...Array<number>(PASSES).fill(DB_VOTE.PASS)
]

describe('cellFromVotes', () => {
  test('S counts everyone who saw the statement, passes included', () => {
    expect(cellFromVotes(generatedVotes())).toEqual({ A: AGREES, D: DISAGREES, S: SEEN })
  })

  test('values that are not a vote are ignored', () => {
    expect(cellFromVotes([DB_VOTE.DISAGREE, null, undefined, NaN])).toEqual({ A: 0, D: 1, S: 1 })
  })
})

describe('voteCounts', () => {
  test('decodes A/D/S without double counting agrees and disagrees', () => {
    const counts = voteCounts(cellFromVotes(generatedVotes()))
    expect(counts).toEqual({ agree: AGREES, disagree: DISAGREES, pass: PASSES, seen: SEEN })
    expect(counts.agree + counts.disagree + counts.pass).toBe(counts.seen)
  })

  test('a missing cell is no votes', () => {
    expect(voteCounts(undefined)).toEqual({ agree: 0, disagree: 0, pass: 0, seen: 0 })
  })

  test('seen is never below agrees plus disagrees', () => {
    expect(voteCounts({ A: AGREES, D: DISAGREES })).toEqual({
      agree: AGREES,
      disagree: DISAGREES,
      pass: 0,
      seen: AGREES + DISAGREES
    })
  })
})

describe('voteShares', () => {
  test('agree/disagree/pass percentages of everyone who saw the statement', () => {
    const shares = voteShares(voteCounts(cellFromVotes(generatedVotes())))
    expect(shares.agree).toBeCloseTo(AGREES / SEEN)
    expect(shares.disagree).toBeCloseTo(DISAGREES / SEEN)
    expect(shares.pass).toBeCloseTo(PASSES / SEEN)
    // 50% / 25% / 25%; the old A + D + S denominator drew 29% / 14% / 57%.
    expect(Math.round(shares.agree * PERCENT)).toBe(EXPECTED_AGREE_PERCENT)
    expect(Math.round(shares.disagree * PERCENT)).toBe(EXPECTED_DISAGREE_PERCENT)
    expect(Math.round(shares.pass * PERCENT)).toBe(EXPECTED_PASS_PERCENT)
  })

  test('all zero when nobody saw the statement', () => {
    expect(voteShares(voteCounts({}))).toEqual({ agree: 0, disagree: 0, pass: 0 })
  })
})
