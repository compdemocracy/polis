/*
 * Every request the topic map makes, and what each answer means on the page.
 * No DOM and no Solid here, so the tests run in Node. Each request is sent
 * with no credential (a report's map is public to whoever has the report id),
 * unless a host hands the component a token (`token`, for a signed-in
 * moderator's placement); this page never does.
 *
 * 1. The map, once per report, run and comment rule:
 *      GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id> | &selection=<rule>]
 *    A named run has its own comment rule, so job_id and selection are never
 *    sent together (the route refuses the pair).
 * 2. The report's runs that have a stored map, once per report, by the page
 *    shell (the chooser), never by the component:
 *      GET /api/v3/delphi/topicMap?report_id=<id>&list=jobs
 * 3. Comment text for the tooltips, at the first pointer move over the map,
 *    once per drawn map and reader, kept in memory by the component:
 *      GET /api/v3/reports?report_id=<id>        (for its conversation_id and
 *                                                  mod_level; skipped only when
 *                                                  the host gives both)
 *      GET /api/v3/comments?conversation_id=<conversation id>&report_id=<id>&moderation=true&mod_gt=<mod_level>
 *    the comment list as the report pages ask for it (client-report app.jsx
 *    getComments), with the report's own moderation level as mod_gt, so a
 *    tooltip never shows a comment's text the report would not show that
 *    reader. To anyone but the conversation's moderators it holds only the
 *    comments participants can see. The report pages also send
 *    include_voting_patterns, which adds vote counts to the same rows; the
 *    tooltips need none, so it is left out. When no moderation level can be
 *    had, no comment text is asked for.
 * Nothing else: no datamapplot listing.
 */
export const TOPIC_MAP_PATH = "/api/v3/delphi/topicMap";
export const REPORTS_PATH = "/api/v3/reports";
export const COMMENTS_PATH = "/api/v3/comments";
export const SCHEMA = "polis-topic-map/1";

/* The comment rules a map can be made under, as the route names them. */
export const SELECTIONS = ["participant_visible", "all_but_moderated_out", "all_comments"];

export const TEXT = {
  loading: "Loading the topic map…",
  noMapReport: "No topic map is stored for this report yet.",
  noMapRun: "No topic map is stored for this run yet.",
  notReady: "This run has not finished yet.",
  noReport: "There is no report at this address.",
  noRun: "This report has no run with that id.",
  busy: "Too many requests for the topic map just now. Reload the page in a moment.",
  badAddress: "The topic map cannot read this address.",
  notPublic: "The topic map of this run is not public.",
  tooLarge: "The topic map of this run is too large to send.",
  unreadable: "The stored topic map of this run could not be read.",
  failed: "The topic map could not be loaded.",
  undrawable: "The topic map could not be drawn.",
  moderatedOut: "Moderated out",
};

/* The route's own 404 bodies; any other 404 is Node's, which is what the
   address answers while the route is switched off. */
const ROUTE_404 = {
  "Could not find conversation for report_id": "noReport",
  "Job not found": "noRun",
  polis_err_topic_map_no_source: "noMapReport",
};

const selectionOrNull = (s) => (SELECTIONS.includes(s) ? s : null);

/* What the component asks for, from its props: null when it asks nothing
   (it was handed a document, or has no report). */
export function mapRequest({ reportId, jobId, selection, document } = {}) {
  if (document || !reportId) return null;
  if (jobId) return { reportId, jobId, selection: null };
  return { reportId, jobId: null, selection: selectionOrNull(selection) };
}

export function topicMapUrl(reportId, { jobId = null, selection = null } = {}, origin = "") {
  const query = new URLSearchParams({ report_id: reportId });
  if (jobId) query.set("job_id", jobId);
  else if (selectionOrNull(selection)) query.set("selection", selection);
  return `${origin}${TOPIC_MAP_PATH}?${query}`;
}

export function jobListUrl(reportId, origin = "") {
  return `${origin}${TOPIC_MAP_PATH}?${new URLSearchParams({ report_id: reportId, list: "jobs" })}`;
}

export function reportUrl(reportId, origin = "") {
  return `${origin}${REPORTS_PATH}?${new URLSearchParams({ report_id: reportId })}`;
}

/* A report's moderation level (reports.mod_level), sent as the report pages
   send it: Node keeps comments whose mod is greater (-2: every comment, -1:
   those not moderated out, 0: those moderated in). Not an integer: none. */
export const modLevelOrNull = (level) => (Number.isInteger(level) ? level : null);

export function commentsUrl(conversationId, reportId, modLevel, origin = "") {
  const query = new URLSearchParams({
    conversation_id: conversationId,
    report_id: reportId,
    moderation: "true",
    mod_gt: String(modLevel),
  });
  return `${origin}${COMMENTS_PATH}?${query}`;
}

/* The state the page shows for one answer of the map request:
   { kind, text?, doc? }; kind is "map", "none" (nothing to draw, said
   quietly) or "refused". */
