// Writes a test fixture: a stored polis-topic-map/1 document in the shape the
// topic map route sends a public reader when some comments are held back.
//
//   node tools/held-back-fixture.mjs <stored.json> <out.json> [every]
//
// Every comment whose id is a multiple of `every` (default 4) is held back:
// it becomes a bare point (position only, id null, no topic at any level),
// placed last, ordered by position, and points.moderatedOut counts them. A
// topic with a held-back member gets the neutral name "Topic <cluster>", its
// visible members' count, weight and centre; a topic with none left is
// dropped; each level's counts are recounted. Colours are kept as stored (the
// route chooses them again; a fixture does not need to).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const round5 = (v) => Math.round(v * 1e5) / 1e5;

export function heldBack(doc, every = 4) {
  const p = doc.points;
  const n = p.id.length;

  const visible = [];
  const held = [];
  for (let i = 0; i < n; i++) (p.id[i] % every === 0 ? held : visible).push(i);
  held.sort((a, b) => p.x[a] - p.x[b] || p.y[a] - p.y[b]);

  const members = doc.topics.map(() => ({ visible: [], held: 0 }));
  for (let L = 0; L < p.topic.length; L++) {
    for (let i = 0; i < n; i++) {
      const t = p.topic[L][i];
      if (t < 0) continue;
      if (p.id[i] % every === 0) members[t].held += 1;
      else members[t].visible.push(i);
    }
  }

  const newIndex = new Map();
  const topics = [];
  doc.topics.forEach((t, k) => {
    const m = members[k];
    if (m.visible.length === 0) return;
    newIndex.set(k, topics.length);
    if (m.held === 0) return topics.push(t);
    const count = m.visible.length;
    topics.push({
      ...t,
      name: `Topic ${t.cluster}`,
      count,
      weight: Math.pow(count, 0.25),
      x: round5(m.visible.reduce((s, i) => s + p.x[i], 0) / count),
      y: round5(m.visible.reduce((s, i) => s + p.y[i], 0) / count),
    });
  });

  const order = visible.concat(held);
  const points = {
    id: order.map((i, j) => (j < visible.length ? p.id[i] : null)),
    x: order.map((i) => p.x[i]),
    y: order.map((i) => p.y[i]),
    topic: p.topic.map((row) => order.map((i, j) => (j < visible.length && row[i] >= 0 ? newIndex.get(row[i]) : -1))),
    text: [],
    moderatedOut: held.length,
  };
  const levels = doc.levels.map((l, L) => ({
    ...l,
    topics: topics.filter((t) => t.level === l.level).length,
    unclustered: points.topic[L].filter((t) => t < 0).length,
  }));

  return { ...doc, levels, topics, points };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inPath, outPath, everyArg] = process.argv.slice(2);
  if (!inPath || !outPath) throw new Error("usage: node tools/held-back-fixture.mjs <stored.json> <out.json> [every]");
  const doc = JSON.parse(readFileSync(inPath, "utf8"));
  const out = heldBack(doc, Number(everyArg || 4));
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`wrote ${outPath}: ${doc.points.id.length} points, ${out.points.moderatedOut} held back, ${doc.topics.length - out.topics.length} topics dropped`);
}
