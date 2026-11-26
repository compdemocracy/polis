// Tests of the group vote graphic (vote-graphic.js), run with Node's own test
// runner (node --test). The inputs are made by hand; every count is a named
// count (agree, disagree, pass, did not vote), never a signed vote value.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../vote-graphic.js");

const BOX = { x: 0, y: 0, width: 34, height: 14 };
const VOTE = ["agree", "disagree", "pass"];
const REST = ["didNotVote", "didNotSee", "sawDidNotVote"];

function g(label, agree, disagree, pass, didNotVote, didNotSee) {
  return { label, agree, disagree, pass, didNotVote, didNotSee };
}

// Four groups: one split with many who did not vote, one with a single vote,
// one where nobody voted, one where everybody voted.
const FOUR = [g("A", 70, 18, 68, 87), g("B", 1, 0, 0, 4756), g("C", 0, 0, 0, 20), g("D", 9, 1, 0, 0)];

function groupsOf(n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (seed * 7 + i * 13) % 17;
    out.push(g(String.fromCharCode(65 + i), k * 3, (17 - k) * 2, k % 5, (i * 11 + seed) % 40));
  }
  return out;
}

// A canvas context that records every call.
function recorder() {
  const calls = [];
  const ctx = {};
  for (const m of ["save", "restore", "fillRect", "beginPath", "moveTo", "lineTo", "closePath", "fill", "fillText",
    "strokeRect", "stroke", "clearRect", "rect", "arc", "bezierCurveTo", "quadraticCurveTo"]) {
    ctx[m] = (...args) => calls.push([m, ...args]);
  }
  return { ctx, calls };
}

