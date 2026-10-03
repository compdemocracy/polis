/**
 * The one consensus number the report ranks comments by: the math engine's
 * `group-aware-consensus`, as served by /api/v3/math/pca2.
 *
 * The client-computed `group-consensus-normalized` (util/normalizeConsensus.js)
 * stays only where it is a threshold or an axis that was calibrated to it: the
 * collective-statement eligibility gate and the bipolar topic plots. It is not
 * used to order comments or topics.
 */

export const MATH_CONSENSUS_KEY = "group-aware-consensus";

/** @returns {Object<string, number>} tid -> consensus, or {} */
export function getMathConsensus(math) {
  return math?.[MATH_CONSENSUS_KEY] || {};
}

/** Consensus for one comment, or undefined when the engine has none. */
export function mathConsensusFor(math, tid) {
  return getMathConsensus(math)[tid];
}

