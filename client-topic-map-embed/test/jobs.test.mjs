import { test } from "node:test";
import assert from "node:assert/strict";
import { answerToJobs } from "../src/load.js";
import { chooserState, describeJob, whenText } from "../src/jobs.js";

const list = (...jobs) => answerToJobs(200, { report_id: "r1", jobs });
const J1 = {
  job_id: "j1",
  source: "served",
  selection: "participant_visible",
  created_at: "2026-11-20T08:00:00Z",
  points: 147,
  levels: [10, 4],
  names: { by: "keywords", model: null },
  current: true,
};
const J2 = {
  job_id: "j2",
  source: "shadow",
  selection: "all_but_moderated_out",
  created_at: "2026-11-24T14:05:09Z",
  points: 9034,
  levels: [120, 40, 12],
  names: { by: "model", model: "claude-haiku-4-5" },
  current: false,
};
const J3 = { ...J2, job_id: "j3", selection: "all_comments", names: { by: "none", model: null } };

test("each run in plain words: which comments, how named, when, how many", () => {
  const [a, b, c] = list(J1, J2, J3).jobs;
  assert.equal(describeJob(a), "what participants see · keyword names · 2026-11-20 08:00 UTC · 147 comments");
  assert.equal(describeJob(b), "everything not moderated out · claude-haiku-4-5 · 2026-11-24 14:05 UTC · 9,034 comments");
  // The route records today's keyword-named runs as "none": keyword names too.
  assert.equal(describeJob(c), "every comment · keyword names · 2026-11-24 14:05 UTC · 9,034 comments");
  assert.equal(describeJob(list({ job_id: "bare" }).jobs[0]), "bare");
  assert.equal(whenText("not a date"), null);
});

test("no chooser without a list, or with one run", () => {
  assert.deepEqual(chooserState(null), { show: false });
  assert.deepEqual(chooserState({ kind: "none" }), { show: false });
  assert.deepEqual(chooserState(list()), { show: false });
  assert.deepEqual(chooserState(list(J1)), { show: false });
});

test("two runs: the current one is chosen when the page names none", () => {
  const s = chooserState(list(J2, J1));
  assert.equal(s.show, true);
  assert.deepEqual(
    s.choices.map((c) => c.value),
    ["j2", "j1"],
  );
  assert.equal(s.value, "j1");
  assert.ok(s.choices[1].text.endsWith(" · current"));
  assert.ok(!s.choices[0].text.includes("current"));
});

test("a named run is the one chosen; one not in the list is still offered", () => {
  assert.equal(chooserState(list(J2, J1), { jobId: "j2" }).value, "j2");
  const s = chooserState(list(J2, J1), { jobId: "elsewhere" });
  assert.equal(s.value, "elsewhere");
  assert.deepEqual(s.choices[0], { value: "elsewhere", text: "The run elsewhere" });
});

test("when no run in the list is the map drawn, the current map is a choice of its own", () => {
  const s = chooserState(list(J2, J3), { selection: "participant_visible" });
  assert.deepEqual(s.choices[0], { value: "", text: "The current map" });
  assert.equal(s.value, "");
  const t = chooserState(list(J2, { ...J3, current: true }), { selection: "all_comments" });
  assert.equal(t.value, "j3");
});

test("a run without levels, model or count is described without them, never as null or an empty count", () => {
  const bare = list(
    { ...J2, job_id: "k1", levels: null, points: null, names: { by: "model", model: null } },
    { ...J2, job_id: "k2", levels: null, points: 0, names: null },
    { ...J2, job_id: "k3", levels: null, points: null, names: { by: null, model: null }, selection: null, created_at: null },
  ).jobs;
  assert.deepEqual(bare.map((j) => j.levels), [[], [], []]);
  assert.equal(describeJob(bare[0]), "everything not moderated out · names by a model · 2026-11-24 14:05 UTC");
  assert.equal(describeJob(bare[1]), "everything not moderated out · 2026-11-24 14:05 UTC");
  assert.equal(describeJob(bare[2]), "k3");
  for (const j of bare) {
    const text = describeJob(j);
    assert.doesNotMatch(text, /null|undefined|NaN/);
    assert.doesNotMatch(text, /(^|· )0? ?comments/);
  }
  const shown = chooserState(list(...bare.map((j) => ({ job_id: j.jobId, levels: null, names: { by: "none", model: null } })), J1));
  for (const c of shown.choices) assert.doesNotMatch(c.text, /null|undefined/);
});
