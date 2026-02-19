import PolisNet from '../lib/net'
import type { DelphiResponse, TopicData } from './types'

export async function fetchDelphiReport(reportId: string): Promise<DelphiResponse> {
  return await PolisNet.polisGet<DelphiResponse>('/delphi', {
    report_id: reportId
  })
}

export async function fetchTopicModProximity(
  conversationId: string,
  layerId: string = 'all'
): Promise<unknown> {
  return await PolisNet.polisGet('/topicMod/proximity', {
    conversation_id: conversationId,
    layer_id: layerId
  })
}

export async function fetchDelphiTopicData(reportId: string): Promise<TopicData> {
  return await PolisNet.polisGet<TopicData>('/delphi', {
    report_id: reportId
  })
}
