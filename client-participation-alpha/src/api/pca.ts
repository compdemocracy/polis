import PolisNet from '../lib/net'
import type { PCAData } from './types'

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
