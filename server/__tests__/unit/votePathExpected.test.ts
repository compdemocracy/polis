import { describe, expect, test } from "@jest/globals";
import {
  applyExpectedDifferences,
  differingCases,
  ExpectedDifference,
  MAX_CONTEXT,
  Observation,
  pendingEntries,
} from "../setup/vote-path-expected";

// The vote-path recordings' expected-differences mechanism, on small
// hand-written observations (no server involved).
const golden: Record<string, Observation> = {
  "a/summary.csv": {
    status: 200,
    contentType: "text/csv",
    text: "topic,T\ncomments,2\ndescription,D",
  },
  "a/route": { status: 200, contentType: "application/json", text: '{"ok":1}' },
  "a/repeat": { status: 200, contentType: "text/plain", text: "x,x" },
};

const entry = (over: Partial<ExpectedDifference>): ExpectedDifference => ({
  case: "a/summary.csv",
  find: "description,D",
  replace: "description,D\nextra,row",
  why: "a new last row",
  ruling: "ruled:example 2026-10-04",
  ...over,
});

describe("vote-path expected differences", () => {
  test("an entry applies exactly once and only to its case", () => {
    const { expected, problems } = applyExpectedDifferences(golden, [
      entry({}),
    ]);
    expect(problems).toEqual([]);
    expect(expected["a/summary.csv"].text).toBe(
      "topic,T\ncomments,2\ndescription,D\nextra,row"
    );
    expect(expected["a/route"]).toEqual(golden["a/route"]);
  });

  test("zero matches fail", () => {
    const { problems } = applyExpectedDifferences(golden, [
      entry({ find: "not there" }),
    ]);
    expect(problems).toEqual([
      "a/summary.csv: find occurs 0 times in the golden",
    ]);
  });

  test("two matches fail", () => {
    const { problems } = applyExpectedDifferences(golden, [
      entry({ case: "a/repeat", find: "x", replace: "y" }),
    ]);
    expect(problems).toEqual(["a/repeat: find occurs 2 times in the golden"]);
  });

  test("an unknown case, a second entry for a case and an empty why fail", () => {
    const { problems } = applyExpectedDifferences(golden, [
      entry({ case: "nope" }),
      entry({ why: "" }),
      entry({}),
    ]);
    expect(problems).toEqual([
      "nope: names no recorded case",
      "a/summary.csv: why is empty",
      "a/summary.csv: more than one entry",
    ]);
  });

  test("ruling is a closed set: pending or ruled:<reference>", () => {
    expect(
      applyExpectedDifferences(golden, [entry({ ruling: "Colin said ok" })])
        .problems
    ).toEqual([
      'a/summary.csv: ruling must be "pending" or "ruled:<reference>"',
    ]);
    expect(
      applyExpectedDifferences(golden, [entry({ ruling: "ruled:" })]).problems
    ).toHaveLength(1);
    const pending = [entry({ ruling: "pending" })];
    expect(applyExpectedDifferences(golden, pending).problems).toEqual([]);
    // The suite accepts a pending entry; the merge does not.
    expect(pendingEntries(pending)).toEqual(["a/summary.csv"]);
  });

  test("a whole-response entry must say so, with a reason", () => {
    const flip = entry({
      case: "a/route",
      find: '{"ok":1}',
      replace: '{"error":"x"}',
      status: 400,
    });
    expect(applyExpectedDifferences(golden, [flip]).problems).toEqual([
      "a/route: replaces the whole response; needs whole_response: true and a reason",
    ]);
    const declared = {
      ...flip,
      whole_response: true,
      whole_response_reason: "the body is replaced",
    };
    const { expected, problems } = applyExpectedDifferences(golden, [declared]);
    expect(problems).toEqual([]);
    expect(expected["a/route"]).toEqual({
      status: 400,
      contentType: "application/json",
      text: '{"error":"x"}',
    });
  });

  test("an entry carrying more unchanged text than the change needs fails", () => {
    const long = "u".repeat(MAX_CONTEXT + 10);
    const big: Record<string, Observation> = {
      c: { status: 200, contentType: null, text: `${long}A${long}${long}` },
    };
    const { problems } = applyExpectedDifferences(big, [
      entry({ case: "c", find: `${long}A`, replace: `${long}B` }),
    ]);
    expect(problems).toEqual([
      `c: carries ${
        MAX_CONTEXT + 10
      } unchanged characters; trim find/replace to the change`,
    ]);
  });

  test("a difference with no entry is reported", () => {
    const { expected } = applyExpectedDifferences(golden, [entry({})]);
    const observed = {
      ...expected,
      "a/route": { ...expected["a/route"], text: '{"ok":2}' },
    };
    expect(differingCases(observed, expected)).toEqual(["a/route"]);
    expect(differingCases(expected, expected)).toEqual([]);
  });
});
