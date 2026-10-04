/**
 * Vote-sign lint. The vote sign is named in exactly one server file,
 * src/votes/convention.ts. This test reads every other server source file and
 * fails on a line that mentions a vote and also carries a sign literal or a
 * negation: `-1`, `=== 1`, `* -1`, `-row.vote`, `vote < 0`, `vote = 1` in SQL,
 * or the legacy `polisTypes.reactions` push/pull names.
 *
 * A new hit means a vote sign is being decided outside the convention module:
 * route it through src/votes/convention.ts instead. A line that genuinely is not
 * a vote sign goes in ALLOWLIST below with its reason. An allowlist entry that
 * no longer matches anything fails too, so the list only shrinks.
 */
import { describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const SERVER_ROOT = path.resolve(__dirname, "../..");
const CONVENTION_MODULE = "src/votes/convention.ts";
const ROOTS = ["src", "app.ts", "index.ts", "bin", "scripts"];

/** A line is in scope when it names a vote. */
const NAMES_VOTE = /vote/i;

/** Sign literals and negations that decide a vote's meaning. */
const SIGN_PATTERNS: Array<[string, RegExp]> = [
  ["literal -1", /(?<![\w-])-\s*1\b/],
  ["comparison with 1", /[=!]==?\s*\+?1\b|\b1\s*[=!]==?/],
  ["equality or assignment with a sign", /vote\w*\s*(=|<>|!=)\s*[-+]?1\b/i],
  ["multiplication by a sign", /\*\s*[-+]?1\b/],
  ["unary minus on a vote", /(?<![\w)\]])-\s*\(?\s*[\w.[\]]*vote\b/i],
  ["vote sign test", /vote\w*\s*[<>]=?\s*0\b/i],
  ["legacy reaction names", /reactions\s*\.\s*(push|pull|see|pass)\b/],
];

interface AllowlistEntry {
  file: string;
  /** Exact substring of the offending line. */
  line: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [];

function listSources(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(SERVER_ROOT, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) {
        walk(path.posix.join(rel, entry));
      }
    } else if (/\.(ts|js|cjs|mjs)$/.test(rel) && !rel.endsWith(".d.ts")) {
      out.push(rel);
    }
  };
  for (const root of ROOTS) walk(root);
  return out.filter((rel) => rel !== CONVENTION_MODULE);
}

interface Hit {
  file: string;
  lineNumber: number;
  line: string;
  rule: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of listSources()) {
    const lines = fs
      .readFileSync(path.join(SERVER_ROOT, file), "utf8")
      .split("\n");
    lines.forEach((line, i) => {
      if (!NAMES_VOTE.test(line)) return;
      for (const [rule, pattern] of SIGN_PATTERNS) {
        if (pattern.test(line)) {
          hits.push({ file, lineNumber: i + 1, line: line.trim(), rule });
          break;
        }
      }
    });
  }
  return hits;
}

function allowedBy(hit: Hit): AllowlistEntry | undefined {
  return ALLOWLIST.find(
    (a) => a.file === hit.file && hit.line.includes(a.line)
  );
}

describe("vote sign literals outside src/votes/convention.ts", () => {
  const hits = scan();

  test("the scan reads the server sources", () => {
    expect(listSources().length).toBeGreaterThan(50);
    expect(listSources()).toContain("app.ts");
    expect(listSources()).not.toContain(CONVENTION_MODULE);
  });

  test("the patterns catch the shapes they are meant to catch", () => {
    const shapes = [
      "vote: (row) => String(-row.vote),",
      "currentParticipantVotes.set(row.tid, -row.vote);",
      "if (row.vote === -1) comment.agrees += 1;",
      "if (vote === 1) agrees += 1;",
      "COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) as disagrees,",
      'want("vote", getIntInRange(-1, 1), assignToP),',
      "voteValue = -1;",
      "voteValue = 1;",
      "const flipped = vote * -1;",
      "if (row.vote < 0) agrees++;",
      "if (row.vote === Utils.polisTypes.reactions.pull) {",
    ];
    for (const shape of shapes) {
      expect(SIGN_PATTERNS.some(([, p]) => p.test(shape))).toBe(true);
    }
    const clean = [
      "const vote = storageToSemantic(row.vote);",
      'if (vote === "agree") agrees += 1;',
      "group-1-agree-count",
      "let currentParticipantId = -1;",
    ];
    for (const line of clean) {
      expect(
        NAMES_VOTE.test(line) && SIGN_PATTERNS.some(([, p]) => p.test(line))
      ).toBe(false);
    }
  });

  test("no vote sign literal outside the convention module (allowlist aside)", () => {
    const offending = hits
      .filter((hit) => !allowedBy(hit))
      .map((h) => `${h.file}:${h.lineNumber} [${h.rule}] ${h.line}`);
    expect(offending).toEqual([]);
  });

  test("every allowlist entry still matches a line (the list only shrinks)", () => {
    const stale = ALLOWLIST.filter(
      (entry) => !hits.some((hit) => allowedBy(hit) === entry)
    ).map((e) => `${e.file}: ${e.line}`);
    expect(stale).toEqual([]);
  });
});
