import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";
import {
  LineShapeError,
  parseCapacity,
  parseReadiness,
  parseStale,
} from "../../src/ops/readinessLine";
import {
  alarmRows,
  capacityRows,
  ENGINE_EVENTS,
  eventCountRows,
  LOCK_SQL,
  lockLabels,
  pollerRow,
  publicationRows,
  queueRow,
  readLock,
  readTicks,
  summarizeStatus,
} from "../../src/ops/engine";
import { anyPhrase, awsReason } from "../../src/ops/awsReads";

// Generated fixture lines, written by the poller's real emitters
// (delphi/tests/poller/test_ops_fixture_lines.py, which fails if they drift
// from what the emitters write). No production data.
const FIXTURE = path.join(
  __dirname,
  "../../../delphi/tests/poller/fixtures/ops-poller-lines.txt"
);
const LINES = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
const T0 = 1_790_000_000_000;

function readinessLines() {
  return LINES.filter((l) => l.startsWith("math_poller readiness/1"));
}

describe("the TypeScript port of the poller's line validators", () => {
  test("every generated line parses as what it is", () => {
    const kinds = LINES.map((l) => {
      if (parseReadiness(l)) return "readiness";
      if (parseStale(l)) return "stale";
      if (parseCapacity(l)) return "capacity";
      return "other";
    });
    expect(kinds.filter((k) => k === "readiness")).toHaveLength(4);
    expect(kinds.filter((k) => k === "stale")).toHaveLength(1);
    expect(kinds.filter((k) => k === "capacity")).toHaveLength(6);
    // The large class's readiness line carries a class token and is skipped.
    expect(kinds.filter((k) => k === "other")).toHaveLength(1);
    expect(LINES[kinds.indexOf("other")]).toContain("class=large readiness/1");
  });

  test("a primary line exposes the closed fields", () => {
    const body = parseReadiness(readinessLines()[0]);
    expect(body).not.toBeNull();
    expect(body!.role).toBe("primary");
    expect(body!.progress).toBe("ok");
    expect(body!.queue.pending).toBe(3);
    expect(body!.admission.budget_mb).toBe(4000);
    expect(body!.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body!.silenced).toBe(false);
  });

  test("a line inside a logging prefix still parses", () => {
    const line = `2026-10-03 12:00:00,000 - math_poller.readiness - WARNING - ${
      readinessLines()[0]
    }`;
    expect(parseReadiness(line)?.role).toBe("primary");
  });

  const mutate = (line: string, f: (b: any) => void) => {
    const i = line.indexOf("{");
    const body = JSON.parse(line.slice(i));
    f(body);
    return line.slice(0, i) + JSON.stringify(body);
  };

  test.each([
    ["an extra key", (b: any) => (b.zid = 7)],
    ["a missing key", (b: any) => delete b.queue],
    ["an unknown progress", (b: any) => (b.progress = "fine")],
    ["a negative count", (b: any) => (b.queue.pending = -1)],
    ["an extra queue key", (b: any) => (b.queue.zids = [1])],
    [
      "error text in place of a class",
      (b: any) => (b.discovery.last_error = "connection refused"),
    ],
    ["a non-hex commit", (b: any) => (b.source_commit = "main")],
    ["a bad sweep status", (b: any) => (b.sweep.status = "DONE")],
  ])("%s is refused", (_name, f) => {
    expect(() => parseReadiness(mutate(readinessLines()[0], f))).toThrow(
      LineShapeError
    );
  });

  test("a header that disagrees with its body is refused", () => {
    const line = readinessLines()[0].replace("progress=ok", "progress=stale");
    expect(() => parseReadiness(line)).toThrow(LineShapeError);
  });

  test("a capacity line with an extra key or a bad refusal label is refused", () => {
    const cap = LINES.find((l) => l.startsWith('{"class":"small"'))!;
    expect(() =>
      parseCapacity(cap.replace('{"class"', '{"zid":1,"class"'))
    ).toThrow(LineShapeError);
    const large = LINES.filter((l) => l.includes('"class":"large"')).pop()!;
    expect(() =>
      parseCapacity(large.replace('"refusal":null', '"refusal":"because"'))
    ).toThrow(LineShapeError);
  });

  test("other lines are not readiness lines", () => {
    expect(
      parseReadiness("Wrote math results for zid=1 math_tick=2")
    ).toBeNull();
    expect(parseCapacity('{"message":"polis_math_bundle_refused"}')).toBeNull();
  });
});

