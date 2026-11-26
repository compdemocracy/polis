/*
 * The answers of the topic map route for a standalone page, which opens from
 * disk and asks no host: a fetch that answers the map and the list of runs
 * from data inlined in the page, and everything else as Node answers an
 * unknown API path. Only build.mjs --standalone pages use it.
 *
 * data: { reportId, list: <the list's body>, current: <run id drawn when the
 *         page names none>, documents: { <run id>: <polis-topic-map/1 document> } }
 */
import { TOPIC_MAP_PATH } from "./load.js";

const answer = (status, body) => ({ status, json: async () => (body === null ? Promise.reject(new SyntaxError("not JSON")) : body) });

export function offlineFetch(data) {
  return async (url) => {
    const u = new URL(url, "file:///");
    if (u.pathname !== TOPIC_MAP_PATH || u.searchParams.get("report_id") !== data.reportId) return answer(404, null);
    if (u.searchParams.get("list") === "jobs") return answer(200, data.list);
    const jobId = u.searchParams.get("job_id") || data.current;
    const doc = data.documents[jobId];
    return doc ? answer(200, doc) : answer(404, { status: "error", message: "Job not found" });
  };
}
