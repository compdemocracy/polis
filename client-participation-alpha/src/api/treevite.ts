import PolisNet from '../lib/net'
import type { MeData } from './types'

export async function fetchTreeviteMe(conversationId: string): Promise<MeData> {
  return await PolisNet.polisGet<MeData>('/treevite/me', {
    conversation_id: conversationId
  })
}

export interface AcceptInviteResponse {
  status: string
  message?: string
  wave?: number
  [key: string]: unknown
}

export async function acceptInvite(payload: {
  conversation_id: string
  invite_code: string
}): Promise<AcceptInviteResponse> {
  return await PolisNet.polisPost<AcceptInviteResponse>('/treevite/acceptInvite', payload)
}

export interface TreeviteLoginResponse {
  status: string
  message?: string
  [key: string]: unknown
}

export async function treeviteLogin(payload: {
  conversation_id: string
  login_code: string
}): Promise<TreeviteLoginResponse> {
  return await PolisNet.polisPost<TreeviteLoginResponse>('/treevite/login', payload)
}
