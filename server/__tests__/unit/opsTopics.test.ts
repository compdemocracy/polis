// U4 shaping on generated fixtures: the OPS_MIN_VOTERS_FOR_TEXT threshold,
// ordering, the note, and that topic text is only asked for named zids.
import { describe, expect, jest, test } from "@jest/globals";
import {
  cleanTopic,
  DETAIL_SQL,
  readActive,
  readDetails,
  shapeTopics,
  splitActive,
  thresholdNote,
  WINDOW_MS,
} from "../../src/ops/topics";
import { pickTopicNames } from "../../src/ops/delphiTopicNames";
import {
  DEFAULT_MIN_VOTERS_FOR_TEXT,
  parseMinVotersForText,
} from "../../src/ops/textThreshold";

const counts = [
  { zid: 1, votes: 500, voters: 40 },
  { zid: 2, votes: 900, voters: 20 }, // exactly at the threshold: named
  { zid: 3, votes: 2000, voters: 19 }, // busiest, but below: never named
  { zid: 4, votes: 500, voters: 60 },
  { zid: 5, votes: 10, voters: 2 },
];

describe("OPS_MIN_VOTERS_FOR_TEXT", () => {
  test.each([
    [undefined, 20, true],
    ["", 20, true],
    [" 35 ", 35, true],
    ["1", 1, true],
    ["0", 20, false],
    ["-5", 20, false],
    ["2.5", 20, false],
    ["twenty", 20, false],
    ["1e3", 20, false],
  ])("%p -> %p (valid %p)", (raw, value, valid) => {
    expect(parseMinVotersForText(raw as any)).toEqual({ value, valid });
  });

  test("the default is 20 (ruling R2)", () => {
    expect(DEFAULT_MIN_VOTERS_FOR_TEXT).toBe(20);
  });
});

describe("splitActive", () => {
  test("names only conversations at or above the threshold, busiest first", () => {
    const split = splitActive(counts, 20);
    expect(split.named.map((c) => c.zid)).toEqual([2, 4, 1]);
    expect(split.below).toEqual({ conversations: 2, voters: 21 });
    expect(split.unlistedAbove).toEqual({ conversations: 0, voters: 0 });
  });

  test("ties on votes break on voters, then zid", () => {
    expect(
      splitActive(counts, 20)
        .named.slice(1)
        .map((c) => c.zid)
    ).toEqual([4, 1]);
  });

  test("past the cut, eligible conversations are counted as not listed", () => {
    const split = splitActive(counts, 20, 1);
    expect(split.named.map((c) => c.zid)).toEqual([2]);
    expect(split.unlistedAbove).toEqual({ conversations: 2, voters: 100 });
  });

  test("a higher threshold names fewer", () => {
    expect(splitActive(counts, 50).named.map((c) => c.zid)).toEqual([4]);
  });
});

describe("readActive and readDetails", () => {
  test("the window is the last 7 days and topics are read for named zids only", async () => {
    const now = 1_790_000_000_000;
    const query = jest.fn(async (sql: string, values: unknown[]) => {
      if (sql === DETAIL_SQL) return [];
      expect(values).toEqual([now - WINDOW_MS]);
      return counts.map((c) => ({
        zid: String(c.zid),
        votes: String(c.votes),
        voters: String(c.voters),
      }));
    });
    const split = await readActive(query as any, now, 20);
    await readDetails(
      query as any,
      split.named.map((c) => c.zid)
    );
    expect(query).toHaveBeenLastCalledWith(DETAIL_SQL, [[2, 4, 1]]);
  });

  test("no named conversation asks for no topic at all", async () => {
    const query = jest.fn(async () => []);
    expect(await readDetails(query as any, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("shapeTopics", () => {
  test("one row per named conversation with Delphi names, failures as null", () => {
    const split = splitActive(counts, 20);
    const rows = shapeTopics(
      split,
      [
        {
          zid: 1,
          topic: "  Parks\n and  libraries ",
          participant_count: 70,
          is_active: true,
          statements: "33",
        },
        {
          zid: 2,
          topic: "",
          participant_count: 25,
          is_active: false,
          statements: "5",
        },
        {
          zid: 4,
          topic: "Transit",
          participant_count: 90,
          is_active: true,
          statements: "41",
        },
      ],
      new Map([
        [2, []],
        [4, ["Bus lanes", "Fares"]],
        [1, null],
      ])
    );
    expect(rows).toEqual([
      {
        topic: "(no topic)",
        delphi_topics: [],
        voters: 20,
        votes: 900,
        participants: 25,
        statements: 5,
        status: "Closed",
      },
      {
        topic: "Transit",
        delphi_topics: ["Bus lanes", "Fares"],
        voters: 60,
        votes: 500,
        participants: 90,
        statements: 41,
        status: "Open",
      },
      {
        topic: "Parks and libraries",
        delphi_topics: null,
        voters: 40,
        votes: 500,
        participants: 70,
        statements: 33,
        status: "Open",
      },
    ]);
  });

  test("long topics are cut and whitespace collapsed", () => {
    expect(cleanTopic("a\n\n b")).toBe("a b");
    expect(cleanTopic("x".repeat(400))).toHaveLength(300);
  });

  test("the note counts what was not named", () => {
    expect(thresholdNote(splitActive(counts, 20, 2), 20)).toBe(
      "1 more conversation above the threshold (40 voters) not listed; 2 conversations with fewer than 20 voters in the window (21 voters between them) counted but not named. Voters are distinct participants per conversation."
    );
  });
});

describe("pickTopicNames (Delphi_CommentClustersLLMTopicNames items)", () => {
  const item = (
    model: string,
    created: string,
    layer: number,
    cluster: number,
    name: string
  ) => ({
    model_name: model,
    created_at: created,
    layer_id: layer,
    cluster_id: cluster,
    topic_name: name,
  });

  test("newest run, coarsest layer, cluster order", () => {
    const names = pickTopicNames([
      item("m1", "2026-09-01T10:00:00Z", 0, 0, "old fine"),
      item("m1", "2026-09-01T10:00:00Z", 1, 0, "old coarse"),
      item("m2", "2026-09-20T10:00:00Z", 0, 0, "fine A"),
      item("m2", "2026-09-20T10:00:00Z", 2, 1, "Coarse B"),
      item("m2", "2026-09-20T10:00:00Z", 2, 0, "Coarse   A"),
      item("m2", "2026-09-20T10:00:00Z", 1, 0, "middle"),
    ]);
    expect(names).toEqual(["Coarse A", "Coarse B"]);
  });

  test("at most 8 names, empty or non-string names dropped", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item("m", "2026-09-20", 1, i, i === 3 ? "" : `T${i}`)
    );
    items.push({ ...item("m", "2026-09-20", 1, 99, ""), topic_name: 5 as any });
    expect(pickTopicNames(items)).toEqual([
      "T0",
      "T1",
      "T2",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
    ]);
  });

  test("no items, no names", () => {
    expect(pickTopicNames([])).toEqual([]);
  });
});
