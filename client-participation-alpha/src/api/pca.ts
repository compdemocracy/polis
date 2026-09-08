import PolisNet from '../lib/net'
import type { PCAData } from './types'

/**
 * Field names of the decoded `GET /api/v3/math/pca2` body, in the wire order
 * pinned by the P-032 slice-1 contract.
 *
 * Source of truth: cost-reduction/04-plans/P-032-slice1-pca2.md ("Decoded
 * schemas and exact order") and the `required` list of
 * cost-reduction/04-plans/p032-slice1/decoded-empty.schema.json, which is a
 * closed Draft-07 schema naming all 17 full properties.
 *
 * Anything sent in `keys=` that is not in this list is silently dropped by the
 * server's `_.pick` (server/src/routes/math.ts:106) — see the `keys-unknown`
 * cell recorded by slice 1. So an unknown key is not an error, it is a value
 * that never arrives.
 */
export const PCA2_WIRE_FIELDS = [
  'group-clusters',
  'base-clusters',
  'group-votes',
  'group-aware-consensus',
  'user-vote-counts',
  'in-conv',
  'n-cmts',
  'pca',
  'tids',
  'n',
  'repness',
  'consensus',
  'votes-base',
  'lastModTimestamp',
  'lastVoteTimestamp',
  'comment-priorities',
  'math_tick'
] as const

/**
 * The subset of pca2 fields the participation visualization needs.
 * `math_tick` is required for the unchanged-tick short circuit in
 * VisualizationContainer; it must be spelled exactly as it is on the wire.
 */
export const PCA_VISUALIZATION_KEYS: Array<keyof PCAData> = [
  'base-clusters',
  'group-clusters',
  'group-aware-consensus',
  'group-votes',
  'repness',
  'math_tick'
]

export async function fetchPCAData(
  conversationId: string,
  keys?: Array<keyof PCAData>
): Promise<PCAData> {
  const params: Record<string, unknown> = { conversation_id: conversationId }

  if (keys && keys.length > 0) {
    params.keys = keys.join(',')
  }

  return await PolisNet.polisGet('/math/pca2', params)
}
