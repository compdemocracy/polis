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

// The first drawing: every member to scale along the row.
const FIRST = { didNotVoteMax: 1, showNonVoters: true };
// The earlier rows drawing at its own defaults: pass and those who did not vote drawn.
const NV = { showNonVoters: true };

const segs = (L) => L.bars.flatMap((b) => b.segments.map((s) => Object.assign({ bar: b }, s)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("rows: the exact rectangles for four hand-made groups at 34 by 14", () => {
  const L = G.layout(FOUR, BOX, FIRST);
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

test("rows with showNonVoters: the did-not-vote part is its share times a quarter, so each row stays nearly full", () => {
  const L = G.layout(FOUR, BOX, NV);
  assert.deepEqual(L.row, { height: 2, gap: 1, top: 1, x: 0, width: 34 });
  assert.deepEqual(L.bars.map((b) => b.segments.map((s) => [s.kind, s.x, s.y, s.w, s.h])), [
    [["agree", 0, 1, 14, 2], ["disagree", 14, 1, 4, 2], ["pass", 18, 1, 13, 2], ["didNotVote", 31, 1, 3, 2]],
    [["agree", 0, 4, 26, 2], ["didNotVote", 26, 4, 8, 2]],
    [["didNotVote", 0, 7, 34, 2]],
    [["agree", 0, 10, 31, 2], ["disagree", 31, 10, 3, 2]],
  ]);
  // at the size beside a comment in a list: 4 px rows
  const M = G.layout(FOUR, { x: 0, y: 0, width: 150, height: 20 }, NV);
  assert.deepEqual(M.row, { height: 4, gap: 1, top: 0, x: 0, width: 150 });
  assert.deepEqual(M.bars.map((b) => b.segments.map((s) => [s.kind, s.w])),
    [[["agree", 61], ["disagree", 16], ["pass", 60], ["didNotVote", 13]], [["agree", 113], ["didNotVote", 37]], [["didNotVote", 150]], [["agree", 135], ["disagree", 15]]]);
  // half of a group did not vote: an eighth of the row
  const H = G.layout([g("A", 5, 5, 0, 10)], { x: 0, y: 0, width: 40, height: 4 }, { showNonVoters: true, didNotVoteMax: 0.25 });
  assert.deepEqual(H.bars[0].segments.map((s) => [s.kind, s.w]), [["agree", 18], ["disagree", 17], ["didNotVote", 5]]);
});

test("rows: the default colours, the first drawing's colours, and colours given by the caller", () => {
  const L = G.layout(FOUR, BOX, NV);
  const fill = (k, X) => (X || L).rects.find((r) => r.kind === k).fill;
  assert.equal(fill("agree"), "#004d40");
  assert.equal(fill("disagree"), "#eb5b3f");
  assert.equal(fill("pass"), "#8e949c");
  assert.equal(fill("didNotVote"), "#e6e9ed");
  assert.equal(fill("dot"), "#8f96a0");
  const F = G.layout(FOUR, BOX, { showNonVoters: true, colors: G.FIRST_SCHEMES.light, didNotVoteMax: 1 });
  assert.equal(fill("agree", F), "rgb(46, 204, 113)");
  assert.equal(fill("disagree", F), "rgb(231, 76, 60)");
  assert.equal(fill("pass", F), "rgb(230, 230, 230)");
  const C = G.layout(FOUR, BOX, { showNonVoters: true, colors: { disagree: "#ff0000" } });
  assert.equal(fill("disagree", C), "#ff0000");
  assert.equal(fill("agree", C), "#004d40", "a colour not given keeps the scheme's");
  // the darkest colour is agree, and disagree is far lighter (the cut between them shows)
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  assert.ok(ratio(G.SCHEMES.light.agree, G.SCHEMES.light.disagree) >= 2.8);
  assert.ok(ratio(G.SCHEMES.light.agree, "#ffffff") >= 7);
  assert.ok(ratio(G.SCHEMES.light.tint, "#ffffff") >= 1.2, "the did-not-vote tint shows on white");
  const D = G.layout(FOUR, BOX, { showNonVoters: true, scheme: "dark" });
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
      const L = G.layout(groups, box, { form, showNonVoters: true });
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
          else if (form === "rows" && c.didNotVote > 0) {
            const restW = b.w - votedW;
            assert.ok(Math.abs(restW - b.w * 0.25 * c.didNotVote / c.members) <= 1.0001, "did not vote: its share times a quarter");
          } else assert.ok(Math.abs(votedW - b.w * c.voted / c.members) <= 2.0001, "the voted part is near its share");
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
  const L = G.layout([g("A", 0, 0, 0, 30), g("B", 3, 3, 3, 3)], BOX, NV);
  assert.deepEqual(L.bars[0].segments.map((s) => [s.kind, s.w]), [["didNotVote", 34]]);
  assert.ok(L.rects.some((r) => r.kind === "dot" && r.group === 0));
  // a group of nobody at all is drawn the same way, never as garbage
  const Z = G.layout([g("A", 0, 0, 0, 0), g("B", 0, 0, 0, 0)], BOX, { form: "poured" });
  assert.equal(Z.paths.length, 0);
  assert.ok(Z.bars.every((b) => b.segments.every((s) => s.kind === "didNotVote")));
});

test("did not see, when known, is split from saw and did not vote", () => {
  const L = G.layout([g("A", 10, 10, 0, 20, 15), g("B", 10, 0, 0, 0, 0)], { x: 0, y: 0, width: 40, height: 9 }, FIRST);
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
  const small = G.layout(FOUR, BOX, { showNonVoters: true, letters: true });
  assert.equal(small.texts.length, 0);
  const big = G.layout(FOUR, { x: 0, y: 0, width: 80, height: 40 }, { showNonVoters: true, letters: true, rowMax: 8 });
  assert.deepEqual(big.texts.map((t) => t.text), ["A", "B", "C", "D"]);
  assert.match(big.texts[0].font, /Roboto, sans-serif$/);
  assert.equal(big.row.x, Math.ceil(8 * 0.8) + 2);
});

test("caption: of those who voted, and what the dots are", () => {
  assert.equal(G.caption(G.layout(FOUR, BOX, NV)),
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
  for (const v of [0, -1, 1.5, "x"]) assert.throws(() => G.layout(FOUR, BOX, { didNotVoteMax: v }), /didNotVoteMax/);
  assert.throws(() => G.layout(FOUR, BOX, { colors: "red" }), /colors/);
});

test("readout: the numbers per group, in plain words, from the groups or from a layout", () => {
  const R = G.readout(FOUR);
  assert.deepEqual(R.lines, [
    "Group A: 70 agreed, 18 disagreed, 68 passed, 87 did not vote (156 of 243 voted).",
    "Group B: 1 agreed, 0 disagreed, 0 passed, 4756 did not vote (1 of 4757 voted).",
    "Group C: 0 agreed, 0 disagreed, 0 passed, 20 did not vote (0 of 20 voted).",
    "Group D: 9 agreed, 1 disagreed, 0 passed, 0 did not vote (10 of 10 voted).",
  ]);
  assert.equal(R.text, R.lines.join("\n"));
  assert.deepEqual(R.groups[0], { label: "A", agree: 70, disagree: 18, pass: 68, didNotVote: 87, didNotSee: null,
    voted: 156, members: 243, text: R.lines[0] });
  for (const form of ["rows", "poured"]) assert.deepEqual(G.readout(G.layout(FOUR, BOX, { form })), R);
  assert.equal(G.readout([g("A", 1, 2, 3, 20, 15)]).lines[0],
    "Group A: 1 agreed, 2 disagreed, 3 passed, 20 did not vote (6 of 26 voted); of those who did not vote, 15 did not see it.");
  assert.deepEqual(G.readout([]).lines, []);
});

test("hit: which group is under a point, for hover and click", () => {
  const box = { x: 10, y: 20, width: 34, height: 14 };
  const L = G.layout(FOUR, box, NV);          // rows 2 px, gap 1, top 21
  assert.deepEqual([[11, 21], [11, 23], [43, 24], [11, 30], [11, 33]].map(([x, y]) => G.hit(L, x, y)), [0, 0, 1, 3, 3]);
  assert.equal(G.hit(L, 11, 20), 0, "above the first row, inside the box: the first group");
  assert.equal(G.hit(L, 9, 25), -1);
  assert.equal(G.hit(L, 44, 25), -1);
  const P = G.layout(FOUR, box, { form: "poured" });   // columns 7 px, gap 1, left 11
  assert.deepEqual([[11, 25], [18, 25], [19, 25], [43, 25], [10, 25]].map(([x, y]) => G.hit(P, x, y)), [0, 0, 1, 3, 0]);
  assert.equal(G.hit(G.layout(FOUR, { x: 0, y: 0, width: 34, height: 3 }, {}), 1, 1), -1, "an empty layout names no group");
});

// ---------------------------------------------------------------------------
// The default rows: four rows filled, the full width, agree then disagree.
// ---------------------------------------------------------------------------

// The soft drawing these rows are made crisp from, at its three heights: row
// height and space between rows in fractional px, the rows centred in the box.
const SOFT = { 14: [3.0, 0.5], 16: [3.4, 0.6], 20: [4.0, 1.0] };
function softRows(h) {
  const [lane, gap] = SOFT[h];
  const top = (h - (4 * lane + 3 * gap)) / 2;
  return [0, 1, 2, 3].map((i) => [top + i * (lane + gap), top + i * (lane + gap) + lane]);
}

test("rows geometry: whole-pixel tops and heights at box heights 14, 15, 16 and 20", () => {
  assert.deepEqual(G.rowBands(4, 14, 1), [{ y: 0, h: 3 }, { y: 4, h: 3 }, { y: 8, h: 2 }, { y: 11, h: 3 }]);
  assert.deepEqual(G.rowBands(4, 15, 1), [{ y: 0, h: 3 }, { y: 4, h: 3 }, { y: 8, h: 3 }, { y: 12, h: 3 }]);
  assert.deepEqual(G.rowBands(4, 16, 1), [{ y: 0, h: 3 }, { y: 4, h: 4 }, { y: 9, h: 3 }, { y: 13, h: 3 }]);
  assert.deepEqual(G.rowBands(4, 20, 1), [{ y: 0, h: 4 }, { y: 5, h: 5 }, { y: 11, h: 4 }, { y: 16, h: 4 }]);
  for (const h of [14, 16, 20]) {
    const soft = softRows(h), crisp = G.rowBands(4, h, 1);
    crisp.forEach((b, i) => {
      assert.ok(Math.abs(b.y - soft[i][0]) <= 1, `top of row ${i} at ${h}: ${b.y} against ${soft[i][0]}`);
      assert.ok(Math.abs(b.y + b.h - soft[i][1]) <= 1, `foot of row ${i} at ${h}: ${b.y + b.h} against ${soft[i][1]}`);
    });
  }
  // rows and the lines between them fill the height exactly, for any height that fits
  for (const n of [2, 3, 4, 5]) for (let h = 2 * n - 1; h <= 40; h++) {
    const b = G.rowBands(n, h, 1);
    assert.equal(b[0].y, 0);
    for (let i = 1; i < n; i++) assert.equal(b[i].y, b[i - 1].y + b[i - 1].h + 1);
    assert.equal(b[n - 1].y + b[n - 1].h, h);
    for (const r of b) assert.ok(r.h >= 1 && Math.max(...b.map((x) => x.h)) - r.h <= 1);
  }
});

test("rows by default: the exact rectangles for four hand-made groups at 34 by 14", () => {
  const L = G.layout(FOUR, BOX, {});
  assert.equal(L.drawing, "filled");
  assert.deepEqual(L.row, { height: 3, gap: 1, top: 0, x: 1, width: 32, inset: 1, tops: [0, 4, 8, 11], heights: [3, 3, 2, 3] });
  // shares of agree: A 71/90, B 2/3, C 1/2, D 10/12 of 32 px
  const rows = L.rects.filter((r) => r.kind === "agree" || r.kind === "disagree").map((r) => [r.kind, r.x, r.y, r.w, r.h, r.alpha]);
  assert.deepEqual(rows, [
    ["agree", 1, 0, 25, 3, 1], ["disagree", 26, 0, 7, 3, 1],
    ["agree", 1, 4, 21, 3, 0.45], ["disagree", 22, 4, 11, 3, 0.45],
    ["agree", 1, 8, 16, 2, 0.45], ["disagree", 17, 8, 16, 2, 0.45],
    ["agree", 1, 11, 27, 3, 1], ["disagree", 28, 11, 5, 3, 1],
  ]);
  const seps = L.rects.filter((r) => r.kind === "separator").map((r) => [r.x, r.y, r.w, r.h, r.fill, r.alpha]);
  assert.deepEqual(seps, [
    [1, 3, 25, 1, "#004d40", 0.5], [26, 3, 7, 1, "#eb5b3f", 0.5],
    [1, 7, 21, 1, "#004d40", 0.225], [22, 7, 11, 1, "#eb5b3f", 0.225],
    [1, 10, 16, 1, "#004d40", 0.225], [17, 10, 16, 1, "#eb5b3f", 0.225],
  ]);
  const mid = L.rects.filter((r) => r.kind === "middle");
  assert.deepEqual(mid.map((r) => [r.x, r.y, r.w, r.h, r.alpha]), [[17, 0, 1, 14, 0.6]]);
  assert.equal(L.rects.filter((r) => ["pass", "didNotVote", "didNotSee", "sawDidNotVote", "dot"].includes(r.kind)).length, 0);
});

test("rows by default at 150 by 20: 2 px inset, rows 4, 5, 4, 4 px", () => {
  const L = G.layout(FOUR, { x: 0, y: 0, width: 150, height: 20 }, {});
  assert.deepEqual([L.row.x, L.row.width, L.row.tops, L.row.heights], [2, 146, [0, 5, 11, 16], [4, 5, 4, 4]]);
  const a = L.rects.filter((r) => r.kind === "agree").map((r) => r.w);
  assert.deepEqual(a, [115, 97, 73, 122]);   // 71/90, 2/3, 1/2, 10/12 of 146, rounded
  assert.deepEqual(L.rects.filter((r) => r.kind === "middle").map((r) => r.x), [75]);
});

test("rows by default: pass and those who did not vote change nothing drawn; the readout keeps every count", () => {
  const base = [g("A", 30, 10, 0, 0), g("B", 2, 40, 0, 0)];
  const more = [g("A", 30, 10, 500, 9000), g("B", 2, 40, 77, 3)];
  const strip = (L) => L.rects.map((r) => [r.kind, r.x, r.y, r.w, r.h, r.fill, r.alpha]);
  for (const size of [BOX, { x: 0, y: 0, width: 150, height: 20 }]) {
    assert.deepEqual(strip(G.layout(more, size, {})), strip(G.layout(base, size, {})));
  }
  const R = G.readout(G.layout(more, BOX, {}));
  assert.deepEqual(R.groups.map((x) => [x.agree, x.disagree, x.pass, x.didNotVote]), [[30, 10, 500, 9000], [2, 40, 77, 3]]);
  // a dissenting group's red runs to the right end of its row
  const L = G.layout(more, BOX, {});
  const rowB = L.rects.filter((r) => r.group === 1 && (r.kind === "agree" || r.kind === "disagree"));
  assert.deepEqual(rowB.map((r) => r.kind), ["agree", "disagree"]);
  assert.equal(rowB[1].x + rowB[1].w, L.row.x + L.row.width);
  assert.ok(rowB[1].w > rowB[0].w * 5);
});

test("rows by default: the share of agree has one of each added; no agree or disagree sits at the middle, faint", () => {
  assert.equal(G.agreeShare(g("A", 0, 0, 9, 9)), 0.5);
  assert.equal(G.agreeShare(g("A", 3, 1, 0, 0)), 4 / 6);
  const L = G.layout([g("A", 0, 0, 12, 4), g("B", 0, 100, 0, 0), g("C", 100, 0, 0, 0)], BOX, {});
  const by = (i) => L.rects.filter((r) => r.group === i && (r.kind === "agree" || r.kind === "disagree"));
  assert.deepEqual(by(0).map((r) => [r.kind, r.w, r.alpha]), [["agree", 16, 0.45], ["disagree", 16, 0.45]]);
  assert.deepEqual(by(1).map((r) => [r.kind, r.x, r.w]), [["disagree", 1, 32]], "1/102 of 32 px rounds to no agree");
  assert.deepEqual(by(2).map((r) => [r.kind, r.x, r.w]), [["agree", 1, 32]]);
});

test("rows by default: every edge on a whole pixel, rows tile the width, rows and lines tile the height", () => {
  for (const n of [2, 3, 4, 5]) for (const [w, h] of [[28, 11], [34, 14], [34, 15], [42, 19], [84, 16], [150, 20]]) {
    const box = { x: 3, y: 5, width: w, height: h };
    const L = G.layout(groupsOf(n, n + w), box, {});
    if (L.empty) { assert.ok(h < 2 * n - 1); continue; }
    for (const r of L.rects) {
      for (const v of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(v), JSON.stringify(r));
      assert.ok(r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + w && r.y + r.h <= box.y + h, JSON.stringify(r));
    }
    for (const b of L.bars) {
      assert.equal(b.segments[0].x, L.row.x);
      for (let i = 1; i < b.segments.length; i++) assert.equal(b.segments[i].x, b.segments[i - 1].x + b.segments[i - 1].w);
      const last = b.segments[b.segments.length - 1];
      assert.equal(last.x + last.w, L.row.x + L.row.width);
    }
    const rowsAndLines = sum(L.row.heights) + (n - 1);
    assert.equal(rowsAndLines, h, `${n} rows at ${w} by ${h}`);
  }
});

test("rows by default: the settings for the line between rows, the middle line, the inset and the hatch", () => {
  const plain = G.layout(FOUR, BOX, { separatorAlpha: 0, middle: false });
  assert.equal(plain.rects.filter((r) => r.kind === "separator" || r.kind === "middle").length, 0);
  const touch = G.layout(FOUR, BOX, { separator: 0 });
  assert.deepEqual(touch.row.heights, [4, 3, 4, 3]);
  const wide = G.layout(FOUR, BOX, { inset: 0 });
  assert.deepEqual([wide.row.x, wide.row.width], [0, 34]);
  const H = G.layout(FOUR, BOX, { disagreeFill: "hatch" });
  const dis = H.rects.filter((r) => r.kind === "disagree");
  assert.ok(dis.every((r) => r.fill === "#f7d3ca"));
  const hatch = H.rects.filter((r) => r.kind === "hatch");
  assert.ok(hatch.length > 0 && hatch.every((r) => r.w === 1 && r.h === 1 && r.fill === "#eb5b3f" && (r.x + r.y) % 3 === 0));
  const D = G.layout(FOUR, BOX, { scheme: "dark" });
  assert.equal(D.rects.find((r) => r.kind === "middle").fill, "#e8eaed");
  assert.throws(() => G.layout(FOUR, BOX, { disagreeFill: "dots" }), /disagreeFill/);
  for (const v of [-1, 0.5, "x"]) assert.throws(() => G.layout(FOUR, BOX, { separator: v }), /separator/);
  for (const v of [-0.1, 1.1]) assert.throws(() => G.layout(FOUR, BOX, { separatorAlpha: v }), /separatorAlpha/);
  assert.throws(() => G.layout(FOUR, BOX, { inset: 1.5 }), /inset/);
  assert.throws(() => G.layout(FOUR, BOX, { hatchPitch: 1 }), /hatchPitch/);
});

test("rows by default: hit names the row under a point, the line below a row belongs to it; the caption", () => {
  const L = G.layout(FOUR, { x: 10, y: 20, width: 34, height: 14 }, {});   // tops 20, 24, 28, 31
  assert.deepEqual([20, 22, 23, 24, 27, 28, 30, 31, 33].map((y) => G.hit(L, 15, y)), [0, 0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(G.hit(L, 15, 34), -1);
  assert.equal(G.caption(L), "Each row is a group, A at the top. Agree from the left, disagree to the right end, of those who agreed or disagreed; the line marks half.");
  assert.match(G.caption(G.layout(FOUR, BOX, NV)), /Dotted: did not vote/);
});

test("poured by default: those who did not vote are dots in the space the liquid leaves at its upper right", () => {
  const box = { x: 0, y: 0, width: 42, height: 28 };
  const L = G.layout(FOUR, box, { form: "poured" });
  const c = L.column, yL = c.upper, yS = c.upper + c.liquid;
  const beside = L.rects.filter((r) => r.beside === "liquid");
  assert.ok(beside.length > 0);
  const groups = new Set(beside.map((r) => r.group));
  assert.ok(groups.has(0) && groups.has(1), "A and B have members who did not vote");
  assert.ok(!groups.has(3), "everyone in D voted: no dots beside D's liquid");
  assert.ok(!groups.has(2), "nobody in C voted: its whole column is already the dotted remainder");
  for (const d of beside) {
    assert.ok(d.y >= yL && d.y < yS && d.w === 1 && d.h === 1 && d.kind === "dot" && d.x % 2 === 0 && d.y % 2 === 0, JSON.stringify(d));
    // right of the outermost band of the liquid (all the votes) at the dot's foot
    const all = L.paths.find((p) => p.kind === "pass" && L.bars[p.bar].group === d.group) ||
      L.paths.find((p) => L.bars[p.bar].group === d.group);
    const edgeAt = (y) => Math.max(...all.points.filter((pt) => pt[1] <= y + 1).map((pt) => pt[0]));
    assert.ok(d.x >= edgeAt(d.y) - 1e-9, `dot at ${d.x},${d.y} inside the liquid`);
  }
  // painted under the liquid: draw paints every rect before any path
  const { ctx, calls } = recorder();
  G.draw(ctx, L);
  const firstPath = calls.findIndex((x) => x[0] === "beginPath");
  const lastRect = calls.map((x) => x[0]).lastIndexOf("fillRect");
  assert.ok(lastRect < firstPath);
  const off = G.layout(FOUR, box, { form: "poured", pouredDots: false });
  assert.equal(off.rects.filter((r) => r.beside === "liquid").length, 0);
  assert.deepEqual(off.paths, L.paths);
});

// ---------------------------------------------------------------------------
// Medium sizes and screens of ratio 2 and 3: edges on device pixels, the
// curves sampled finely, the dots growing with the box.

const MEDIUM = [["rows", 34, 14], ["rows", 34, 15], ["rows", 68, 28], ["rows", 102, 42],
  ["poured", 42, 28], ["poured", 84, 56], ["poured", 126, 84]];

for (const [form, w, h] of MEDIUM) {
  test(`${form} by default at ${w} by ${h}: every straight edge lands on a device pixel at ratio 1, 2 and 3`, () => {
    for (const groups of [FOUR, groupsOf(4, w), groupsOf(3, h)]) {
      const L = G.layout(groups, { x: 0, y: 0, width: w, height: h }, { form });
      assert.equal(L.empty, false);
      for (const r of L.rects) for (const dpr of [1, 2, 3]) {
        for (const v of [r.x, r.y, r.x + r.w, r.y + r.h]) assert.ok(Number.isInteger(v * dpr), `${r.kind} edge ${v} at ${dpr}`);
      }
      for (const p of L.paths) {
        const pts = p.points, n = pts.length;
        // the liquid's left side, top and foot are whole pixels; only its right side is a curve
        for (const pt of [pts[0], pts[1], pts[n - 2], pts[n - 1]]) assert.ok(Number.isInteger(pt[0]) && Number.isInteger(pt[1]));
        assert.equal(pts[0][0], pts[n - 1][0], "the left side is one vertical line");
        // the curve has a point every half CSS px of height at most: a device pixel at ratio 2
        for (let i = 2; i < n - 1; i++) assert.ok(pts[i][1] - pts[i - 1][1] <= 0.5 + 1e-9, `step at ${pts[i][1]}`);
      }
    }
  });
}

test("dotSizeFor: 1 px at label size, growing with the poured box, 1 in the rows, or as set", () => {
  const at = (w, h, s) => G.dotSizeFor(4, { x: 0, y: 0, width: w, height: h }, s);
  assert.equal(at(42, 28, { form: "poured" }), 1);
  assert.equal(at(60, 55, { form: "poured" }), 1);
  assert.equal(at(84, 56, { form: "poured" }), 2);
  assert.equal(at(126, 84, { form: "poured" }), 3);
  assert.equal(at(40, 84, { form: "poured" }), 1, "never more than a ninth of a column (columns of 9 px)");
  assert.equal(at(102, 42, {}), 1);
  assert.equal(at(102, 42, { showNonVoters: true }), 1);
  assert.equal(at(42, 28, { form: "poured", dotSize: 2 }), 2);
  assert.throws(() => at(42, 28, { form: "poured", dotSize: 1.5 }), /dotSize/);
  assert.throws(() => at(42, 28, { form: "poured", dotSize: 0 }), /dotSize/);
  for (const [w, h] of [[42, 28], [84, 56], [126, 84]]) {
    assert.equal(G.layout(FOUR, { x: 0, y: 0, width: w, height: h }, { form: "poured" }).dotSize, at(w, h, { form: "poured" }));
  }
});

for (const [w, h, u] of [[42, 28, 1], [84, 56, 2], [126, 84, 3]]) {
  test(`poured at ${w} by ${h}: the dots are ${u} px squares every ${2 * u} px, whole, inside their space, clear of the liquid`, () => {
    const box = { x: 0, y: 0, width: w, height: h };
    const L = G.layout(FOUR, box, { form: "poured" });
    const c = L.column, yL = c.upper, yS = c.upper + c.liquid;
    const dots = L.rects.filter((r) => r.kind === "dot");
    assert.ok(dots.length > 0);
    for (const d of dots) {
      assert.ok(d.w === u && d.h === u, JSON.stringify(d));
      const bar = L.bars.find((b) => b.group === d.group && (d.beside ? b.part === "upper" : d.y >= b.y && d.y < b.y + b.h));
      // across, on the box's grid; down, on the grid of the box (beside the liquid) or of the dotted part's own top
      assert.ok(d.x % (2 * u) === 0 && (d.y - (d.beside ? 0 : bar.y)) % (2 * u) === 0, `on a grid of ${2 * u} px: ${JSON.stringify(d)}`);
      assert.ok(d.x >= bar.x && d.x + d.w <= bar.x + bar.w, "inside its column");
      if (!d.beside) {
        const seg = bar.segments.find((s) => d.x >= s.x && d.x < s.x + s.w);
        assert.ok(REST.includes(seg.kind) && d.x + d.w <= seg.x + seg.w && d.y + d.h <= seg.y + seg.h, "inside its remainder");
      } else {
        assert.ok(d.y >= yL && d.y + d.h <= yS);
        const all = L.paths.find((p) => p.kind === "pass" && L.bars[p.bar].group === d.group);
        const edge = Math.max(...all.points.filter((pt) => pt[1] <= d.y + d.h).map((pt) => pt[0]));
        assert.ok(d.x >= edge - 1e-9, `dot at ${d.x},${d.y} inside the liquid`);
      }
    }
    // about the same share of the dotted space is dot at every size: near one in four
    const up = L.bars.find((b) => b.group === 0 && b.part === "upper");
    const rest = up.segments.find((sg) => sg.kind === "didNotVote");
    const inRest = dots.filter((d) => !d.beside && d.group === 0 && d.y < up.y + up.h);
    const share = inRest.length * u * u / (rest.w * up.h);
    assert.ok(share > 0.12 && share <= 0.3, `share of the dotted part that is dot: ${share}`);
  });
}

test("rows by default at medium sizes: the lines stay 1 px and the rows fill the box", () => {
  for (const [w, h] of [[68, 28], [102, 42]]) {
    const L = G.layout(FOUR, { x: 0, y: 0, width: w, height: h }, {});
    assert.equal(L.row.inset, 2);
    assert.ok(L.rects.filter((r) => r.kind === "separator").every((r) => r.h === 1));
    assert.ok(L.rects.filter((r) => r.kind === "middle").every((r) => r.w === 1 && r.h === h));
    const last = L.row.tops.length - 1;
    assert.equal(L.row.tops[0], 0);
    assert.equal(L.row.tops[last] + L.row.heights[last], h);
  }
});
