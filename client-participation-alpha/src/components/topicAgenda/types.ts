import type { Topic } from '../../api/types'
import type { Translations } from '../../strings/types'

// From topicUtils.ts
export interface Point {
  x: number
  y: number
}

export interface UmapPoint {
  umap_x: number
  umap_y: number
  comment_id?: string | number
  comment_text?: string
  [key: string]: unknown
}

export interface TopicEntry {
  clusterId: string | number
  topic: Topic
  proximityScore?: number | null
  closestBankedTopic?: string | null
}

// From archetypeExtraction.ts
export interface Archetype {
  commentId: string | number
  text: string
  distance: number
  coordinates: { x: number; y: number }
}

export interface ArchetypeGroup {
  topicKey: string
  layerId: number
  clusterId: string
  archetypes: Archetype[]
}

export interface SerializedAnchor {
  commentId: string | number
  text: string
  coordinates: { x: number; y: number }
  sourceLayer: number
  sourceCluster: string
}

export interface SerializedArchetypes {
  version: number
  timestamp: string
  anchors: SerializedAnchor[]
  totalSelections: number
}

// From topicFiltering.ts
export interface FilteredTopic {
  clusterId: string
  topic: Topic
  proximityScore: number | null
  closestBankedTopic?: string | null
  source: 'all' | 'close' | 'far'
}

// From TopicAgenda.tsx
export interface TopicAgendaComment {
  tid: number
  txt: string
  [key: string]: unknown
}

export interface ReportData {
  report_id?: string
  conversation_id?: string
}

export interface TopicAgendaProps {
  conversation_id: string
  requiresInviteCode?: boolean
  s: Translations
}

export interface TopicPrioritizeResponse {
  has_report?: boolean
  report_id?: string
  conversation_id?: string
}

export interface DelphiResponse {
  status: string
  runs?: Record<string, unknown>
  [key: string]: unknown
}

export interface SelectionsResponse {
  status: string
  data?: {
    archetypal_selections: Array<{ topic_key: string }>
  }
  message?: string
}
