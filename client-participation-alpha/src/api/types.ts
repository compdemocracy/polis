export interface Comment {
  txt: string
  tid: number
  created: number
  quote_src_url: string | null
  is_seed: boolean
  is_meta: boolean
  lang: string
  pid: number
}

export interface GroupCluster {
  id: number
  center: number[]
  members: number[]
}

export interface BaseClusters {
  x: number[]
  y: number[]
  id: number[]
  count: number[]
  members?: number[][]
}

export interface ConsensusItem {
  tid: number
  'n-success': number
  'n-trials': number
  'p-success': number
  'p-test': number
}

export interface GroupVotes {
  'n-members': number
  votes: {
    [tid: string]: {
      A: number // Agree
      D: number // Disagree
      S: number // Skip
    }
  }
}

export interface RepnessItem {
  tid: number
  'n-agree'?: number
  'n-success': number
  'n-trials': number
  'p-success': number
  'p-test': number
  repness: number
  'repness-test': number
  'repful-for': 'agree' | 'disagree'
  'best-agree'?: boolean
}

export interface PCAData {
  'base-clusters': BaseClusters
  'group-clusters': GroupCluster[]
  'group-aware-consensus'?: {
    [tid: string]: number
  }
  'group-votes'?: {
    [groupId: string]: GroupVotes
  }
  repness?: {
    [groupId: string]: RepnessItem[]
  }
  mathTick?: number
}

export interface Topic {
  topic_name: string
  topic_key: string
  cluster_id: string
  model_name: string
  [key: string]: unknown
}

export interface Run {
  topics_by_layer: Record<string, Record<string, Topic>>
  model_name: string
  created_at: string
  job_uuid: string
  [key: string]: unknown
}

export interface TopicData {
  runs: Record<string, Run>
  status?: string
  [key: string]: unknown
}

export interface HierarchyAnalysis {
  hasHierarchy: boolean
  reason: string
  layers?: number[]
  layerCounts?: Record<number, number>
  sampleTopics?: Record<
    number,
    { name: string; key: string; cluster_id: string; model_name: string }[]
  >
  totalComments?: number
  structure?: string
  runInfo?: {
    model_name: string
    created_at: string
    job_uuid: string
  }
}

export interface ParticipationInitData {
  conversation: {
    topic: string
    description: string
    treevite_enabled: boolean
    is_active: boolean
    conversation_id: string
    vis_type: number
    [key: string]: unknown
  }
  nextComment?: {
    tid: number
    txt: string
    remaining?: number
    lang?: string
    translations?: {
      zid: number
      tid: number
      src: number
      txt: string
      lang: string
      created: string
      modified: string
    }[]
  }
  auth?: {
    token?: string
  }
  acceptLanguage?: string
  [key: string]: unknown
}

export interface TopicPrioritizeResponse {
  status: string
  conversation_id?: string
  report_id?: string
  has_report?: boolean
  has_delphi_data?: boolean
  report_created?: string
  message?: string
}

export interface SelectionsResponse {
  status: string
  data?: {
    archetypal_selections: Array<{ topic_key: string }>
  }
  message?: string
}

export interface MeData {
  wave?: {
    wave: number
    joined_at: string
  }
  invites?: {
    id: number | string
    invite_code: string
    status: number
  }[]
}

export interface NextCommentResponse {
  tid?: number
  txt: string
  remaining?: number
  created?: string
  quote_src_url?: string | null
  is_seed?: boolean
  is_meta?: boolean
  lang?: string
  pid?: number
  randomN?: number
  total?: number
  translations?: {
    zid: number
    tid: number
    src: number
    txt: string
    lang: string
    created: string
    modified: string
  }[]
}

export interface DelphiResponse {
  status: string
  message?: string
  report_id?: string
  runs?: Record<string, unknown>
  [key: string]: unknown
}
