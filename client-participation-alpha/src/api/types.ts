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
  // All five are `required` in the empty-cell schema, so the contract does not
  // sanction an absent `members`. It stays optional here as *compatibility
  // typing* — existing callers guard it, and tightening it would be a
  // behaviour question, not a typing one. Do not read this `?` as evidence
  // that the field may be missing on the wire.
  members?: number[][]
}

/**
 * `pca` sub-object. Empty-branch shapes are pinned by the closed schema:
 * `comps` is `[[], []]`, `center` is `[0, 0]`, `comment-extremity` is zeros of
 * `tids.length`, and `comment-projection` is the empty object `{}`.
 *
 * Populated element types are NOT established by that schema — P-032-slice1
 * says so explicitly ("Empty collections do not establish populated element
 * types", "null, absence, empty arrays and empty objects remain distinct").
 * The populated arms below are read off real math output
 * (delphi/real_data/*_math_blob.json), where `comment-projection` is a
 * 2 x n array of numbers rather than a map — the empty `{}` and the populated
 * array really are different JSON types, so both arms are declared.
 */
export interface PCAComponents {
  comps: number[][]
  center: number[]
  'comment-extremity': number[]
  'comment-projection': number[][] | Record<string, never>
}

export interface ConsensusGroups {
  agree: ConsensusItem[]
  disagree: ConsensusItem[]
}

/** Per-base-cluster vote tallies for one statement. */
export interface VotesBaseEntry {
  A: number[] // Agree, one entry per base cluster
  D: number[] // Disagree
  S: number[] // Skip
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

/**
 * The full decoded body of `GET /api/v3/math/pca2`.
 *
 * Field set and empty-branch types come from the P-032 slice-1 contract:
 * cost-reduction/04-plans/p032-slice1/decoded-empty.schema.json is a closed
 * Draft-07 schema (`additionalProperties: false`) whose `required` list names
 * all seventeen properties, and cost-reduction/04-plans/P-032-slice1-pca2.md
 * quotes the same seventeen in wire order. In full mode (no `keys` parameter)
 * every one of them is present, so every property here is required.
 *
 * Caveat carried from the contract, and it applies to the field *set* as well
 * as the field types: that schema pins the **empty-math cell only**
 * (MATH_ENV=p027, math_tick=0, n=0). Seventeen is what that cell is closed
 * over; it is not proof that every production full-mode blob carries exactly
 * these seventeen and no others. Populated schemas "need review before a
 * general generated client type is approved", so this interface is a
 * contract-derived belief about full mode, not an admitted full-mode contract.
 * Where the schema shows only an empty collection, the element types below are
 * read off real math output (delphi/real_data/*_math_blob.json) and are the
 * client's best current belief.
 *
 * This interface is erased at runtime: nothing here validates a response.
 */
export interface PCA2FullResponse {
  'group-clusters': GroupCluster[]
  'base-clusters': BaseClusters
  /** group id -> that group's vote tallies */
  'group-votes': {
    [groupId: string]: GroupVotes
  }
  /** tid -> group-aware consensus score */
  'group-aware-consensus': {
    [tid: string]: number
  }
  /** pid -> number of votes cast */
  'user-vote-counts': {
    [pid: string]: number
  }
  /** pids counted as in-conversation */
  'in-conv': number[]
  'n-cmts': number
  pca: PCAComponents
  tids: number[]
  n: number
  /** group id -> representative statements for that group */
  repness: {
    [groupId: string]: RepnessItem[]
  }
  consensus: ConsensusGroups
  /** tid -> per-base-cluster tallies */
  'votes-base': {
    [tid: string]: VotesBaseEntry
  }
  /** null in the recorded empty branch; a ms epoch when moderation has run */
  lastModTimestamp: number | null
  lastVoteTimestamp: number
  /** tid -> priority weight */
  'comment-priorities': {
    [tid: string]: number
  }
  /** Integer per the schema. The wire name is `math_tick`, never `mathTick`. */
  math_tick: number
}

/**
 * Subset mode: when `keys=` is sent, the server returns `_.pick(body, keys)`,
 * so nothing is guaranteed and unknown keys are dropped silently.
 */
export type PCA2SubsetResponse = Partial<PCA2FullResponse>

/**
 * What the participation visualization consumes. It is a subset response —
 * VisualizationContainer always sends `keys` — narrowed by the two fields it
 * asks for and then dereferences without a guard.
 */
export interface PCAData extends PCA2SubsetResponse {
  'base-clusters': BaseClusters
  'group-clusters': GroupCluster[]
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
