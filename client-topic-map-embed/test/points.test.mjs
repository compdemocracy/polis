import { test } from "node:test";
import assert from "node:assert/strict";
import { countLine, fillText, heldBackCount, withTooltipText } from "../src/points.js";
import { offlineFetch } from "../src/offline.js";
import { heldBack } from "../tools/held-back-fixture.mjs";

const doc = (ids, moderatedOut, text = []) => ({
  schema: "polis-topic-map/1",
  points: { id: ids, x: ids.map(() => 0), y: ids.map(() => 0), topic: [ids.map((i) => (i === null ? -1 : 0))], text, ...(moderatedOut === undefined ? {} : { moderatedOut }) },
});

test("held-back points are the last moderatedOut points, and say so in their tooltip", () => {
  const d = doc([4, 7, null, null], 2);
  assert.equal(heldBackCount(d), 2);
  const t = withTooltipText(d);
  assert.deepEqual(t.points.text, ["", "", "Moderated out", "Moderated out"]);
  assert.deepEqual(d.points.text, [], "the document handed in is not changed");
  assert.equal(heldBackCount(doc([1, 2], undefined)), 0);
  assert.equal(heldBackCount(doc([1, 2], 0)), 0);
  assert.equal(heldBackCount(doc([null], 5)), 1, "never more than there are points");
});

test("comment text fills the points it has an id for, and never a held-back one", () => {
  const t = withTooltipText(doc([4, 7, 9, null], 1));
  const filled = fillText(t, new Map([[4, "More trees"], [9, ""], [12, "not on the map"]]));
  assert.equal(filled, 1);
  assert.deepEqual(t.points.text, ["More trees", "", "", "Moderated out"]);
});

test("the count line, only when something is held back", () => {
  assert.equal(countLine(doc([1, 2, 3], undefined)), null);
  const ids = Array.from({ length: 9034 }, (_, i) => (i < 157 ? i : null));
  assert.equal(countLine(doc(ids, 8877)), "9,034 comments · 8,877 moderated out, shown grey");
});

test("the fixture tool writes the public form: bare points last, recounted", () => {
  const stored = {
    schema: "polis-topic-map/1",
    levels: [{ level: 0, topics: 2, unclustered: 1 }],
    topics: [
      { id: "0_0", level: 0, cluster: 0, name: "trees", count: 3, x: 1, y: 1, weight: 1 },
      { id: "0_1", level: 0, cluster: 1, name: "cars", count: 1, x: 5, y: 5, weight: 1 },
    ],
    points: { id: [1, 2, 3, 4, 5], x: [0, 1, 2, 5, 9], y: [0, 1, 2, 5, 9], topic: [[0, 0, 0, 1, -1]], text: [] },
  };
  const d = heldBack(stored, 2); // comments 2 and 4 held back
  assert.deepEqual(d.points.id, [1, 3, 5, null, null]);
  assert.deepEqual(d.points.topic, [[0, 0, -1, -1, -1]]);
  assert.equal(d.points.moderatedOut, 2);
  assert.deepEqual(d.topics.map((t) => [t.name, t.count]), [["Topic 0", 2]], "a mixed topic is renamed; an emptied one dropped");
  assert.deepEqual(d.levels, [{ level: 0, topics: 1, unclustered: 3 }]);
  const k = heldBackCount(d);
  assert.ok(k > 0);
  const n = d.points.id.length;
  for (let i = 0; i < n; i++) {
    const held = i >= n - k;
    assert.equal(d.points.id[i] === null, held, `point ${i}`);
    for (const row of d.points.topic) if (held) assert.equal(row[i], -1);
  }
  assert.deepEqual(d.points.text, []);
});

test("a standalone page answers the map and the list from what it holds, and nothing else", async () => {
  const data = { reportId: "r1", current: "a", list: { report_id: "r1", jobs: [] }, documents: { a: { schema: "A" }, b: { schema: "B" } } };
  const f = offlineFetch(data);
  const body = async (url) => {
    const r = await f(url);
    return [r.status, await r.json().catch(() => null)];
  };
  assert.deepEqual(await body("/api/v3/delphi/topicMap?report_id=r1"), [200, { schema: "A" }]);
  assert.deepEqual(await body("/api/v3/delphi/topicMap?report_id=r1&job_id=b"), [200, { schema: "B" }]);
  assert.deepEqual(await body("/api/v3/delphi/topicMap?report_id=r1&list=jobs"), [200, data.list]);
  assert.equal((await body("/api/v3/delphi/topicMap?report_id=r1&job_id=c"))[0], 404);
  assert.deepEqual(await body("/api/v3/comments?conversation_id=x"), [404, null]);
  assert.equal((await body("/api/v3/delphi/topicMap?report_id=r2"))[0], 404);
});