export function answerToState(status, body, jobId) {
  const noMap = { kind: "none", text: jobId ? TEXT.noMapRun : TEXT.noMapReport };
  if (status === 200) {
    if (body && body.schema === SCHEMA) return { kind: "map", doc: body };
    if (body && typeof body.reason === "string") {
      if (body.reason === "no_run" || body.reason === "not_stored") return noMap;
      if (body.reason === "run_not_ready") return { kind: "none", text: TEXT.notReady };
      if (typeof body.message === "string" && body.message) return { kind: "none", text: body.message + "." };
      return noMap;
    }
    return { kind: "refused", text: TEXT.failed };
  }
  if (status === 404) {
    const known = body && typeof body.message === "string" ? ROUTE_404[body.message] : undefined;
    if (known === "noReport" || known === "noRun") return { kind: "refused", text: TEXT[known] };
    return noMap; // the route switched off (Node's 404), or no map source
  }
  if (status === 429 || status === 503) return { kind: "refused", text: TEXT.busy };
  if (status === 400) return { kind: "refused", text: TEXT.badAddress };
  if (status === 401 || status === 403) return { kind: "refused", text: TEXT.notPublic };
  if (status === 422) return { kind: "refused", text: TEXT.tooLarge };
  if (status === 500) return { kind: "refused", text: TEXT.unreadable };
  return { kind: "refused", text: TEXT.failed };
}

function init(token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: "GET", credentials: "omit", headers };
}

/* One GET; { status, body } with body null when it is not JSON, or null when
   the request itself failed. Never throws. */
async function getJson(fetchFn, url, token) {
  let response;
  try {
    response = await fetchFn(url, init(token));
  } catch (e) {
    return null;
  }
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  return { status: response.status, body };
}

/* Asks for the map once and returns the state; never throws. */
export async function readTopicMap(fetchFn, request, { origin = "", token = null } = {}) {
  const answer = await getJson(fetchFn, topicMapUrl(request.reportId, request, origin), token);
  if (!answer) return { kind: "refused", text: TEXT.failed };
  return answerToState(answer.status, answer.body, request.jobId);
}

/* One run of the list, or null when the entry is not one this page can read. */
function readJob(j) {
  if (!j || typeof j.job_id !== "string" || !j.job_id) return null;
  const names = j.names && typeof j.names === "object" ? j.names : {};
  return {
    jobId: j.job_id,
    source: j.source === "shadow" ? "shadow" : "served",
    selection: selectionOrNull(j.selection),
    createdAt: typeof j.created_at === "string" ? j.created_at : null,
    points: Number.isInteger(j.points) && j.points >= 0 ? j.points : null,
    levels: Array.isArray(j.levels) ? j.levels.filter((n) => Number.isInteger(n)) : [],
    namesBy: ["keywords", "model", "none"].includes(names.by) ? names.by : null,
    model: typeof names.model === "string" && names.model ? names.model : null,
    current: j.current === true,
  };
}

/* The list's answer: { kind: "jobs", jobs } (newest first, as sent), or
   { kind: "none" } for every other answer: the route not answering the list
   yet (404, or 400 from a route that does not know `list`), switched off,
   busy, refused, unreadable or unreachable. Never throws. */
export function answerToJobs(status, body) {
  if (status !== 200 || !body || !Array.isArray(body.jobs)) return { kind: "none" };
  const jobs = body.jobs.map(readJob).filter(Boolean);
  return { kind: "jobs", jobs };
}

export async function readJobList(fetchFn, reportId, { origin = "", token = null } = {}) {
  const answer = await getJson(fetchFn, jobListUrl(reportId, origin), token);
  if (!answer) return { kind: "none" };
  return answerToJobs(answer.status, answer.body);
}

/* Comment text by comment id, from the comment list filtered by the report's
   moderation level; an empty Map when any step does not answer with what it
   should. The report is read unless the host gives both its conversation id
   and its moderation level. Never throws. */
export async function readCommentText(
  fetchFn,
  reportId,
  { conversationId = null, modLevel = null, origin = "", token = null } = {},
) {
  const text = new Map();
  let conversation = conversationId;
  let level = modLevelOrNull(modLevel);
  if (!conversation || level === null) {
    const report = await getJson(fetchFn, reportUrl(reportId, origin), token);
    const row = report && report.status === 200 && Array.isArray(report.body) ? report.body[0] : null;
    conversation = row && typeof row.conversation_id === "string" ? row.conversation_id : null;
    level = row ? modLevelOrNull(row.mod_level) : null;
    if (!conversation || level === null) return text;
  }
  const comments = await getJson(fetchFn, commentsUrl(conversation, reportId, level, origin), token);
  if (!comments || comments.status !== 200 || !Array.isArray(comments.body)) return text;
  for (const c of comments.body) {
    if (c && Number.isInteger(c.tid) && typeof c.txt === "string") text.set(c.tid, c.txt);
  }
  return text;
}

/* The page's address:
   /topicsVizReport/<report id>?job_id=<id>&selection=<rule>&theme=light|dark&chooser=0 */
export function fromAddress(pathname, search) {
  const m = /^\/topicsVizReport\/(r?[0-9][0-9A-Za-z]+)/.exec(pathname || "");
  const q = new URLSearchParams(search || "");
  return {
    reportId: m ? m[1] : null,
    jobId: q.get("job_id") || null,
    selection: selectionOrNull(q.get("selection")),
    theme: q.get("theme"),
    chooser: q.get("chooser") !== "0",
  };
}

/* The address after a run is chosen: job_id set (or removed for the current
   map), selection removed (a named run has its own), everything else kept. */
export function addressWithJob(search, jobId) {
  const q = new URLSearchParams(search || "");
  q.delete("selection");
  if (jobId) q.set("job_id", jobId);
  else q.delete("job_id");
  const s = q.toString();
  return s ? `?${s}` : "";
}
