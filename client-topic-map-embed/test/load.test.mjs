import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressWithJob,
  answerToJobs,
  answerToState,
  commentsUrl,
  fromAddress,
  jobListUrl,
  mapRequest,
  readCommentText,
  readJobList,
  readTopicMap,
  reportUrl,
  TEXT,
  topicMapUrl,
} from "../src/load.js";

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
  const state = await readTopicMap(fakeFetch(200, DOC, calls), mapRequest({ reportId: "r0examplereportid0000" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v3/delphi/topicMap?report_id=r0examplereportid0000");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(state, { kind: "map", doc: DOC });
});

test("a named run adds job_id and no source", () => {
  const url = topicMapUrl("r4zh", { jobId: "f5387f40-25d2-478e-82fe-19f4b2fb5984" });
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
  assert.deepEqual(await readTopicMap(fakeFetch(404, undefined, []), mapRequest({ reportId: "r1" })), { kind: "none", text: TEXT.noMapReport });
  const failing = async () => {
    throw new TypeError("network");
  };
  assert.deepEqual(await readTopicMap(failing, mapRequest({ reportId: "r1" })), { kind: "refused", text: TEXT.failed });
});

test("the address gives the report id, the run, the rule, the theme and the chooser", () => {
  assert.deepEqual(fromAddress("/topicsVizReport/r0examplereportid0000", "?job_id=abc&theme=light"), {
    reportId: "r0examplereportid0000",
    jobId: "abc",
    selection: null,
    theme: "light",
    chooser: true,
  });
  assert.deepEqual(fromAddress("/topicsVizReport/2arcefpshi", "?selection=all_comments&chooser=0"), {
    reportId: "2arcefpshi",
    jobId: null,
    selection: "all_comments",
    theme: null,
    chooser: false,
  });
  assert.equal(fromAddress("/topicsVizReport/2arcefpshi", "?selection=everything").selection, null);
  assert.equal(fromAddress("/elsewhere", "").reportId, null);
});

test("props to the map request: a run, a rule, never both, nothing for a document", () => {
  assert.deepEqual(mapRequest({ reportId: "r1" }), { reportId: "r1", jobId: null, selection: null });
  assert.deepEqual(mapRequest({ reportId: "r1", selection: "all_but_moderated_out" }), {
    reportId: "r1",
    jobId: null,
    selection: "all_but_moderated_out",
  });
  assert.deepEqual(mapRequest({ reportId: "r1", jobId: "j", selection: "all_comments" }), { reportId: "r1", jobId: "j", selection: null });
  assert.deepEqual(mapRequest({ reportId: "r1", selection: "sepia" }), { reportId: "r1", jobId: null, selection: null });
  assert.equal(mapRequest({ reportId: "r1", document: DOC }), null);
  assert.equal(mapRequest({ reportId: null }), null);

  assert.equal(topicMapUrl("r1", mapRequest({ reportId: "r1", selection: "all_comments" })), "/api/v3/delphi/topicMap?report_id=r1&selection=all_comments");
  assert.equal(topicMapUrl("r1", { jobId: "j", selection: "all_comments" }), "/api/v3/delphi/topicMap?report_id=r1&job_id=j");
  assert.equal(topicMapUrl("r1", {}, "https://example.test"), "https://example.test/api/v3/delphi/topicMap?report_id=r1");
});

test("a token, when a host gives one, is a Bearer header; by default none is sent", async () => {
  const calls = [];
  await readTopicMap(fakeFetch(200, DOC, calls), mapRequest({ reportId: "r1" }), { token: "t0k" });
  await readTopicMap(fakeFetch(200, DOC, calls), mapRequest({ reportId: "r1" }));
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0k");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[1].init.headers.Authorization, undefined);
});

const LIST = {
  report_id: "r1",
  jobs: [
    {
      job_id: "j2",
      source: "shadow",
      selection: "all_but_moderated_out",
      created_at: "2026-11-24T14:05:09Z",
      points: 9034,
      levels: [120, 40, 12],
      names: { by: "model", model: "claude-haiku-4-5" },
      current: false,
    },
    {
      job_id: "j1",
      source: "served",
      selection: "participant_visible",
      created_at: "2026-11-20T08:00:00Z",
      points: 147,
      levels: [10, 4],
      names: { by: "keywords", model: null },
      current: true,
    },
  ],
};

test("the list of runs is one request by report id, and its answer is read field by field", async () => {
  assert.equal(jobListUrl("r1"), "/api/v3/delphi/topicMap?report_id=r1&list=jobs");
  const calls = [];
  const list = await readJobList(fakeFetch(200, LIST, calls), "r1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v3/delphi/topicMap?report_id=r1&list=jobs");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(list.kind, "jobs");
  assert.deepEqual(
    list.jobs.map((j) => j.jobId),
    ["j2", "j1"],
  );
  assert.deepEqual(list.jobs[0], {
    jobId: "j2",
    source: "shadow",
    selection: "all_but_moderated_out",
    createdAt: "2026-11-24T14:05:09Z",
    points: 9034,
    levels: [120, 40, 12],
    namesBy: "model",
    model: "claude-haiku-4-5",
    current: false,
  });
});

test("every answer of the list but a 200 with jobs is no list, and never throws", async () => {
  for (const [status, body] of [
    [404, null],
    [404, { status: "error", message: "Not Found" }],
    [400, { status: "error", message: "polis_err_topic_map_bad_parameter" }],
    [401, {}],
    [403, {}],
    [500, {}],
    [503, {}],
    [200, { status: "success", reason: "no_run" }],
    [200, null],
  ]) {
    assert.deepEqual(answerToJobs(status, body), { kind: "none" }, `${status}`);
  }
  assert.deepEqual(await readJobList(fakeFetch(200, undefined, []), "r1"), { kind: "none" });
  assert.deepEqual(
    await readJobList(async () => {
      throw new TypeError("network");
    }, "r1"),
    { kind: "none" },
  );
  assert.deepEqual(answerToJobs(200, { jobs: [{ job_id: "" }, null, { job_id: "ok" }] }).jobs.map((j) => j.jobId), ["ok"]);
});

test("comment text: the report for its conversation id, then the comment list, both by report id", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("/api/v3/reports?")) return { status: 200, json: async () => [{ report_id: "r1", conversation_id: "2demo" }] };
    return {
      status: 200,
      json: async () => [
        { tid: 3, txt: "More trees" },
        { tid: 5, txt: "Fewer cars" },
        { tid: "x", txt: "skipped" },
      ],
    };
  };
  const text = await readCommentText(fetchFn, "r1");
  assert.deepEqual(
    calls.map((c) => c.url),
    [reportUrl("r1"), commentsUrl("2demo", "r1")],
  );
  assert.equal(calls[0].url, "/api/v3/reports?report_id=r1");
  assert.equal(calls[1].url, "/api/v3/comments?conversation_id=2demo&report_id=r1&moderation=true");
  for (const c of calls) {
    assert.equal(c.init.credentials, "omit");
    assert.equal(c.init.headers.Authorization, undefined);
  }
  assert.deepEqual([...text], [
    [3, "More trees"],
    [5, "Fewer cars"],
  ]);

  const one = [];
  await readCommentText(fakeFetch(200, [], one), "r1", { conversationId: "2demo" });
  assert.deepEqual(
    one.map((c) => c.url),
    ["/api/v3/comments?conversation_id=2demo&report_id=r1&moderation=true"],
  );
});

test("comment text that cannot be had is no text, and never throws", async () => {
  assert.equal((await readCommentText(fakeFetch(404, null, []), "r1")).size, 0);
  assert.equal((await readCommentText(fakeFetch(200, [{}], []), "r1")).size, 0);
  assert.equal((await readCommentText(fakeFetch(403, { message: "no" }, []), "r1", { conversationId: "c" })).size, 0);
  assert.equal(
    (
      await readCommentText(async () => {
        throw new TypeError("network");
      }, "r1")
    ).size,
    0,
  );
});

test("choosing a run sets job_id in the address, drops selection, keeps the rest", () => {
  assert.equal(addressWithJob("?theme=light", "j2"), "?theme=light&job_id=j2");
  assert.equal(addressWithJob("?job_id=j1&selection=all_comments&chooser=1", "j2"), "?job_id=j2&chooser=1");
  assert.equal(addressWithJob("?job_id=j1", ""), "");
});

