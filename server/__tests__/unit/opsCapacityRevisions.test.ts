import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import {
  CAPACITY_REV,
  COUNT_KEYS,
  LineShapeError,
  REV_FORWARD,
  decodeCounts,
  keysThrough,
  parseCapacity,
  parseReadiness,
} from "../../src/ops/readinessLine";

// One small-class capacity line per revision, a line from before revisioning
// and a forward revision (delphi/tests/poller/test_capacity_revisions.py,
// which checks this revision's line against the real emitter). A rolling
// deploy logs old and new revisions at once, and the log keeps older ones:
// this parser must read all of them.
const FIXTURE = path.join(
  __dirname,
  "../../../delphi/tests/poller/fixtures/capacity-revisions.txt"
);
const LINES = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
const HEAD = ["schema", "class", "role", "label"];
const bodies = () => LINES.map((l) => JSON.parse(l));
const countsOf = (rev: number) => {
  const b = bodies().find((x) => (x.rev ?? 1) === rev && x.role === "primary");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (!HEAD.includes(k)) out[k] = v;
  return out;
};

describe("capacity line revisions", () => {
  test("the fixture spans pre-revision, this revision and a newer one", () => {
    const revs = bodies().map((b) => b.rev);
    expect(revs[0]).toBeUndefined();
    expect(revs).toContain(CAPACITY_REV);
    expect(Math.max(...revs.filter(Boolean))).toBeGreaterThan(CAPACITY_REV);
    expect(keysThrough(CAPACITY_REV)).toEqual([...COUNT_KEYS]);
  });

  test.each(LINES)(
    "every revision parses to this parser's shape: %s",
    (line) => {
      const raw = JSON.parse(line);
      const body = parseCapacity(line)!;
      expect(body.rev).toBe(raw.rev ?? 1);
      expect(Object.keys(body).sort()).toEqual(
        [...HEAD, "rev", ...COUNT_KEYS].sort()
      );
      for (const k of COUNT_KEYS) expect(body[k]).toEqual(raw[k] ?? null);
    }
  );

  test("the readiness line's embedded counts read any revision too", () => {
    const fixture = fs
      .readFileSync(
        path.join(
          __dirname,
          "../../../delphi/tests/poller/fixtures/ops-poller-lines.txt"
        ),
        "utf8"
      )
      .trim()
      .split("\n")
      .find(
        (l) =>
          l.startsWith("math_poller readiness/1") && l.includes('"capacity":{')
      )!;
    for (const rev of [1, CAPACITY_REV, CAPACITY_REV + 1]) {
      const counts =
        rev > CAPACITY_REV
          ? { ...countsOf(CAPACITY_REV), rev, future_count: 2 }
          : countsOf(rev);
      const m = /^(.*"capacity":)(\{[^}]*\})(.*)$/.exec(fixture)!;
      const line = m[1] + JSON.stringify(counts) + m[3];
      const r = parseReadiness(line)!;
      expect(r.capacity.rev).toBe(rev);
      expect(Object.keys(r.capacity).sort()).toEqual(
        ["rev", ...COUNT_KEYS].sort()
      );
    }
  });

  test("an older revision may not carry a key it did not declare", () => {
    expect(() => decodeCounts({ ...countsOf(CAPACITY_REV), zid: 1 })).toThrow(
      LineShapeError
    );
  });

  test("a revision missing a key it declares is refused", () => {
    for (let rev = 1; rev <= CAPACITY_REV; rev += 1) {
      const c = countsOf(rev);
      delete c[keysThrough(rev).slice(-1)[0]];
      expect(() => decodeCounts(c)).toThrow(LineShapeError);
    }
    const legacy = { ...bodies()[0] };
    delete legacy.large_parked;
    expect(() => parseCapacity(JSON.stringify(legacy))).toThrow(LineShapeError);
  });

  test("a newer revision keeps every key this parser knows; its own keys are counts, dropped", () => {
    const c = {
      ...countsOf(CAPACITY_REV),
      rev: CAPACITY_REV + 1,
      future_count: 3,
    };
    expect(decodeCounts(c)).not.toHaveProperty("future_count");
    for (const bad of ["3", -1, 1.5, true, { a: 1 }]) {
      expect(() => decodeCounts({ ...c, future_count: bad })).toThrow(
        LineShapeError
      );
    }
    expect(() => decodeCounts({ ...c, "a-b": 1 })).toThrow(LineShapeError);
    const { routing: _dropped, ...noRouting } = c;
    expect(() => decodeCounts(noRouting)).toThrow(LineShapeError);
  });

  test.each([0, -1, CAPACITY_REV + REV_FORWARD + 1, "1", 1.5, true, null])(
    "the revision is an integer in range: %p",
    (rev) => {
      expect(() => decodeCounts({ ...countsOf(CAPACITY_REV), rev })).toThrow(
        LineShapeError
      );
    }
  );
});
