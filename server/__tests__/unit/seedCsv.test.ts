// How a seed CSV for POST /api/v3/comments-bulk is read. The first row must
// name the columns: comment_text, optionally with original_id. Excel and other
// spreadsheets often end every row with a comma, which reads as one more
// column with no name; that column is accepted while every row leaves it
// empty, and dropped, so the rows read as those of the same file without it.
// Anything else is refused (null) before the route stores a comment.
import { describe, expect, test } from "@jest/globals";
import { parseSeedCsv } from "../../src/utils/seedCsv";

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

  test("still throws the parser's error for a row of another length", () => {
    expect(() => parseSeedCsv("comment_text,\nOne")).toThrow(
      expect.objectContaining({ code: "CSV_RECORD_INCONSISTENT_COLUMNS" })
    );
  });
});
