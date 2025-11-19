import PolisNet from '../lib/net';

export interface Comment {
  txt: string;
  tid: number;
  created: number;
  quote_src_url: string | null;
  is_seed: boolean;
  is_meta: boolean;
  lang: string;
  pid: number;
}

export async function fetchComments(conversationId: string): Promise<Comment[]> {
  return await PolisNet.polisGet('/comments', { conversation_id: conversationId });
}

