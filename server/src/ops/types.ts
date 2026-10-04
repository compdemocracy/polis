// Shapes shared by the ops page registry (pages.ts) and the page modules.

// How the admin console draws a value:
//   label    short text (a period, a name, a code)
//   count    a non-negative integer, grouped by thousands
//   number   a decimal; `digits` places, optional `unit`
//   percent  a share between 0 and 1, drawn as a percentage
//   text     longer public text (a conversation topic, a statement)
//   tags     a short list of labels (Delphi topic names)
//   group    the row's group heading in a grouped table (one conversation)
//   time     an epoch-ms timestamp, drawn as an age ("3 h ago")
export type ColumnType =
  | "label"
  | "count"
  | "number"
  | "percent"
  | "text"
  | "tags"
  | "group"
  | "time";

export type OpsColumn = {
  key: string;
  label: string;
  type: ColumnType;
  unit?: string;
  digits?: number;
  // series panels: draw this column as a bar chart over the label column.
  chart?: boolean;
};

export type OpsValue = string | number | boolean | null | string[];
export type OpsRow = Record<string, OpsValue>;

// tiles: one tile per row (U1). stats: a single row drawn as one tile per
// column. table: a sorted table, grouped when a column
// has type "group". series: one small bar chart per charted column over time,
// with the numbers in a table underneath.
export type OpsShape = "tiles" | "stats" | "table" | "series";

// A panel may add one plain sentence under its rows (for example how many
// conversations were below the content threshold).
export type OpsLoadResult = OpsRow[] | { rows: OpsRow[]; note?: string };

/**
 * A failure with a closed reason code, for sources other than Postgres (the
 * Postgres path has OpsReadError). The reason is shown to the viewer; the
 * message never is.
 */
export class OpsSourceError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`ops_source_${reason}`);
    this.name = "OpsSourceError";
    this.reason = reason;
  }
}

/** Integer >= 0 from a driver value (pg returns bigint counts as strings). */
export function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new OpsSourceError("bad_value");
  }
  return n;
}

/** Finite number or null. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
