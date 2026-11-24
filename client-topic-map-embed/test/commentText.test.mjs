import { test } from "node:test";
import assert from "node:assert/strict";
import { commentTextFor } from "../src/commentText.js";

// A read that records who asked and answers with text for that reader.
function reads() {
  const asked = [];
  const read = (reader) => {
    asked.push(reader.token || "anonymous");
    return Promise.resolve(new Map([[1, reader.token ? "moderator text" : "public text"]]));
  };
  return { asked, read };
}

test("text read with one token is never handed to a reader without it, nor the other way", async () => {
  for (const order of [["moderator-token", null], [null, "moderator-token"]]) {
    const { asked, read } = reads();
    const textFor = commentTextFor(read);
    const first = await textFor({ reportId: "r1", token: order[0] });
    const second = await textFor({ reportId: "r1", token: order[1] });
    assert.deepEqual(asked, order.map((t) => t || "anonymous"));
    assert.equal(second.get(1), order[1] ? "moderator text" : "public text");
    assert.notEqual(first, second);
  }
});

test("the same reader asking again gets the same answer with one read; any other reader drops it", async () => {
  const { asked, read } = reads();
  const textFor = commentTextFor(read);
  const a = textFor({ reportId: "r1" });
  assert.equal(textFor({ reportId: "r1" }), a);
  textFor({ reportId: "r1", token: "t1" });
  textFor({ reportId: "r1", token: "t2" });
  textFor({ reportId: "r2", token: "t2" });
  textFor({ reportId: "r2", token: "t2", modLevel: 0 });
  // Back to the first reader: read again, the old answer was dropped.
  assert.notEqual(textFor({ reportId: "r1" }), a);
  assert.deepEqual(asked, ["anonymous", "t1", "t2", "t2", "t2", "anonymous"]);
});

test("two components never share text", async () => {
  const one = reads();
  const two = reads();
  await commentTextFor(one.read)({ reportId: "r1", token: "moderator-token" });
  await commentTextFor(two.read)({ reportId: "r1" });
  assert.deepEqual([one.asked, two.asked], [["moderator-token"], ["anonymous"]]);
});

test("the component reads the map, and makes its text afresh, when the token changes", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/TopicMap.js", import.meta.url), "utf8");
  const effect = /createEffect\(\s*\(\) => \[([^\]]*)\],\s*\(\[[^\]]*\]\) => \{\s*textFor = freshText\(\);/.exec(source);
  assert.ok(effect, "the map's read starts with fresh text");
  assert.deepEqual(effect[1].split(",").map((s) => s.trim()), ["props.reportId", "props.jobId", "props.selection", "props.document", "props.token"]);
  assert.doesNotMatch(source, /untrack\(\(\) => props\.token\)\s*\}\)\.then\(\(answer\)/);
  assert.doesNotMatch(source, /^const commentText = new Map\(\)/m, "no text kept for the whole page");
});
