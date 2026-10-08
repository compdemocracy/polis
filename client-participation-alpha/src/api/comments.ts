import { uiLanguage } from '../lib/lang'
import PolisNet from '../lib/net'
import type { Comment, NextCommentResponse } from './types'
import { toWire, type Vote } from './votes'

export async function fetchComments(
  conversationId: string,
  options: { moderation?: boolean; include_voting_patterns?: boolean } = {}
): Promise<Comment[]> {
  const params: Record<string, string | boolean> = {
    conversation_id: conversationId
  }

  if (options.moderation !== undefined) {
    params.moderation = options.moderation
  }
  if (options.include_voting_patterns !== undefined) {
    params.include_voting_patterns = options.include_voting_patterns
  }

  return await PolisNet.polisGet<Comment[]>('/comments', params)
}

export async function fetchNextComment(
  conversationId: string,
  lang?: string,
  initialTid?: number | string
): Promise<NextCommentResponse & { initialStatus?: 'eligible' | 'voted' | 'unavailable' }> {
  const params: Record<string, string> = {
    conversation_id: conversationId
  }

  if (initialTid !== undefined) params.initial_tid = String(initialTid)

  // Auto-detect language only if not provided (undefined)
  const detectedLang = lang !== undefined ? lang : uiLanguage()
  if (detectedLang) {
    params.lang = detectedLang
  }

  return await PolisNet.polisGet<NextCommentResponse>('/nextComment', params)
}

export async function submitComment(payload: {
  conversation_id: string
  txt: string
  pid: number
  is_seed?: boolean
  /** The author's own vote on the new comment, sent as its wire number. */
  vote?: Vote
  agid?: number
}): Promise<unknown> {
  const body = payload.vote === undefined ? payload : { ...payload, vote: toWire(payload.vote) }
  return await PolisNet.polisPost('/comments', body)
}