function events(...messages: [number, string][]) {
  return {
    events: messages.map(([ts, message]) => ({ ts, message })),
    truncated: false,
  };
}

describe("summarizeStatus and the status rows", () => {
  const now = T0 + 130_000;
  const r = readinessLines();
  const smallCaps = LINES.filter((l) => l.startsWith('{"class":"small"'));
  const largeCaps = LINES.filter((l) => l.startsWith('{"allowlisted"'));
  const stale = LINES.find((l) =>
    l.startsWith("math_poller discovery_stale/1")
  )!;

  const read = events(
    [T0, r[0]],
    [T0, smallCaps[0]],
    [T0 + 60_000, r[1]],
    [T0 + 120_000, r[2]],
    [T0 + 120_000, stale],
    [T0 + 120_000, smallCaps[2]],
    [T0 + 120_000, r[3]],
    [T0 + 120_000, smallCaps[3]],
    [T0 + 120_000, largeCaps[0]],
    [T0 + 120_000, largeCaps[1]],
    [
      T0 + 121_000,
      "WARNING waiting for single-writer lock; holder=math-python:python@ip-10-0-0-1 (pid 77)",
    ],
    [T0 + 122_000, r[0].replace('"pending":3', '"pending":3,"zid":9')]
  );

  test("newest primary, standbys, stale and lock lines, malformed count", () => {
    const s = summarizeStatus(read, now);
    expect(s.primary?.progress).toBe("stale");
    expect(s.primaries).toBe(1);
    expect(s.standbys).toBe(1);
    expect(s.stale_lines).toBe(1);
    expect(s.lock_waits).toBe(1);
    expect(s.malformed).toBe(1);
    // A primary's capacity line wins over the standby's null counts.
    expect(s.capacity.small?.role).toBe("primary");
    expect(s.capacity.large?.role).toBe("primary");
  });

  test("the rows carry only counts, ages, closed labels and short digests", () => {
    const s = summarizeStatus(read, now);
    const row = pollerRow(s);
    expect(row).toMatchObject({
      progress: "stale",
      line_age_s: 10,
      primaries: 1,
      standbys: 1,
      malformed: 1,
      source_commit: "0123456789ab",
      image: "abababababab",
      last_error: "none",
    });
    const q = queueRow(s);
    expect(q).toMatchObject({
      pending: 3,
      in_flight: 1,
      budget_mb: 4000,
      sweep_status: "COMPLETE",
    });
    const caps = capacityRows(s);
    expect(caps.map((c) => c.class)).toEqual(["small", "large"]);
    expect(caps[0]).toMatchObject({
      large_demand: 2,
      refusals_total: 5,
      routing: "on",
      oldest_unresolved_s: 412,
    });
    expect(caps[1]).toMatchObject({
      busy: 1,
      label: "python-large",
      large_demand: null,
    });
    for (const v of [...Object.values(row), ...Object.values(q)]) {
      expect(["string", "number", "object"]).toContain(typeof v);
    }
  });

  test("no primary line in the last 3 minutes is said, not guessed", () => {
    const s = summarizeStatus(events([T0, r[0]]), T0 + 10 * 60 * 1000);
    expect(s.primary).toBeNull();
    expect(pollerRow(s).progress).toBe("no primary line in the last 3 minutes");
    expect(queueRow(s).pending).toBeNull();
  });
});

describe("log counts", () => {
  test("publications per UTC minute, 60 rows, zids discarded", () => {
    const now = Date.UTC(2026, 9, 3, 12, 30, 30);
    const rows = publicationRows(
      events(
        [
          now - 10_000,
          "Wrote math results for zid=12 math_tick=5 (main+bidtopid+ptptstats)",
        ],
        [
          now - 20_000,
          "Wrote math results for zid=13 math_tick=9 (main+bidtopid+ptptstats)",
        ],
        [now - 2 * 60 * 60 * 1000, "Wrote math results for zid=14 math_tick=1"]
      ),
      now
    );
    expect(rows).toHaveLength(60);
    expect(rows[59]).toEqual({ period: "12:30", publications: 2 });
    expect(rows[0].period).toBe("11:31");
    expect(JSON.stringify(rows)).not.toContain("zid");
  });

  test("engine events are counted per kind over 1 h and 24 h", () => {
    const now = T0;
    const rows = eventCountRows(
      events(
        [now - 1000, "memory admission: RSS read failed (OSError)"],
        [
          now - 2 * 60 * 60 * 1000,
          "PARKING zid=5 after 3 failed attempts (circuit breaker). Last error: x",
        ],
        [
          now - 1000,
          "math-backfill zid=9: reservation refused (budget: 1 > 0)",
        ],
        [now - 1000, "unrelated"]
      ),
      now,
      ENGINE_EVENTS
    );
    const byId = Object.fromEntries(rows.map((r) => [r.event, r]));
    expect(byId["Memory admission warnings"]).toMatchObject({
      last_1h: 1,
      last_24h: 1,
    });
    expect(byId["Conversations parked after repeated failures"]).toMatchObject({
      last_1h: 0,
      last_24h: 1,
    });
    expect(byId["Backfill memory reservations refused"]).toMatchObject({
      last_1h: 1,
    });
    expect(JSON.stringify(rows)).not.toMatch(/zid|OSError/);
  });

  test("filter patterns are OR'd quoted phrases", () => {
    expect(anyPhrase(["a b", "c"])).toBe('?"a b" ?"c"');
    expect(() => anyPhrase(['say "hi"'])).toThrow();
  });
});

