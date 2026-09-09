/**
 * `comments.modified` is the ONLY change signal either math engine has for a
 * comment row.
 *
 * Both moderation pollers discover work with a strict timestamp comparison and
 * nothing else:
 *   - Clojure  `math/src/polismath/components/postgres.clj` `mod-poll`
 *              `SELECT * FROM comments WHERE modified > last-mod-timestamp`
 *   - Python   `delphi/polismath/database/postgres.py` `poll_moderation_since`
 *              `SELECT ... FROM comments WHERE modified > :since`
 * Each then advances its watermark to the maximum `modified` it observed.
 *
 * The column is declared `modified BIGINT DEFAULT now_as_millis()` in
 * `server/postgres/migrations/000000_initial.sql`. That default fires on INSERT
 * only; the two triggers on the table are the BEFORE INSERT `tid_auto` and the
 * AFTER INSERT `tid_auto_unlock`. There is no update trigger, and adding one is
 * out of scope. So any UPDATE of `comments` that does not name `modified`
 * leaves the row's timestamp at its insertion value — and once that value is at
 * or behind the poller's watermark, the change is invisible to the engine until
 * an unrelated full reload happens to refresh the conversation.
 *
 * This test is deliberately a scan of the whole of `src/` rather than three
 * fixed assertions: the failure mode is a *new* UPDATE site written without the
 * timestamp, which fixed assertions would not catch.
 */
import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";

const SRC_DIR = path.resolve(__dirname, "../../src");

const UPDATE_COMMENTS = /update\s+comments\s+set/gi;
const QUOTES = new Set(['"', "'", "`"]);

/**
 * The string literal containing `source[at]`, with the 1-based line it opens
 * on: scan back to the nearest quote character and forward to the next one of
 * the same kind.
 *
 * Deliberately not a lexer. Lexing TypeScript from the top of the file means
 * telling an apostrophe in a `//` comment from an opening quote, which needs a
 * real tokenizer; getting it wrong silently reports the wrong line. Anchoring
 * on the SQL itself avoids the question entirely, because SQL that writes
 * `comments` contains no quote characters of its own here. A literal whose SQL
 * did embed a quote would be truncated, not skipped — the assertions below
 * still see a statement and can still fail on it.
 */
function enclosingLiteral(
  source: string,
  at: number
): { text: string; line: number } | null {
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (QUOTES.has(source[i])) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;

  const quote = source[open];
  const close = source.indexOf(quote, at);
  if (close === -1) return null;

  return {
    text: source.slice(open + 1, close),
    line: source.slice(0, open).split("\n").length,
  };
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Statements that write the `comments` table, as `file:line` plus the SQL.
 * Each of the three production sites is a single string literal, so a literal
 * is the right unit: a SET clause split across concatenated literals would be
 * reported here as not stamping `modified` and would need rewriting to one
 * literal (or this scanner extending) rather than being silently missed.
 */
function commentUpdateStatements(): Array<{ where: string; sql: string }> {
  const statements: Array<{ where: string; sql: string }> = [];
  for (const file of tsFilesUnder(SRC_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    UPDATE_COMMENTS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = UPDATE_COMMENTS.exec(source)) !== null) {
      const literal = enclosingLiteral(source, match.index);
      statements.push({
        where: `${path.relative(SRC_DIR, file)}:${
          literal?.line ?? source.slice(0, match.index).split("\n").length
        }`,
        // No enclosing literal means the SQL is being assembled some other
        // way; report the line's own text so the failure names something real
        // rather than passing on an empty string.
        sql: literal?.text ?? source.slice(match.index, match.index + 400),
      });
    }
  }
  return statements;
}

describe("every server UPDATE of `comments` advances `modified`", () => {
  const statements = commentUpdateStatements();

  test("the scanner still finds the known production write sites", () => {
    // A scanner that silently matched nothing would make every assertion
    // below vacuously pass, so pin the sites this fix was written for.
    const files = statements.map((s) => s.where.split(":")[0]);
    expect(files).toEqual(
      expect.arrayContaining([
        "routes/comments.ts",
        "routes/delphi/topicMod.ts",
        "server.ts",
      ])
    );
    expect(statements.length).toBeGreaterThanOrEqual(3);
  });

  test.each(commentUpdateStatements().map((s) => [s.where, s.sql]))(
    "%s sets modified in the same statement",
    (where, sql) => {
      // Same statement, not a follow-up UPDATE: the moderation state and its
      // timestamp must land atomically, or a poller can read the row between
      // the two writes and advance its watermark past the change.
      expect({ where, sql }).toMatchObject({
        sql: expect.stringMatching(/modified\s*=\s*now_as_millis\(\)/i),
      });
    }
  );

  test("the moderation write names the columns the pollers read", () => {
    const moderation = statements.find((s) =>
      s.where.startsWith("routes/comments.ts")
    );
    expect(moderation).toBeDefined();
    // `mod`, `active` and `is_meta` are what a moderator changes; `modified`
    // is how the engine finds out.
    for (const column of ["active", "mod", "is_meta", "modified"]) {
      expect(moderation?.sql).toMatch(new RegExp(`\\b${column}\\s*=`, "i"));
    }
  });
});
