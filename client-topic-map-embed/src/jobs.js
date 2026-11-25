/*
 * The page's chooser of runs, without the DOM: what each run is, in plain
 * words, and which choices the chooser offers. The component never uses this;
 * a place that embeds the component may bring its own chooser.
 */

/* Which comments a run's map was made from. */
export const SELECTION_TEXT = {
  participant_visible: "what participants see",
  all_but_moderated_out: "everything not moderated out",
  all_comments: "every comment",
};

const count = (n) => n.toLocaleString("en-US");

/* How the run's topics were named. */
export function namesText(job) {
  if (job.namesBy === "keywords") return "keyword names";
  if (job.namesBy === "model") return job.model ? job.model : "names by a model";
  return null;
}

/* When it ran, in UTC so every reader sees the same words: "2026-11-24 14:05 UTC". */
export function whenText(createdAt) {
  if (!createdAt) return null;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/* A run's map made later from its stored results, in plain words, with the
   making job's short id: null when the run has no such map. */
export function mapText(job) {
  const m = job.map;
  if (!m) return null;
  const by = m.jobId.slice(0, 8);
  if (m.status === "pending") return `map being made from this run's stored layout (${by})`;
  if (m.status === "failed") return `no map: it could not be made (${by})`;
  return `map made from this run's stored layout (${by})`;
}

/* One run in plain words, the parts the list gives, in this order: which
   comments, how the topics were named, when it ran, how many comments it
   places, and a map made later from its stored results. */
export function describeJob(job) {
  const parts = [
    job.selection ? SELECTION_TEXT[job.selection] : null,
    namesText(job),
    whenText(job.createdAt),
    job.points === null ? null : `${count(job.points)} comments`,
    mapText(job),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : job.jobId;
}

/* What the chooser shows, from the list's answer and what the page draws:
   { show: false } with fewer than two runs (or no list), else
   { show: true, choices: [{ value, text }], value }. The value "" is the
   map the page draws when no run is named; it is a choice of its own only
   when no run in the list is that map. */
export function chooserState(list, { jobId = null, selection = null } = {}) {
  if (!list || list.kind !== "jobs" || list.jobs.length < 2) return { show: false };
  const choices = list.jobs.map((j) => ({ value: j.jobId, text: describeJob(j) + (j.current ? " · current" : "") }));
  let value = null;
  if (jobId) {
    value = list.jobs.some((j) => j.jobId === jobId) ? jobId : null;
    if (value === null) choices.unshift({ value: jobId, text: `The run ${jobId}` });
    value = jobId;
  } else {
    const rule = selection || "participant_visible";
    const shown = list.jobs.find((j) => j.current && j.selection === rule);
    if (shown) value = shown.jobId;
    else {
      choices.unshift({ value: "", text: "The current map" });
      value = "";
    }
  }
  return { show: true, choices, value };
}
