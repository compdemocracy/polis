// U5 shaping on generated fixtures, read the way client-report reads the
// same math blob. The normalized-consensus port is pinned to the report's own
// function (client-report/src/util/normalizeConsensus.js) on the same input.
import { describe, expect, jest, test } from "@jest/globals";
import {
  MathMemo,
  MATH_SQL,
  normalizeGroupConsensus,
  readConsensus,
  shapeConsensus,
  summarizeMath,
  TICKS_SQL,
  TOPIC_SQL,
  VISIBLE_TEXT_SQL,
} from "../../src/ops/consensus";
import { WINDOW_VOTERS_SQL } from "../../src/ops/topics";
// The report's implementation, imported unchanged.
import {
  enrichMathWithNormalizedConsensus,
  normalizeGroupConsensus as reportNormalize,
} from "../../../client-report/src/util/normalizeConsensus.js";

// Generated fixture in the math_main.data shape: three groups, five
// statements. Group 1 has no votes on tid 4.
function fixture() {
  return {
    group_votes: {
      "0": {
        "n-members": 12,
        votes: {
          "0": { A: 10, D: 1, S: 12 },
          "1": { A: 2, D: 9, S: 12 },
          "2": { A: 6, D: 6, S: 12 },
          "3": { A: 11, D: 0, S: 11 },
          "4": { A: 1, D: 1, S: 3 },
        },
      },
      "1": {
        "n-members": 7,
        votes: {
          "0": { A: 6, D: 0, S: 7 },
          "1": { A: 6, D: 1, S: 7 },
          "2": { A: 0, D: 7, S: 7 },
          "3": { A: 5, D: 1, S: 6 },
        },
      },
      "2": {
        "n-members": 4,
        votes: {
          "0": { A: 3, D: 1, S: 4 },
          "1": { A: 0, D: 4, S: 4 },
          "2": { A: 4, D: 0, S: 4 },
          "3": { A: 4, D: 0, S: 4 },
          "4": { A: 4, D: 0, S: 4 },
        },
      },
    },
    gac: { "0": 0.41, "1": 0.02, "2": 0.03, "3": 0.52, "4": 0.2 },
    repness: {
      "0": [
        {
          tid: 1,
          "repful-for": "disagree",
          "p-success": 0.8,
          "n-success": 9,
          "n-trials": 12,
          repness: 3.1,
        },
        {
          tid: 2,
          "repful-for": "agree",
          "p-success": 0.5,
          "n-success": 6,
          "n-trials": 12,
          repness: 1.9,
        },
      ],
      "1": [
        {
          tid: 1,
          "repful-for": "agree",
          "p-success": 0.78,
          "n-success": 6,
          "n-trials": 7,
          repness: 2.4,
        },
      ],
      "2": [
        {
          tid: 2,
          "repful-for": "agree",
          "p-success": 0.83,
          "n-success": 4,
          "n-trials": 4,
          repness: 2.2,
        },
        {
          tid: 4,
          "repful-for": "agree",
          "p-success": 0.83,
          "n-success": 4,
          "n-trials": 4,
          repness: 2.0,
        },
      ],
    },
  };
}

describe("normalizeGroupConsensus matches client-report", () => {
  test.each([0, 1, 2, 3, 4, 99])("tid %p", (tid) => {
    const gv = fixture().group_votes;
    expect(normalizeGroupConsensus(gv as any, tid)).toBeCloseTo(
      reportNormalize(gv, tid),
      12
    );
  });

  test("every tid the report enriches gets the same value", () => {
    const gv = fixture().group_votes;
    const enriched = enrichMathWithNormalizedConsensus({
      "group-votes": JSON.parse(JSON.stringify(gv)),
    })["group-consensus-normalized"];
    for (const [tid, value] of Object.entries(enriched)) {
      expect(normalizeGroupConsensus(gv as any, tid)).toBeCloseTo(
        value as number,
        12
      );
    }
  });

  test("no group votes is the neutral 0.5, as in the report", () => {
    expect(normalizeGroupConsensus(null, 1)).toBe(0.5);
    expect(reportNormalize(null, 1)).toBe(0.5);
  });
});

describe("summarizeMath", () => {
  test("groups in gid order with their sizes, participants = sum of n-members", () => {
    const s = summarizeMath(fixture()) as any;
    expect(s.participants).toBe(23);
    expect(s.groups.map((g: any) => [g.label, g.members])).toEqual([
      ["Group A", 12],
      ["Group B", 7],
      ["Group C", 4],
    ]);
  });

  test("group candidates are its repful-for agree entries in emitted order", () => {
    const s = summarizeMath(fixture()) as any;
    expect(s.groups[0].candidates.map((c: any) => c.tid)).toEqual([2]);
    expect(s.groups[2].candidates.map((c: any) => c.tid)).toEqual([2, 4]);
    expect(s.groups[1].candidates[0]).toEqual({
      tid: 1,
      p_success: 0.78,
      n_success: 6,
      n_trials: 7,
      repness: 2.4,
    });
  });

  test("common ground is ranked by normalized consensus, raw value beside it", () => {
    const s = summarizeMath(fixture()) as any;
    expect(s.common.map((c: any) => c.tid)).toEqual([3, 0, 4, 2, 1]);
    expect(s.common[0].raw).toBe(0.52);
    expect(s.common[0].normalized).toBeCloseTo(
      ((11 + 1) / 13 + (5 + 1) / 8 + (4 + 1) / 6) / 3,
      12
    );
  });

  test.each([
    ["empty group-votes", { group_votes: {}, gac: {}, repness: { "0": [] } }],
    [
      "empty repness",
      { group_votes: fixture().group_votes, gac: {}, repness: {} },
    ],
    ["nulls", { group_votes: null, gac: null, repness: null }],
  ])("%s is the empty case, not an error", (_name, row) => {
    expect(summarizeMath(row as any)).toBeNull();
  });
});

