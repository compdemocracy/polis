import { CsvError, parse } from "csv-parse/sync";

// One row of a seed CSV uploaded to POST /api/v3/comments-bulk.
export type SeedCsvRecord = { comment_text: string; original_id?: string };

// Excel and other spreadsheets often end every row with a comma, which reads
// as one more column whose name is empty.
const UNNAMED = "";

const BYTE_ORDER_MARK = "﻿";

const HEADER_RULE =
  "CSV header must be comment_text, optionally with original_id.";

// A row the parser cannot read: what the uploader must fix. The message names
// the row and what is wrong, and never carries the row's text.
export class SeedCsvRowError extends Error {
  // The row as a person counts the rows of the file: the header is row 1, a
  // blank line is a row, and a comment wrapped in double quotes over several
  // lines is one row. Blank lines above the header are not counted.
  readonly row: number;
  // The parser's code for what is wrong (csv-parse's CsvError code).
  readonly parserCode: string;
  constructor(row: number, parserCode: string, message: string) {
    super(message);
    this.name = "SeedCsvRowError";
    this.row = row;
    this.parserCode = parserCode;
  }
}

// The first row names the columns: comment_text, optionally with original_id,
// in either order, and optionally followed by one unnamed column.
function isSeedCsvHeader(header: string[]): boolean {
  const named =
    header[header.length - 1] === UNNAMED ? header.slice(0, -1) : header;
  return (
    (named.length === 1 && named[0] === "comment_text") ||
    (named.length === 2 &&
      named.includes("comment_text") &&
      named.includes("original_id"))
  );
}

// The empty lines above the header, which the parser skips and counts with
// every other empty line.
function emptyLinesAboveHeader(csv: string): number {
  const text = csv.startsWith(BYTE_ORDER_MARK) ? csv.slice(1) : csv;
  const leading = /^(?:\r\n|\n|\r)*/.exec(text)[0];
  return (leading.match(/\r\n|\n|\r/g) || []).length;
}

function columns(n: number): string {
  return n === 1 ? "1 column" : `${n} columns`;
}

// The SeedCsvRowError for a parser refusal of the file's shape, or null for
// any other parser error. The message is built from counts and the row number
// only; a field's text is compared with the byte-order mark, never copied.
function rowError(err: CsvError, csv: string): SeedCsvRowError | null {
  const inHeader = err.header === true;
  const row = inHeader
    ? 1
    : Number(err.records) +
      Number(err.empty_lines) -
      emptyLinesAboveHeader(csv) +
      2;
  const which = inHeader
    ? "The header (row 1)"
    : `Row ${row} (the header is row 1)`;
  const refuse = (problem: string, remedy: string) =>
    new SeedCsvRowError(
      row,
      err.code,
      `${which} ${problem}. ${inHeader ? HEADER_RULE : remedy}`
    );
  switch (err.code) {
    case "CSV_RECORD_INCONSISTENT_COLUMNS": {
      const header = err.columns;
      if (!Array.isArray(header) || !Array.isArray(err.record)) return null;
      const found = err.record.length;
      const expected = header.length;
      const trailing = header[expected - 1]?.name === UNNAMED;
      const headerHas = trailing
        ? `the header has ${expected}, counting the empty column after its final comma`
        : `the header has ${expected}`;
      const remedy =
        found > expected
          ? "This usually means a comment contains a comma: wrap that comment in double quotes."
          : trailing
          ? "End every row with a comma as well, or remove the comma at the end of the header."
          : "Every row needs a value for each column of the header; an empty value still needs its comma.";
      return refuse(`has ${columns(found)}; ${headerHas}`, remedy);
    }
    case "CSV_QUOTE_NOT_CLOSED":
      return refuse(
        "opens a double quote that is never closed",
        "A comment wrapped in double quotes must end with a double quote, and a double quote inside it must be written as two double quotes."
      );
    case "INVALID_OPENING_QUOTE":
      return err.field === BYTE_ORDER_MARK
        ? refuse(
            "has a byte-order mark, an invisible character that belongs only at the start of a file, before a double quote",
            "This usually means two files were joined: remove that character and upload again."
          )
        : refuse(
            "has a double quote inside a value that does not begin with one",
            "Wrap that comment in double quotes and write each double quote inside it as two double quotes."
          );
    case "CSV_INVALID_CLOSING_QUOTE":
      return refuse(
        "has text right after a closing double quote",
        "A double quote inside a quoted comment must be written as two double quotes."
      );
    default:
      return null;
  }
}

// Returns the rows of a seed CSV, or null when its first row is not an
// accepted header or a row has a value in the unnamed column. The unnamed
// column is dropped, so its rows read as those of a file without it. A row the
// parser cannot read for its shape throws SeedCsvRowError; any other parser
// error is thrown as it is.
export function parseSeedCsv(csv: string): SeedCsvRecord[] | null {
  const refused = new Error("Invalid seed CSV header");
  let hasHeader = false;
  try {
    const records = parse(csv, {
      bom: true,
      columns: (header: string[]) => {
        if (!isSeedCsvHeader(header)) throw refused;
        hasHeader = true;
        return header;
      },
      on_record: (record: Record<string, string>) => {
        if (Object.prototype.hasOwnProperty.call(record, UNNAMED)) {
          if (record[UNNAMED] !== "") throw refused;
          delete record[UNNAMED];
        }
        return record;
      },
      skip_empty_lines: true,
    });
    return hasHeader ? records : null;
  } catch (err) {
    if (err === refused) return null;
    throw (err instanceof CsvError && rowError(err, csv)) || err;
  }
}
