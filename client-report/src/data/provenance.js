// Generated from client-participation-alpha/src/lib/provenance.ts. Do not edit.
export function topicJobOf(key) {
    if (typeof key !== 'string')
        return null;
    const parts = key.split('#');
    return parts.length === 3 && parts[0] && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])
        ? parts[0]
        : null;
}
function topics(run) {
    return Object.values(run?.topics_by_layer || {}).flatMap((layer) => Object.values(layer || {}));
}
export function jobsInRun(run) {
    return [
        ...new Set(topics(run)
            .map((t) => topicJobOf(t.topic_key))
            .filter((id) => id !== null))
    ];
}
function timestamp(value) {
    if (typeof value !== 'string')
        return Number.NEGATIVE_INFINITY;
    // Legacy recordings omit a timezone: treat their ISO timestamp as UTC.
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
    const time = Date.parse(iso);
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}
export function pickTopicJob(runs, jobs = []) {
    const all = Object.values(runs || {}).flatMap(topics);
    const prefixes = new Set(all.map((t) => topicJobOf(t.topic_key)).filter((id) => id !== null));
    // Legacy route orders jobs by creation time, not completion time. Preserve tie order.
    const complete = jobs.find((j) => j.status === 'COMPLETED' && prefixes.has(j.jobId));
    if (complete)
        return complete.jobId;
    let result = null, latest = Number.NEGATIVE_INFINITY;
    for (const topic of all) {
        const id = topicJobOf(topic.topic_key), time = timestamp(topic.created_at);
        if (id && (result === null || time > latest)) {
            result = id;
            latest = time;
        }
    }
    return result;
}
export function filterRunToJob(run, jobId) {
    if (!run || !jobId)
        return null;
    const layers = {};
    for (const [layer, entries] of Object.entries(run.topics_by_layer || {})) {
        const kept = Object.fromEntries(Object.entries(entries || {}).filter(([, topic]) => topicJobOf(topic.topic_key) === jobId));
        if (Object.keys(kept).length)
            layers[layer] = kept;
    }
    if (!Object.keys(layers).length)
        return null;
    return { ...run, topics_by_layer: layers };
}
export function sectionTopicJob(key) {
    if (typeof key !== 'string')
        return null;
    // Rightmost numeric coordinates only: job ids themselves may contain '_'.
    const match = /^(.+)_\d+_\d+$/.exec(key);
    return match?.[1] || null;
}
export function vizJobFor(jobs, jobId) {
    return jobId ? jobs?.find((job) => job.jobId === jobId) || null : null;
}
