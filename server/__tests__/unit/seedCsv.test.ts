// How a seed CSV for POST /api/v3/comments-bulk is read. The first row must
// name the columns: comment_text, optionally with original_id. Excel and other
// spreadsheets often end every row with a comma, which reads as one more
// column with no name; that column is accepted while every row leaves it
// empty, and dropped, so the rows read as those of the same file without it.
// Any other header is refused (null), and a row the parser cannot read throws
// SeedCsvRowError, before the route stores a comment.
import { describe, expect, test } from "@jest/globals";
import { parseSeedCsv, SeedCsvRowError } from "../../src/utils/seedCsv";

const textOnly = [{ comment_text: "One" }, { comment_text: "Two" }];
const withIds = [
  { comment_text: "One", original_id: "a1" },
  { comment_text: "Two", original_id: "a2" },
];

describe("parseSeedCsv", () => {
  test.each([
    ["text only", "comment_text\nOne\nTwo", textOnly],
    ["text only, CRLF", "comment_text\r\nOne\r\nTwo\r\n", textOnly],
    ["text then ID", "comment_text,original_id\nOne,a1\nTwo,a2", withIds],
    ["ID then text", "original_id,comment_text\na1,One\na2,Two", withIds],
    [
      "byte-order mark",
      "\uFEFFcomment_text,original_id\nOne,a1\nTwo,a2",
      withIds,
    ],
    ["trailing comma, text only", "comment_text,\nOne,\nTwo,", textOnly],
    ["trailing comma, CRLF", "comment_text,\r\nOne,\r\nTwo,\r\n", textOnly],
    [
      "trailing comma, text then ID",
      "comment_text,original_id,\nOne,a1,\nTwo,a2,",
      withIds,
    ],
    [
      "trailing comma, ID then text",
      "original_id,comment_text,\na1,One,\na2,Two,",
      withIds,
    ],
    [
      "trailing comma, quoted, byte-order mark",
      '\uFEFF"comment_text","original_id",\r\n"One, quoted","a1",\r\n',
      [{ comment_text: "One, quoted", original_id: "a1" }],
    ],
    ["trailing comma, header only", "comment_text,", []],
  ])("reads %s", (_label, csv, expected) => {
    expect(parseSeedCsv(csv)).toStrictEqual(expected);
  });

  test.each([
    ["headerless", "One\nTwo"],
    ["headerless with a trailing comma", "One,\r\nTwo,"],
    ["wrong name", "text\nOne"],
    ["unknown column", "comment_text,source\nOne,example"],
    ["two trailing empty columns", "comment_text,,\nOne,,\nTwo,,"],
    ["leading empty column", ",comment_text\n,One"],
    ["empty column between", "comment_text,,original_id\nOne,,a1"],
    ["empty name only", '""\nOne'],
    ["value under the trailing comma", "comment_text,\nOne,\nTwo,extra"],
    [
      "value under the trailing comma after IDs",
      "comment_text,original_id,\nOne,a1,extra",
    ],
    ["whitespace under the trailing comma", "comment_text,\nOne, "],
    ["no nonempty row", "\n\n"],
  ])("refuses %s", (_label, csv) => {
    expect(parseSeedCsv(csv)).toBeNull();
  });

  test.each([
    [
      "a quoted comma",
      'comment_text\n"One, and two"\nThree',
      [{ comment_text: "One, and two" }, { comment_text: "Three" }],
    ],
    [
      "doubled double quotes",
      'comment_text\n"He said ""no"", twice"',
      [{ comment_text: 'He said "no", twice' }],
    ],
    [
      "a quoted comment over two lines",
      'comment_text\n"One\nstill one"\nTwo',
      [{ comment_text: "One\nstill one" }, { comment_text: "Two" }],
    ],
  ])("reads %s as before", (_label, csv, expected) => {
    expect(parseSeedCsv(csv)).toStrictEqual(expected);
  });
});

