import { uiLanguage } from '../lib/lang'
import PolisNet from '../lib/net'
import type { ParticipationInitData } from './types'

export async function fetchParticipationInit(
  conversationId: string,
  options: {
    includePCA?: boolean
    lang?: string
    xid?: string
    x_name?: string
    x_profile_image_url?: string
  } = {}
): Promise<ParticipationInitData> {
  // Auto-detect language only if not provided (undefined)
  const lang = options.lang !== undefined ? options.lang : uiLanguage()
  const params: Record<string, string | boolean> = {
    conversation_id: conversationId,
    ...(options.includePCA !== undefined && { includePCA: options.includePCA }),
    ...(lang && { lang }),
    ...(options.xid !== undefined && { xid: options.xid }),
    ...(options.x_name !== undefined && { x_name: options.x_name }),
    ...(options.x_profile_image_url !== undefined && {
      x_profile_image_url: options.x_profile_image_url
    })
  }
  return await PolisNet.polisGet<ParticipationInitData>('/participationInit', params)
}