describe("alarms", () => {
  test("firing first, names checked, no reason text", () => {
    const rows = alarmRows([
      {
        AlarmName: "Polis-DB-HighCPUUtilization",
        StateValue: "OK",
        StateUpdatedTimestamp: new Date(T0),
      },
      {
        AlarmName: "Polis-MathPoller-HeartbeatMissing",
        StateValue: "ALARM",
        StateUpdatedTimestamp: new Date(T0 + 5),
      },
      { AlarmName: "Polis-Bad Name<script>", StateValue: "ALARM" },
      {
        AlarmName: "Polis-Web-NoHealthyHosts",
        StateValue: "INSUFFICIENT_DATA",
        StateUpdatedTimestamp: "2026-10-03T00:00:00Z",
      },
    ] as any);
    expect(rows.map((r) => r.alarm)).toEqual([
      "Polis-MathPoller-HeartbeatMissing",
      "Polis-Web-NoHealthyHosts",
      "Polis-DB-HighCPUUtilization",
    ]);
    expect(rows[0]).toEqual({
      alarm: "Polis-MathPoller-HeartbeatMissing",
      state: "ALARM",
      since_ms: T0 + 5,
    });
  });
});

describe("lock and ticks from Postgres", () => {
  test("the lock read binds the labels and allowlists the holder name", async () => {
    let seen: unknown[] = [];
    const q: any = async (text: string, values: unknown[]) => {
      expect(text).toBe(LOCK_SQL);
      seen = values;
      return [
        {
          label: "python",
          held: true,
          application_name: "math-python:python@ip-10-0-1-23",
        },
        {
          label: "python-large",
          held: true,
          application_name: "psql; drop table",
        },
        { label: "dev", held: false, application_name: null },
      ];
    };
    const rows = await readLock(
      q,
      lockLabels("python", "python", "python-large", "bad label")
    );
    expect(seen).toEqual([["python", "python-large"]]);
    expect(rows).toEqual([
      {
        label: "python",
        held: "held",
        holder: "math-python:python@ip-10-0-1-23",
      },
      { label: "python-large", held: "held", holder: "other" },
      { label: "dev", held: "free", holder: null },
    ]);
  });

  test("math_ticks counts for the label", async () => {
    const q: any = async (_t: string, values: unknown[]) => {
      expect(values[0]).toBe("python");
      return [
        {
          conversations: "120",
          last_1h: "30",
          last_5m: "4",
          newest_ms: String(T0),
        },
      ];
    };
    expect(await readTicks(q, "python", T0)).toEqual({
      label: "python",
      conversations: 120,
      last_1h: 30,
      last_5m: 4,
      newest_ms: T0,
    });
  });
});

describe("awsReason", () => {
  test.each([
    [{ name: "AccessDenied" }, "not_permitted"],
    [{ name: "AccessDeniedException" }, "not_permitted"],
    [{ name: "Whatever", $metadata: { httpStatusCode: 403 } }, "not_permitted"],
    [{ name: "CredentialsProviderError" }, "aws_no_credentials"],
    [{ name: "TimeoutError" }, "aws_timeout"],
    [{ name: "ThrottlingException" }, "aws_throttled"],
    [{ name: "Throttling" }, "aws_throttled"],
    [{ name: "ResourceNotFoundException" }, "aws_not_found"],
    [
      new Error("arn:aws:iam::123456789012:role/x is not authorized"),
      "aws_error",
    ],
  ])("%o -> %s", (err, reason) => {
    expect(awsReason(err)).toBe(reason);
  });
});
