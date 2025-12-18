import type { VoteResponse } from '../components/types'
import { uiLanguage } from '../lib/lang'
import PolisNet from '../lib/net'

export async function submitVote(payload: {
  agid: number
  conversation_id: string
  high_priority?: boolean
  lang?: string
  pid: number
  tid: number | string
  vote: number
}): Promise<VoteResponse> {
  // Auto-detect language only if not provided (undefined)
  // If lang is null or blank, don't auto-detect
  const lang = payload.lang !== undefined ? payload.lang : uiLanguage()
  const finalPayload = {
    ...payload,
    ...(lang && { lang })
  }
  return await PolisNet.polisPost<VoteResponse>('/votes', finalPayload)
}
