import { test } from "node:test";
import assert from "node:assert/strict";
import { answerToState, fromAddress, readTopicMap, TEXT, topicMapUrl } from "../src/load.js";

const DOC = { schema: "polis-topic-map/1", levels: [], topics: [], points: { id: [], x: [], y: [], topic: [], text: [] } };

function fakeFetch(status, body, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError("not JSON");
        return body;
      },
    };
  };
}

test("asks the topic map route once, with the report id and nothing else", async () => {
  const calls = [];
  const state = await readTopicMap(fakeFetch(200, DOC, calls), "r4zhhxpdu7hdxhnhfxiva", null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v3/delphi/topicMap?report_id=r4zhhxpdu7hdxhnhfxiva");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(state, { kind: "map", doc: DOC });
});

test("a named run adds job_id and no source", () => {
  const url = topicMapUrl("r4zh", "f5387f40-25d2-478e-82fe-19f4b2fb5984");
  assert.equal(url, "/api/v3/delphi/topicMap?report_id=r4zh&job_id=f5387f40-25d2-478e-82fe-19f4b2fb5984");
  assert.ok(!url.includes("source="));
  assert.ok(!url.includes("visualizations"));
});

test("nothing to draw is said quietly, for the report or for the run", () => {
  for (const reason of ["no_run", "not_stored"]) {
    assert.deepEqual(answerToState(200, { status: "success", reason, message: "x" }, null), { kind: "none", text: TEXT.noMapReport });
    assert.deepEqual(answerToState(200, { status: "success", reason, message: "x" }, "job"), { kind: "none", text: TEXT.noMapRun });
  }
  assert.deepEqual(answerToState(200, { reason: "run_not_ready", message: "The Delphi run has not finished" }, "job"), {
    kind: "none",
    text: TEXT.notReady,
  });
  assert.deepEqual(answerToState(200, { reason: "too_few_comments", message: "Too few comments to draw a topic map" }, null), {
    kind: "none",
    text: "Too few comments to draw a topic map.",
  });
});

test("the route switched off reaches Node's 404, shown as no map stored", () => {
  assert.deepEqual(answerToState(404, null, null), { kind: "none", text: TEXT.noMapReport });
  assert.deepEqual(answerToState(404, { status: "error", message: "polis_err_topic_map_no_source" }, null), {
    kind: "none",
    text: TEXT.noMapReport,
  });
});

test("the route's own not-found answers say what was not found", () => {
  assert.deepEqual(answerToState(404, { status: "error", message: "Could not find conversation for report_id" }, null), {
    kind: "refused",
    text: TEXT.noReport,
  });
  assert.deepEqual(answerToState(404, { status: "error", message: "Job not found" }, "j"), { kind: "refused", text: TEXT.noRun });
});

test("every refusal has its plain words", () => {
  assert.equal(answerToState(503, { message: "polis_err_topic_map_busy" }).text, TEXT.busy);
  assert.equal(answerToState(429, null).text, TEXT.busy);
  assert.equal(answerToState(400, { message: "report_id is required" }).text, TEXT.badAddress);
  assert.equal(answerToState(401, {}).text, TEXT.notPublic);
  assert.equal(answerToState(403, {}).text, TEXT.notPublic);
  assert.equal(answerToState(422, {}).text, TEXT.tooLarge);
  assert.equal(answerToState(500, {}).text, TEXT.unreadable);
  assert.equal(answerToState(502, {}).text, TEXT.failed);
  for (const s of [400, 401, 403, 422, 429, 500, 502, 503]) assert.equal(answerToState(s, {}).kind, "refused");
});

test("a 200 that is neither a map nor a no-map answer is a failure", () => {
  assert.equal(answerToState(200, { schema: "something-else/1" }).kind, "refused");
  assert.equal(answerToState(200, null).kind, "refused");
});

test("a body that is not JSON, and a request that fails, never throw", async () => {
  assert.deepEqual(await readTopicMap(fakeFetch(404, undefined, []), "r1", null), { kind: "none", text: TEXT.noMapReport });
  const failing = async () => {
    throw new TypeError("network");
  };
  assert.deepEqual(await readTopicMap(failing, "r1", null), { kind: "refused", text: TEXT.failed });
});

test("the address gives the report id, the run and the theme", () => {
  assert.deepEqual(fromAddress("/topicsVizReport/r4zhhxpdu7hdxhnhfxiva", "?job_id=abc&theme=light"), {
    reportId: "r4zhhxpdu7hdxhnhfxiva",
    jobId: "abc",
    theme: "light",
  });
  assert.deepEqual(fromAddress("/topicsVizReport/2arcefpshi", ""), { reportId: "2arcefpshi", jobId: null, theme: null });
  assert.equal(fromAddress("/elsewhere", "").reportId, null);
});