describe("shapeConsensus", () => {
  const summary = summarizeMath(fixture()) as any;

  test("three visible common-ground statements, then one per group; invisible tids skipped", () => {
    const texts = new Map([
      ["9:4", "Statement four"],
      ["9:0", "Statement zero"],
      ["9:2", "Statement two"],
      ["9:1", "Statement one"],
      // tid 3 is not visible (moderated out): skipped, the next one taken.
    ]);
    const rows = shapeConsensus(
      [{ zid: 9, topic: "Parks", state: "ok", summary }],
      texts
    );
    expect(rows.map((r) => [r.finding, r.statement])).toEqual([
      ["Common ground 1", "Statement zero"],
      ["Common ground 2", "Statement four"],
      ["Common ground 3", "Statement two"],
      ["Group A · 12 people", "Statement two"],
      ["Group B · 7 people", "Statement one"],
      ["Group C · 4 people", "Statement two"],
    ]);
    expect(rows[0].conversation).toBe("Parks · 23 participants in 3 groups");
    expect(rows[4]).toMatchObject({
      agree: 0.78,
      detail: "6 of 7 in the group who voted on it agreed; repness 2.40",
    });
    expect(String(rows[0].detail)).toContain("group-aware consensus 0.410");
  });

  test("a group whose agree statements are all invisible says so", () => {
    const rows = shapeConsensus(
      [{ zid: 9, topic: "Parks", state: "ok", summary }],
      new Map()
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.statement === null)).toBe(true);
    expect(rows[0].detail).toBe("no distinctive agree statement");
  });

  test("no math and no groups are one honest row each", () => {
    const rows = shapeConsensus(
      [
        { zid: 1, topic: "A", state: "no_math" },
        { zid: 2, topic: "B", state: "no_groups" },
      ],
      new Map()
    );
    expect(rows.map((r) => r.finding)).toEqual([
      'No published math under "python"',
      "No opinion groups yet",
    ]);
  });
});

describe("readConsensus", () => {
  function fakeQuery(tick: { n: number }) {
    return jest.fn(async (sql: string, values: unknown[]) => {
      if (sql === WINDOW_VOTERS_SQL) {
        return [
          { zid: "9", votes: "300", voters: "25" },
          { zid: "8", votes: "900", voters: "3" },
        ];
      }
      if (sql === TICKS_SQL) {
        expect(values[1]).toBe("python");
        return [{ zid: 9, math_tick: String(tick.n) }];
      }
      if (sql === MATH_SQL) {
        return [{ zid: 9, math_tick: tick.n, ...fixture() }];
      }
      if (sql === TOPIC_SQL) return [{ zid: 9, topic: "Parks" }];
      if (sql === VISIBLE_TEXT_SQL) {
        const [zids, tids] = values as [number[], number[]];
        return zids.map((zid, i) => ({
          zid,
          tid: tids[i],
          txt: `S${tids[i]}`,
        }));
      }
      throw new Error(`unexpected ${sql}`);
    });
  }

  test("below-threshold conversations are never read; the blob is reread only when the tick advances", async () => {
    const memo = new MathMemo();
    const tick = { n: 5 };
    const q1 = fakeQuery(tick);
    const first = await readConsensus(q1 as any, 1_790_000_000_000, 20, memo);
    expect(first.named).toBe(1);
    for (const [sql, values] of q1.mock.calls as any[]) {
      if (sql !== WINDOW_VOTERS_SQL)
        expect([...new Set(values[0])]).toEqual([9]);
    }
    expect(q1.mock.calls.filter(([sql]) => sql === MATH_SQL)).toHaveLength(1);

    const q2 = fakeQuery(tick);
    await readConsensus(q2 as any, 1_790_000_060_000, 20, memo);
    expect(q2.mock.calls.filter(([sql]) => sql === MATH_SQL)).toHaveLength(0);

    tick.n = 6;
    const q3 = fakeQuery(tick);
    const third = await readConsensus(q3 as any, 1_790_000_120_000, 20, memo);
    expect(q3.mock.calls.filter(([sql]) => sql === MATH_SQL)).toHaveLength(1);
    expect(third.rows[0].statement).toBe("S3");
    // Each (zid, tid) is asked for once, though tid 2 is a candidate twice.
    const [, [zids, tids]] = q3.mock.calls.find(
      ([sql]) => sql === VISIBLE_TEXT_SQL
    ) as any;
    expect(zids).toHaveLength(new Set(tids).size);
  });
});