const segs = (L) => L.bars.flatMap((b) => b.segments.map((s) => Object.assign({ bar: b }, s)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("rows: the exact rectangles for four hand-made groups at 34 by 14", () => {
  const L = G.layout(FOUR, BOX, {});
  assert.equal(L.empty, false);
  assert.deepEqual(L.row, { height: 2, gap: 1, top: 1, x: 0, width: 34 });
  const got = L.bars.map((b) => b.segments.map((s) => [s.kind, s.x, s.y, s.w, s.h]));
  assert.deepEqual(got, [
    [["agree", 0, 1, 10, 2], ["disagree", 10, 1, 2, 2], ["pass", 12, 1, 10, 2], ["didNotVote", 22, 1, 12, 2]],
    [["agree", 0, 4, 1, 2], ["didNotVote", 1, 4, 33, 2]],
    [["didNotVote", 0, 7, 34, 2]],
    [["agree", 0, 10, 31, 2], ["disagree", 31, 10, 3, 2]],
  ]);
  // the dots of the remainder: 1 px every 2 px on the row's first line, on a grid fixed to the box
  const dotsC = L.rects.filter((r) => r.kind === "dot" && r.group === 2);
  assert.deepEqual(dotsC.map((d) => d.x), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
  assert.ok(dotsC.every((d) => d.y === 7 && d.w === 1 && d.h === 1));
  // B has 1 agree and 0 disagree: fewer than 5, so its votes are drawn faint
  assert.equal(L.rects.find((r) => r.group === 1 && r.kind === "agree").alpha, 0.45);
  assert.equal(L.rects.find((r) => r.group === 0 && r.kind === "agree").alpha, 1);
});

test("rows: colours are the report's agree, disagree and pass", () => {
  const L = G.layout(FOUR, BOX, {});
  const fill = (k) => L.rects.find((r) => r.kind === k).fill;
  assert.equal(fill("agree"), "rgb(46, 204, 113)");
  assert.equal(fill("disagree"), "rgb(231, 76, 60)");
  assert.equal(fill("pass"), "rgb(230, 230, 230)");
  const D = G.layout(FOUR, BOX, { scheme: "dark" });
  assert.notEqual(D.rects.find((r) => r.kind === "didNotVote").fill, fill("didNotVote"));
});

test("poured: the exact bars for four hand-made groups at 34 by 14", () => {
  const L = G.layout(FOUR, BOX, { form: "poured" });
  assert.deepEqual(L.column, { width: 7, gap: 1, left: 1, upper: 4, liquid: 5, lower: 5 });
  const got = L.bars.map((b) => [b.part, b.segments.map((s) => [s.kind, s.x, s.y, s.w, s.h])]);
  assert.deepEqual(got, [
    ["upper", [["agree", 1, 0, 2, 4], ["disagree", 3, 0, 1, 4], ["pass", 4, 0, 1, 4], ["didNotVote", 5, 0, 3, 4]]],
    ["lower", [["agree", 1, 9, 3, 5], ["disagree", 4, 9, 1, 5], ["pass", 5, 9, 3, 5]]],
    ["upper", [["agree", 9, 0, 2, 4], ["didNotVote", 11, 0, 5, 4]]],
    ["lower", [["agree", 9, 9, 7, 5]]],
    ["upper", [["didNotVote", 17, 0, 7, 4]]],
    ["lower", [["didNotVote", 17, 4, 7, 10]]],
    ["upper", [["agree", 25, 0, 6, 4], ["disagree", 31, 0, 1, 4]]],
    ["lower", [["agree", 25, 9, 6, 5], ["disagree", 31, 9, 1, 5]]],
  ]);
  // the liquid of A: pass under disagree under agree, each from the column's left edge
  const pa = L.paths.filter((p) => L.bars[p.bar].x === 1);
  assert.deepEqual(pa.map((p) => p.kind), ["pass", "disagree", "agree"]);
  for (const p of pa) {
    assert.deepEqual(p.points[0], [1, 4]);
    assert.deepEqual(p.points[p.points.length - 1], [1, 9]);
  }
  // each band leaves the upper bar at that bar's edge and lands on the lower bar's edge
  const ends = (p) => [p.points[1], p.points[p.points.length - 2]];
  assert.deepEqual(ends(pa[0]), [[5, 4], [8, 9]]);
  assert.deepEqual(ends(pa[1]), [[4, 4], [5, 9]]);
  assert.deepEqual(ends(pa[2]), [[3, 4], [4, 9]]);
  // nobody in C voted: no liquid
  assert.equal(L.paths.filter((p) => L.bars[p.bar].x === 17).length, 0);
});

for (const form of ["rows", "poured"]) {
  for (const n of [2, 3, 4, 5]) {
    for (const size of [[28, 11], [34, 14], [42, 19], [60, 24]]) {
      const box = { x: 3, y: 5, width: size[0], height: size[1] };
      const groups = groupsOf(n, size[0]);
      const L = G.layout(groups, box, { form });
      const name = `${form}, ${n} groups, ${size[0]} by ${size[1]}`;

      test(`${name}: every edge lands on a device pixel at ratio 1 and 2`, () => {
        if (L.empty) return;
        for (const r of L.rects) for (const dpr of [1, 2]) {
          for (const v of [r.x, r.y, r.x + r.w, r.y + r.h]) assert.ok(Number.isInteger(v * dpr), `${v} at ${dpr}`);
        }
        // the poured paths start and end on whole pixels
        for (const p of L.paths) {
          for (const pt of [p.points[0], p.points[1], p.points[p.points.length - 2], p.points[p.points.length - 1]]) {
            assert.ok(Number.isInteger(pt[0]) && Number.isInteger(pt[1]), JSON.stringify(pt));
          }
        }
      });

      test(`${name}: segments of a bar share edges, fill it exactly, and nothing leaves the box`, () => {
        if (form === "poured" && L.empty) return;
        assert.equal(L.empty, false);
        for (const b of L.bars) {
          let x = b.x;
          for (const s of b.segments) {
            assert.equal(s.x, x, "starts where the last ended");
            assert.ok(s.w > 0);
            assert.equal(s.y, b.y); assert.equal(s.h, b.h);
            x += s.w;
          }
          assert.equal(x, b.x + b.w, "the bar is filled to its full length");
        }
        const inside = (x, y) => x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height;
        for (const r of L.rects) assert.ok(inside(r.x, r.y) && inside(r.x + r.w, r.y + r.h), JSON.stringify(r));
        for (const p of L.paths) for (const pt of p.points) assert.ok(inside(pt[0], pt[1]), JSON.stringify(pt));
      });

      test(`${name}: votes are shares of those who voted, in the voted part; the rest is the remainder`, () => {
        if (L.empty) return;
        L.bars.forEach((b) => {
          const c = L.groups[b.group];
          const votes = b.segments.filter((s) => VOTE.includes(s.kind));
          const rest = b.segments.filter((s) => REST.includes(s.kind));
          const votedW = sum(votes.map((s) => s.w));
          if (c.voted === 0) { assert.equal(votedW, 0); assert.equal(sum(rest.map((s) => s.w)), b.w); return; }
          if (b.part === "lower") assert.equal(votedW, b.w, "the lower bar is all votes");
          else assert.ok(Math.abs(votedW - b.w * c.voted / c.members) <= 2.0001, "the voted part is near its share");
          // whole pixels, and at least one for any kind of vote that was cast: within a pixel per kind cast
          for (const s of votes) {
            const exact = votedW * c[s.kind] / c.voted;
            assert.ok(Math.abs(s.w - exact) <= votes.length, `${s.kind} ${s.w} against ${exact}`);
          }
          if (c.didNotVote === 0) assert.equal(rest.length, 0);
          if (c.didNotVote > 0 && b.part !== "lower") assert.ok(rest.length > 0, "the remainder shows");
        });
      });
    }
  }
}

test("a group with no voters draws its full row as remainder, dotted", () => {
  const L = G.layout([g("A", 0, 0, 0, 30), g("B", 3, 3, 3, 3)], BOX, {});
  assert.deepEqual(L.bars[0].segments.map((s) => [s.kind, s.w]), [["didNotVote", 34]]);
  assert.ok(L.rects.some((r) => r.kind === "dot" && r.group === 0));
  // a group of nobody at all is drawn the same way, never as garbage
  const Z = G.layout([g("A", 0, 0, 0, 0), g("B", 0, 0, 0, 0)], BOX, { form: "poured" });
  assert.equal(Z.paths.length, 0);
  assert.ok(Z.bars.every((b) => b.segments.every((s) => s.kind === "didNotVote")));
});

test("did not see, when known, is split from saw and did not vote", () => {
  const L = G.layout([g("A", 10, 10, 0, 20, 15), g("B", 10, 0, 0, 0, 0)], { x: 0, y: 0, width: 40, height: 9 }, {});
  assert.deepEqual(L.bars[0].segments.map((s) => [s.kind, s.x, s.w]),
    [["agree", 0, 10], ["disagree", 10, 10], ["sawDidNotVote", 20, 5], ["didNotSee", 25, 15]]);
  assert.match(G.caption(L), /did not see/);
});

test("a box too small gives an empty layout, and draw paints nothing", () => {
  for (const [form, box, n] of [["rows", { x: 0, y: 0, width: 34, height: 3 }, 4], ["rows", { x: 0, y: 0, width: 3, height: 14 }, 2],
    ["poured", { x: 0, y: 0, width: 10, height: 14 }, 4], ["poured", { x: 0, y: 0, width: 34, height: 2 }, 2],
    ["rows", { x: 0, y: 0, width: 0, height: 0 }, 3]]) {
    const L = G.layout(groupsOf(n, 1), box, { form });
    assert.equal(L.empty, true, `${form} ${JSON.stringify(box)}`);
    assert.equal(L.rects.length + L.paths.length, 0);
    const { ctx, calls } = recorder();
    G.draw(ctx, L);
    assert.equal(calls.length, 0);
  }
  assert.equal(G.layout([], BOX, {}).empty, true);
});

test("a box off whole pixels is snapped inward", () => {
  const L = G.layout(FOUR, { x: 0.4, y: 0.6, width: 34, height: 14 }, {});
  assert.deepEqual(L.box, { x: 1, y: 1, width: 33, height: 13 });
});

test("the recording canvas: fills only, nothing outside the box, both forms", () => {
  for (const form of ["rows", "poured"]) for (const scheme of ["light", "dark"]) {
    const box = { x: 10, y: 20, width: 34, height: 14 };
    const L = G.layout(FOUR, box, { form, scheme, letters: true });
    const { ctx, calls } = recorder();
    G.draw(ctx, L);
    assert.ok(calls.length > 0);
    for (const [m, ...a] of calls) {
      assert.ok(!["strokeRect", "stroke", "clearRect", "arc"].includes(m), `${m} called`);
      if (m === "fillRect") {
        assert.ok(a[0] >= box.x && a[1] >= box.y && a[0] + a[2] <= box.x + box.width && a[1] + a[3] <= box.y + box.height, JSON.stringify(a));
      }
      if (m === "moveTo" || m === "lineTo" || m === "fillText") {
        const [x, y] = m === "fillText" ? a.slice(1) : a;
        assert.ok(x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height, `${m} ${a}`);
      }
    }
  }
});

test("letters are drawn only in rows tall enough, in the package's face", () => {
  const small = G.layout(FOUR, BOX, { letters: true });
  assert.equal(small.texts.length, 0);
  const big = G.layout(FOUR, { x: 0, y: 0, width: 80, height: 40 }, { letters: true, rowMax: 8 });
  assert.deepEqual(big.texts.map((t) => t.text), ["A", "B", "C", "D"]);
  assert.match(big.texts[0].font, /Roboto, sans-serif$/);
  assert.equal(big.row.x, Math.ceil(8 * 0.8) + 2);
});

test("caption: of those who voted, and what the dots are", () => {
  assert.equal(G.caption(G.layout(FOUR, BOX, {})),
    "Each row is a group, A at the top. Agree, disagree, pass: of those who voted. Dotted: did not vote.");
  assert.equal(G.caption(G.layout(FOUR, BOX, { form: "poured" })),
    "Each column is a group, A at the left. Agree, disagree, pass: of those who voted. Dotted: did not vote.");
});

test("groupsFromMath reads named counts from group-votes", () => {
  const math = { "group-votes": {
    1: { id: 1, "n-members": 50, votes: { 7: { A: 10, D: 5, S: 20 } } },
    0: { id: 0, "n-members": 30, votes: { 7: { A: 1, D: 2, S: 3 } } },
  } };
  assert.deepEqual(G.groupsFromMath(math, 7), [
    { label: "A", agree: 1, disagree: 2, pass: 0, didNotVote: 27 },
    { label: "B", agree: 10, disagree: 5, pass: 5, didNotVote: 30 },
  ]);
  assert.deepEqual(G.groupsFromMath(math, 99)[0], { label: "A", agree: 0, disagree: 0, pass: 0, didNotVote: 30 });
});

test("apportion: parts sum to the width; a value above zero gets at least a pixel", () => {
  assert.deepEqual(G.apportion([1, 4756], 34, 1), [1, 33]);
  assert.deepEqual(G.apportion([1, 1, 1], 10, 1), [4, 3, 3]);
  assert.deepEqual(G.apportion([0, 5, 0], 7, 1), [0, 7, 0]);
  assert.deepEqual(G.apportion([3, 3], 0, 1), [0, 0]);
  assert.deepEqual(G.apportion([1, 9], 6, [2, 1]), [2, 4]);
});

test("settings are checked", () => {
  assert.throws(() => G.layout(FOUR, BOX, { form: "ribbon" }), /form/);
  assert.throws(() => G.layout(FOUR, BOX, { scheme: "beige" }), /scheme/);
});