// A row the parser cannot read (a column count other than the header's, a
// misplaced double quote) is refused with SeedCsvRowError: the row as a person
// counts the rows of the file (the header is row 1, a blank line is a row, a
// comment wrapped in double quotes over several lines is one row) and what is
// wrong, without the row's text.
describe("parseSeedCsv refuses a row it cannot read", () => {
  const productionShape = [
    "comment_text",
    "The library should open on Sundays",
    "More benches along the river path",
    "Bus shelters need better lighting",
    "Plant trees on the main street, near the school, and by the market",
    "Keep the pool open later in summer",
    "Add a crossing near the playground",
    "Weekly farmers market downtown",
  ].join("\n");

  const commaRemedy =
    "This usually means a comment contains a comma: wrap that comment in double quotes.";
  const quoteRemedy =
    "A comment wrapped in double quotes must end with a double quote, and a double quote inside it must be written as two double quotes.";
  const headerRemedy =
    "CSV header must be comment_text, optionally with original_id.";

  test.each([
    [
      "an unquoted comma in one row of eight lines",
      productionShape,
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      5,
      `Row 5 (the header is row 1) has 3 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "an unquoted comma with IDs",
      "comment_text,original_id\nOne,a1\nTwo, and three,a2",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      `Row 3 (the header is row 1) has 3 columns; the header has 2. ${commaRemedy}`,
    ],
    [
      "a row missing its ID column",
      "comment_text,original_id\nOne,a1\nTwo",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      "Row 3 (the header is row 1) has 1 column; the header has 2. Every row needs a value for each column of the header; an empty value still needs its comma.",
    ],
    [
      "a row without the header's trailing comma",
      "comment_text,\nOne",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      2,
      "Row 2 (the header is row 1) has 1 column; the header has 2, counting the empty column after its final comma. End every row with a comma as well, or remove the comma at the end of the header.",
    ],
    [
      "an unquoted comma under a trailing-comma header",
      "comment_text,\nOne,\nTwo, and three,",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      `Row 3 (the header is row 1) has 3 columns; the header has 2, counting the empty column after its final comma. ${commaRemedy}`,
    ],
    [
      "a blank line, which counts as a row",
      "comment_text\nOne\n\nTwo\nThree, four",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      5,
      `Row 5 (the header is row 1) has 2 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "blank lines above the header, which do not",
      "\n\ncomment_text\nOne\nTwo, three",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      `Row 3 (the header is row 1) has 2 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "a quoted comment over two lines, which is one row",
      'comment_text\n"One\nstill one"\nTwo, three',
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      `Row 3 (the header is row 1) has 2 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "CRLF line endings and a byte-order mark",
      "﻿comment_text\r\nOne\r\nTwo, three\r\n",
      "CSV_RECORD_INCONSISTENT_COLUMNS",
      3,
      `Row 3 (the header is row 1) has 2 columns; the header has 1. ${commaRemedy}`,
    ],
    [
      "an unclosed double quote",
      'comment_text\nOne\n"Two\nThree\n',
      "CSV_QUOTE_NOT_CLOSED",
      3,
      `Row 3 (the header is row 1) opens a double quote that is never closed. ${quoteRemedy}`,
    ],
    [
      "a double quote inside unquoted text",
      'comment_text\nOne\nHe said "no"',
      "INVALID_OPENING_QUOTE",
      3,
      "Row 3 (the header is row 1) has a double quote inside a value that does not begin with one. Wrap that comment in double quotes and write each double quote inside it as two double quotes.",
    ],
    [
      "text after a closing double quote",
      'comment_text\nOne\n"He said "no" twice"',
      "CSV_INVALID_CLOSING_QUOTE",
      3,
      "Row 3 (the header is row 1) has text right after a closing double quote. A double quote inside a quoted comment must be written as two double quotes.",
    ],
    [
      "a byte-order mark before a double quote",
      'comment_text\nOne\n﻿"Two"',
      "INVALID_OPENING_QUOTE",
      3,
      "Row 3 (the header is row 1) has a byte-order mark, an invisible character that belongs only at the start of a file, before a double quote. This usually means two files were joined: remove that character and upload again.",
    ],
    [
      "an unclosed double quote in the header",
      '"comment_text\nOne',
      "CSV_QUOTE_NOT_CLOSED",
      1,
      `The header (row 1) opens a double quote that is never closed. ${headerRemedy}`,
    ],
    [
      "a double quote inside the header",
      'comment"text\nOne',
      "INVALID_OPENING_QUOTE",
      1,
      `The header (row 1) has a double quote inside a value that does not begin with one. ${headerRemedy}`,
    ],
  ])("%s", (_label, csv, parserCode, row, message) => {
    let thrown: unknown;
    try {
      parseSeedCsv(csv);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeedCsvRowError);
    expect({ ...(thrown as SeedCsvRowError) }).toStrictEqual({
      name: "SeedCsvRowError",
      row,
      parserCode,
    });
    expect((thrown as SeedCsvRowError).message).toBe(message);
  });

  test("names the first row it cannot read", () => {
    expect(() =>
      parseSeedCsv("comment_text\nOne\nTwo, three\nFour, five, six")
    ).toThrow(expect.objectContaining({ row: 3 }));
  });

  test("never puts the row's text in the error", () => {
    const secret = "a private remark, with a comma";
    let thrown: SeedCsvRowError | undefined;
    try {
      parseSeedCsv(`comment_text\nOne\n${secret}`);
    } catch (err) {
      thrown = err as SeedCsvRowError;
    }
    expect(thrown).toBeInstanceOf(SeedCsvRowError);
    expect(JSON.stringify({ ...thrown, message: thrown?.message })).not.toMatch(
      /private|remark/
    );
    expect(thrown?.stack).not.toMatch(/private|remark/);
  });
});
