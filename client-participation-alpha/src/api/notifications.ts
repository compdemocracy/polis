import PolisNet from '../lib/net'

export interface SubscribeNotificationResponse {
  status: string
  message?: string
  [key: string]: unknown
}

export async function subscribeToNotifications(payload: {
  conversation_id: string
  email: string
  frequency?: number
}): Promise<SubscribeNotificationResponse> {
  return await PolisNet.polisPost<SubscribeNotificationResponse>('/notifications', payload)
}
