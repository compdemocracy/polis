/**
 * One reading of the engine's per-comment vote cell, for the whole report.
 *
 * The math engine publishes, per group and per comment, a cell { A, D, S }:
 *   A = agrees, D = disagrees, S = SEEN (agrees + disagrees + passes).
 * S is not a third kind of vote: it already contains A and D. Adding A + D + S
 * counts every agree and disagree twice. Passes are S - (A + D).
 *
 * The vote values the API stores and returns (database sign) are named here so
 * that nothing outside this file spells them as bare literals.
 */

export const DB_VOTE = Object.freeze({
  AGREE: -1,
  DISAGREE: 1,
  PASS: 0,
});

/**
 * Decode one engine vote cell into named counts.
 * @param {{A?: number, D?: number, S?: number}|undefined|null} cell
 * @returns {{agree: number, disagree: number, pass: number, seen: number}}
 */
export function voteCounts(cell) {
  const agree = Number(cell?.A) || 0;
  const disagree = Number(cell?.D) || 0;
  // A cell whose S is missing or smaller than A + D still saw at least A + D.
  const seen = Math.max(Number(cell?.S) || 0, agree + disagree);
  return { agree, disagree, pass: seen - agree - disagree, seen };
}

/**
 * Shares of everyone who saw the comment (passes included in the denominator).
 * @param {{agree: number, disagree: number, pass: number, seen: number}} counts
 * @returns {{agree: number, disagree: number, pass: number}} fractions in [0, 1]
 */
export function voteShares(counts) {
  if (!counts || !counts.seen) return { agree: 0, disagree: 0, pass: 0 };
  return {
    agree: counts.agree / counts.seen,
    disagree: counts.disagree / counts.seen,
    pass: counts.pass / counts.seen,
  };
}

/**
 * Build the engine cell { A, D, S } from a list of database-sign vote values,
 * the way the math engine counts them. Used to make generated fixtures.
 * @param {number[]} votes
 * @returns {{A: number, D: number, S: number}}
 */
export function cellFromVotes(votes) {
  let A = 0;
  let D = 0;
  let S = 0;
  for (const v of votes) {
    if (v === DB_VOTE.AGREE) A += 1;
    else if (v === DB_VOTE.DISAGREE) D += 1;
    else if (v !== DB_VOTE.PASS) continue;
    S += 1;
  }
  return { A, D, S };
}
