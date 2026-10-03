/**
 * The declared vote sign of the export formats and the votes-bulk import
 * (P-078 PR-E). The declaration cases live in a JSON fixture so this file
 * carries no sign literal of its own.
 */
import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkImportDeclaration,
  EXPORT_AGREE_VALUE,
  EXPORT_FORMAT_ID,
  EXPORT_VOTE_CONVENTION,
  IMPORT_DECLARATION_PREFIX,
  parseVoteConventionDeclaration,
  parseVoteConventionDocument,
  readImportDeclarationLine,
  requireExportConvention,
  VOTE_DECLARATION_ERRORS,
  VoteDeclarationError,
} from "../../src/votes/convention";
import {
  EXPORT_FILES,
  exportFormatDocument,
} from "../../src/votes/exportFormat";

type Outcome = "accepted" | "mismatch" | "malformed";
const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "vote-declaration", "declarations.json"),
    "utf8"
  )
) as {
  cases: { text: string; outcome: Outcome; format?: string | null }[];
  documents: { doc: unknown; outcome: Outcome }[];
};

function outcomeOf(fn: () => unknown): Outcome {
  try {
    fn();
    return "accepted";
  } catch (err) {
    expect(err).toBeInstanceOf(VoteDeclarationError);
    const code = (err as VoteDeclarationError).code;
    expect(Object.values(VOTE_DECLARATION_ERRORS)).toContain(code);
    expect((err as Error).message).toBe(code);
    return code === VOTE_DECLARATION_ERRORS.mismatch ? "mismatch" : "malformed";
  }
}

describe("the declaration value", () => {
  test("is built from the export constants", () => {
    expect(EXPORT_VOTE_CONVENTION).toBe(
      `agree=+${EXPORT_AGREE_VALUE};disagree=${-EXPORT_AGREE_VALUE};pass=0;format=${EXPORT_FORMAT_ID}`
    );
    expect(
      requireExportConvention(
        parseVoteConventionDeclaration(EXPORT_VOTE_CONVENTION)
      )
    ).toEqual({ agreeValue: EXPORT_AGREE_VALUE, format: EXPORT_FORMAT_ID });
  });

  test.each(fixture.cases)("$text → $outcome", ({ text, outcome, format }) => {
    expect(
      outcomeOf(() =>
        requireExportConvention(parseVoteConventionDeclaration(text))
      )
    ).toBe(outcome);
    if (outcome === "accepted") {
      expect(parseVoteConventionDeclaration(text)).toEqual({
        agreeValue: EXPORT_AGREE_VALUE,
        format: format ?? null,
      });
    }
  });

  test.each(fixture.documents)(
    "format document → $outcome",
    ({ doc, outcome }) => {
      expect(
        outcomeOf(() =>
          requireExportConvention(parseVoteConventionDocument(doc))
        )
      ).toBe(outcome);
    }
  );

  test("the served format.json is itself an accepted import declaration", () => {
    expect(checkImportDeclaration(null, exportFormatDocument())).toEqual({
      agreeValue: EXPORT_AGREE_VALUE,
      format: EXPORT_FORMAT_ID,
    });
  });
});

describe("the import's first line", () => {
  const declared = `${IMPORT_DECLARATION_PREFIX} ${EXPORT_VOTE_CONVENTION}`;

  test("a header line is not a declaration, and nothing is required", () => {
    const header = "vote_id,user_id,vote_value,timestamp,comment_id\n";
    expect(readImportDeclarationLine(header)).toBeNull();
    expect(checkImportDeclaration(header)).toBeNull();
    expect(checkImportDeclaration(header, undefined)).toBeNull();
    expect(checkImportDeclaration(null, "")).toBeNull();
    // Another comment line is not a declaration either: it reaches the CSV
    // parser as the header, exactly as it did before.
    expect(readImportDeclarationLine("# exported by a script\n")).toBeNull();
  });

  test.each([
    ["LF", `${declared}\n`],
    ["CRLF", `${declared}\r\n`],
    ["no line ending", declared],
    ["byte order mark", `\uFEFF${declared}\n`],
  ])("a declaration with %s is read", (_, line) => {
    expect(checkImportDeclaration(line)).toEqual({
      agreeValue: EXPORT_AGREE_VALUE,
      format: EXPORT_FORMAT_ID,
    });
  });

  test("a mismatched line is refused even when the format beside it matches", () => {
    const mismatched = readFileSync(
      join(
        __dirname,
        "..",
        "fixtures",
        "vote-declaration",
        "import-mismatch-sign.csv"
      ),
      "utf8"
    ).split("\n", 1)[0];
    expect(
      outcomeOf(() =>
        checkImportDeclaration(mismatched, exportFormatDocument())
      )
    ).toBe("mismatch");
  });

  test("a matched line is refused when the format beside it is mismatched", () => {
    const mismatchedDoc = fixture.documents.find(
      (d) => d.outcome === "mismatch"
    )!.doc;
    expect(
      outcomeOf(() => checkImportDeclaration(declared, mismatchedDoc))
    ).toBe("mismatch");
  });
});

describe("docs/export-format.md", () => {
  const doc = readFileSync(
    join(__dirname, "..", "..", "..", "docs", "export-format.md"),
    "utf8"
  );

  test("states the declaration, the format id and the closed error codes", () => {
    expect(doc).toContain(EXPORT_VOTE_CONVENTION);
    expect(doc).toContain(
      `${IMPORT_DECLARATION_PREFIX} ${EXPORT_VOTE_CONVENTION}`
    );
    for (const code of Object.values(VOTE_DECLARATION_ERRORS)) {
      expect(doc).toContain(code);
    }
  });

  test("covers every file and every sign-bearing column format.json lists", () => {
    for (const [file, columns] of Object.entries(EXPORT_FILES)) {
      expect(doc).toContain(`\`${file}\``);
      for (const column of Object.keys(columns)) {
        expect(doc).toContain(`\`${column}\``);
      }
    }
  });
});
