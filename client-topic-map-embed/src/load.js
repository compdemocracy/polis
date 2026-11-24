/*
 * The one request the topic map makes, and what each answer of the route
 * means on the page. No DOM and no Solid here, so the tests run in Node.
 *
 * GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>], once, with no
 * credential: the route serves a report's map to anyone who has the report
 * id. The page asks nothing else (no datamapplot listing, no comments).
 */
export const TOPIC_MAP_PATH = "/api/v3/delphi/topicMap";
export const SCHEMA = "polis-topic-map/1";

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
};

/* The route's own 404 bodies; any other 404 is Node's, which is what the
   address answers while the route is switched off. */
const ROUTE_404 = {
  "Could not find conversation for report_id": "noReport",
  "Job not found": "noRun",
  polis_err_topic_map_no_source: "noMapReport",
};

export function topicMapUrl(reportId, jobId, origin = "") {
  const query = new URLSearchParams({ report_id: reportId });
  if (jobId) query.set("job_id", jobId);
  return `${origin}${TOPIC_MAP_PATH}?${query}`;
}

/* The state the page shows for one answer: { kind, text?, doc? }.
   kind is "map", "none" (nothing to draw, said quietly) or "refused". */
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

/* Asks the route once and returns the state; never throws. */
export async function readTopicMap(fetchFn, reportId, jobId, origin = "") {
  let response;
  try {
    response = await fetchFn(topicMapUrl(reportId, jobId, origin), {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    return { kind: "refused", text: TEXT.failed };
  }
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  return answerToState(response.status, body, jobId);
}

/* The report id and the optional run from the page's address:
   /topicsVizReport/<report id>?job_id=<id>&theme=light|dark */
export function fromAddress(pathname, search) {
  const m = /^\/topicsVizReport\/(r?[0-9][0-9A-Za-z]+)/.exec(pathname || "");
  const q = new URLSearchParams(search || "");
  return {
    reportId: m ? m[1] : null,
    jobId: q.get("job_id") || null,
    theme: q.get("theme"),
  };
}
