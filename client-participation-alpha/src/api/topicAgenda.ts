import PolisNet from '../lib/net'
import type { SelectionsResponse, TopicPrioritizeResponse } from './types'

export async function fetchTopicPrioritize(
  conversationId: string
): Promise<TopicPrioritizeResponse> {
  return await PolisNet.polisGet<TopicPrioritizeResponse>('/participation/topicPrioritize', {
    conversation_id: conversationId
  })
}

export async function fetchTopicAgendaSelections(
  conversationId: string
): Promise<SelectionsResponse> {
  return await PolisNet.polisGet<SelectionsResponse>('/topicAgenda/selections', {
    conversation_id: conversationId
  })
}

export async function saveTopicAgendaSelections(payload: {
  conversation_id: string
  selections: Array<{
    layer_id: number
    cluster_id: string
    topic_key: string
    archetypal_comments: Array<{
      comment_id: string | number
      comment_text: string
      coordinates: { x: number; y: number }
      distance_to_centroid: number
    }>
  }>
}): Promise<SelectionsResponse> {
  return await PolisNet.polisPost<SelectionsResponse>('/topicAgenda/selections', payload)
}
