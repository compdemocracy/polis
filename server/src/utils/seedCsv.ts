import { parse } from "csv-parse/sync";

// One row of a seed CSV uploaded to POST /api/v3/comments-bulk.
export type SeedCsvRecord = { comment_text: string; original_id?: string };

// Excel and other spreadsheets often end every row with a comma, which reads
// as one more column whose name is empty.
const UNNAMED = "";

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

// Returns the rows of a seed CSV, or null when its first row is not an
// accepted header or a row has a value in the unnamed column. The unnamed
// column is dropped, so its rows read as those of a file without it. Any
// other malformed CSV throws the parser's error.
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
    throw err;
  }
}
