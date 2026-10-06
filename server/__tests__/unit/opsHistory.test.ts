// U2 shaping on generated fixtures: every bucket present, UTC labels, the
// newest bucket partial, months filled between the first and the current.
import { describe, expect, test } from "@jest/globals";
import {
  DAILY_90,
  DAY_MS,
  HOURLY_48,
  readMonthly,
  readSeries,
  seriesStart,
  shapeMonthly,
  shapeSeries,
  STATEMENTS_SERIES_SQL,
  VOTES_SERIES_SQL,
} from "../../src/ops/history";

// 2026-10-03T14:25:00Z
const NOW = Date.UTC(2026, 9, 3, 14, 25);

describe("day and hour series", () => {
  test("90 daily buckets ending today, oldest first, gaps are zero", () => {
    const { first, current, startMs } = seriesStart(DAILY_90, NOW);
    expect(current - first + 1).toBe(90);
    expect(startMs).toBe(first * DAY_MS);
    const rows = shapeSeries(
      DAILY_90,
      NOW,
      [
        {
          bucket: String(current),
          votes: "12",
          voters: "5",
          conversations: "2",
        },
        { bucket: String(first), votes: "3", voters: "3", conversations: "1" },
      ],
      [{ bucket: String(current), statements: "4", rejected: "1" }]
    );
    expect(rows).toHaveLength(90);
    expect(rows[0]).toEqual({
      period: "2026-07-06",
      partial: false,
      votes: 3,
      voters: 3,
      conversations: 1,
      statements: 0,
      rejected: 0,
    });
    expect(rows[45]).toMatchObject({ votes: 0, voters: 0, statements: 0 });
    expect(rows[89]).toEqual({
      period: "2026-10-03",
      partial: true,
      votes: 12,
      voters: 5,
      conversations: 2,
      statements: 4,
      rejected: 1,
    });
  });

  test("48 hourly buckets labelled MM-DD HH:MM in UTC", () => {
    const rows = shapeSeries(HOURLY_48, NOW, [], []);
    expect(rows).toHaveLength(48);
    expect(rows[47].period).toBe("10-03 14:00");
    expect(rows[47].partial).toBe(true);
    expect(rows[0].period).toBe("10-01 15:00");
    expect(rows.filter((r) => r.partial)).toHaveLength(1);
  });

  test("a negative or fractional count from the driver is refused, not drawn", () => {
    const { current } = seriesStart(DAILY_90, NOW);
    expect(() =>
      shapeSeries(
        DAILY_90,
        NOW,
        [{ bucket: current, votes: "-1", voters: 0, conversations: 0 }],
        []
      )
    ).toThrow();
  });

  test("both statements get the window start and bucket size, nothing from the client", async () => {
    const calls: [string, unknown[]][] = [];
    await readSeries(
      async (sql, values) => {
        calls.push([sql, values]);
        return [];
      },
      HOURLY_48,
      NOW
    );
    const start = seriesStart(HOURLY_48, NOW).startMs;
    expect(calls).toEqual([
      [VOTES_SERIES_SQL, [start, 3600000]],
      [STATEMENTS_SERIES_SQL, [start, 3600000]],
    ]);
  });
});

describe("monthly, all time", () => {
  test("fills empty months from the first conversation to this month", () => {
    const rows = shapeMonthly(
      [
        {
          month: "2026-10",
          conversations: "2",
          with_10_plus: "1",
          participants: "40",
        },
        {
          month: "2026-07",
          conversations: "5",
          with_10_plus: "0",
          participants: "9",
        },
      ],
      NOW
    );
    expect(rows.map((r) => r.period)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(rows[1]).toEqual({
      period: "2026-08",
      partial: false,
      conversations: 0,
      with_10_plus: 0,
      participants: 0,
    });
    expect(rows[3]).toMatchObject({ partial: true, participants: 40 });
  });

  test("crosses a year boundary and ignores a month in the future", () => {
    const rows = shapeMonthly(
      [
        {
          month: "2025-11",
          conversations: 1,
          with_10_plus: 0,
          participants: 1,
        },
        {
          month: "2027-01",
          conversations: 9,
          with_10_plus: 9,
          participants: 9,
        },
      ],
      NOW
    );
    expect(rows[0].period).toBe("2025-11");
    expect(rows[2].period).toBe("2026-01");
    expect(rows[rows.length - 1].period).toBe("2026-10");
    expect(rows.some((r) => r.period === "2027-01")).toBe(false);
  });

  test("no conversations at all is an empty series", async () => {
    expect(await readMonthly(async () => [], NOW)).toEqual([]);
  });
});
