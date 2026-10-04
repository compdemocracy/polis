/**
 * format.json: the machine-readable declaration of the report export files.
 *
 * Served at /api/v3/reportExport/:report_id/format.json beside the CSVs it
 * describes. It states the vote sign every vote-valued column uses (the export
 * convention of convention.ts) and which columns carry a vote value, a count of
 * named votes, or neither. The CSV bytes themselves are not changed; summary.csv
 * carries the same declaration as its `vote-convention` row.
 *
 * docs/export-format.md is the prose version of this document; the unit test
 * __tests__/unit/voteDeclaration.test.ts keeps the two file lists the same.
 */
import {
  EXPORT_FORMAT_ID,
  EXPORT_VOTE_CONVENTION,
  EXPORT_VOTE_VALUES,
  VOTE_CONVENTION_KEY,
} from "./convention";

/** How a column relates to the vote sign. */
export type ColumnKind =
  /** each cell is a vote in the declared convention (an empty cell: no vote). */
  | "vote"
  /** each cell counts votes of the named kind; no sign is involved. */
  | "count"
  /** An importance flag (marked important or not), not a vote value. */
  | "flag"
  /** the cell is the declaration itself. */
  | "declaration";

export const EXPORT_FORMAT_DOCS_URL =
  "https://github.com/compdemocracy/polis/blob/edge/docs/export-format.md";

/** The report export files and their sign-bearing columns. */
export const EXPORT_FILES: Readonly<
  Record<string, Record<string, ColumnKind>>
> = Object.freeze({
  "summary.csv": { [VOTE_CONVENTION_KEY]: "declaration" },
  "votes.csv": { vote: "vote", important: "flag" },
  "participant-votes.csv": {
    "<comment-id>": "vote",
    "n-votes": "count",
    "n-agree": "count",
    "n-disagree": "count",
  },
  "participant-importance.csv": {
    "<comment-id>": "flag",
    "n-votes": "count",
    "n-important": "count",
  },
  "comments.csv": { agrees: "count", disagrees: "count", importance: "count" },
  "comment-groups.csv": {
    "total-votes": "count",
    "total-agrees": "count",
    "total-disagrees": "count",
    "total-passes": "count",
    "group-<letter>-votes": "count",
    "group-<letter>-agrees": "count",
    "group-<letter>-disagrees": "count",
    "group-<letter>-passes": "count",
  },
  "comment-clusters.csv": {},
});

export function exportFormatDocument() {
  return {
    format: EXPORT_FORMAT_ID,
    [VOTE_CONVENTION_KEY]: EXPORT_VOTE_CONVENTION,
    vote: { ...EXPORT_VOTE_VALUES },
    files: EXPORT_FILES,
    docs: EXPORT_FORMAT_DOCS_URL,
  };
}

/** The exact bytes served as format.json (two-space JSON, trailing newline). */
export function exportFormatJson(): string {
  return JSON.stringify(exportFormatDocument(), null, 2) + "\n";
}
