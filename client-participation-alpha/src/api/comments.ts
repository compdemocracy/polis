import { uiLanguage } from '../lib/lang'
import PolisNet from '../lib/net'
import type { Comment, NextCommentResponse } from './types'

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
  lang?: string
): Promise<NextCommentResponse> {
  const params: Record<string, string> = {
    conversation_id: conversationId
  }

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
  vote?: number
  agid?: number
}): Promise<unknown> {
  return await PolisNet.polisPost('/comments', payload)
}
