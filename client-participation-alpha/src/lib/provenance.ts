import type { DelphiJobResult } from '../api/delphi.types'
// Legacy CLI runs all use 'unknown_job'; this prefix cannot distinguish those runs.
// Interim legacy derivation. P3 reuse requires explicit root/producer bindings.
type Id = NonNullable<DelphiJobResult['job_id']>
export type LegacyTopic = { topic_key?: unknown; created_at?: unknown; [key: string]: unknown }
export type LegacyRun = {
  topics_by_layer?: Record<string, Record<string, LegacyTopic>>
  [key: string]: unknown
}
export type LegacyJob = {
  jobId: Id
  status?: string
  visualizations?: unknown[]
  [key: string]: unknown
}
export function topicJobOf(key: unknown): Id | null {
  if (typeof key !== 'string') return null
  const parts = key.split('#')
  return parts.length === 3 && parts[0] && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])
    ? parts[0]
    : null
}
function topics(run: LegacyRun | null | undefined): LegacyTopic[] {
  return Object.values(run?.topics_by_layer || {}).flatMap((layer) => Object.values(layer || {}))
}
export function jobsInRun(run: LegacyRun | null | undefined): Id[] {
  return [
    ...new Set(
      topics(run)
        .map((t) => topicJobOf(t.topic_key))
        .filter((id): id is Id => id !== null)
    )
  ]
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY
  // Legacy recordings omit a timezone: treat their ISO timestamp as UTC.
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}
export function pickTopicJob(
  runs: Record<string, LegacyRun> | null | undefined,
  jobs: LegacyJob[] = []
): Id | null {
  const all = Object.values(runs || {}).flatMap(topics)
  const prefixes = new Set(
    all.map((t) => topicJobOf(t.topic_key)).filter((id): id is Id => id !== null)
  )
  // Legacy route orders jobs by creation time, not completion time. Preserve tie order.
  const complete = jobs.find((j) => j.status === 'COMPLETED' && prefixes.has(j.jobId))
  if (complete) return complete.jobId
  let result: Id | null = null,
    latest = Number.NEGATIVE_INFINITY
  for (const topic of all) {
    const id = topicJobOf(topic.topic_key),
      time = timestamp(topic.created_at)
    if (id && (result === null || time > latest)) {
      result = id
      latest = time
    }
  }
  return result
}
export function filterRunToJob(
  run: LegacyRun | null | undefined,
  jobId: Id | null
): LegacyRun | null {
  if (!run || !jobId) return null
  const layers: Record<string, Record<string, LegacyTopic>> = {}
  for (const [layer, entries] of Object.entries(run.topics_by_layer || {})) {
    const kept = Object.fromEntries(
      Object.entries(entries || {}).filter(([, topic]) => topicJobOf(topic.topic_key) === jobId)
    )
    if (Object.keys(kept).length) layers[layer] = kept
  }
  if (!Object.keys(layers).length) return null
  return { ...run, topics_by_layer: layers }
}
export function sectionTopicJob(key: unknown): Id | null {
  if (typeof key !== 'string') return null
  // Rightmost numeric coordinates only: job ids themselves may contain '_'.
  const match = /^(.+)_\d+_\d+$/.exec(key)
  return match?.[1] || null
}
export function vizJobFor(
  jobs: LegacyJob[] | null | undefined,
  jobId: Id | null
): LegacyJob | null {
  return jobId ? jobs?.find((job) => job.jobId === jobId) || null : null
}
