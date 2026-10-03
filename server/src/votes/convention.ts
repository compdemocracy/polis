/**
 * The vote sign convention. Every vote value the server reads, writes, serves,
 * exports or imports crosses one of the functions in this file; no other server
 * file may compare a vote with -1/1 or negate one (see
 * __tests__/unit/voteSignLiterals.test.ts, which fails on a new one).
 *
 * Four representations exist, and only this file knows how they relate:
 *
 *   semantic  'agree' | 'disagree' | 'pass'        (the typed `Vote`)
 *   wire      the number clients POST and the read routes return.
 *             FROZEN at agree = -1, disagree = +1, pass = 0. Cached client
 *             bundles post these numbers, so the wire never changes sign; a
 *             cleaner wire later is a new string field, not a flip of this one.
 *   storage   the number in votes.vote / votes_latest_unique.vote. Today
 *             agree = -1, the same as the wire. The value comes from a
 *             ConventionSource; today that is the constant
 *             STORAGE_AGREE_VALUE, and the database-resident convention row
 *             can replace it later through setConventionSource() without
 *             touching any call site.
 *   export    the number in the CSV exports (votes.csv, participant-votes.csv)
 *             and the votes-bulk import. FIXED at agree = +1, disagree = -1,
 *             pass = 0, independent of storage.
 *
 * NULL. votes.vote is nullable with no CHECK. Every conversion maps NULL (and
 * undefined) to null: NULL in, NULL out, never a pass and never an error. What a
 * NULL means for a count or a CSV cell is the caller's policy; the one export
 * policy (a NULL cell is written "0", as it always has been) is named below as
 * EXPORT_NULL_VALUE.
 *
 * Out-of-range integers (2, 7, NaN from an unparsed import cell). The column has
 * no CHECK, so they can exist. By default every conversion throws
 * VoteConventionError. Paths that must keep today's bytes for such rows opt in
 * explicitly with { onInvalid: "skip" } (semantic reads: treated like NULL) or
 * { onInvalid: "keep" } (numeric conversions: the value is returned unchanged).
 */

export type Vote = "agree" | "disagree" | "pass";

export const VOTES: readonly Vote[] = Object.freeze([
  "agree",
  "disagree",
  "pass",
]);

/** The sign the agree vote takes in a numeric representation. */
export type AgreeValue = -1 | 1;

/** A raw numeric vote as it comes out of a row, a request or a CSV cell. */
export type RawVote = number | null | undefined;

export type InvalidPolicy = "throw" | "skip" | "keep";

export interface ConversionOptions {
  /**
   * What to do with an integer outside {-1, 0, 1}:
   *   "throw" (default) raise VoteConventionError;
   *   "skip"  return null (semantic reads only);
   *   "keep"  return the value unchanged (numeric conversions only).
   */
  onInvalid?: InvalidPolicy;
  /** Override the storage convention for this call (tests, migrations). */
  convention?: StorageConvention;
}

export class VoteConventionError extends Error {
  readonly raw: unknown;
  readonly representation: string;
  constructor(representation: string, raw: unknown) {
    super(
      `polis_err_vote_convention: ${String(
        raw
      )} is not a ${representation} vote (expected -1, 0, 1 or null)`
    );
    this.name = "VoteConventionError";
    this.raw = raw;
    this.representation = representation;
  }
}

// ---------------------------------------------------------------------------
// The numeric conventions
// ---------------------------------------------------------------------------

/** Wire: frozen. Clients and cached bundles post these. */
export const WIRE_AGREE_VALUE = -1 as const;
export const WIRE_AGREE = WIRE_AGREE_VALUE;
export const WIRE_DISAGREE = -WIRE_AGREE_VALUE as 1;
export const WIRE_PASS = 0 as const;
/** The inclusive range the POST /votes and POST /comments parsers accept. */
export const WIRE_VOTE_MIN = Math.min(WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS);
export const WIRE_VOTE_MAX = Math.max(WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS);

/** Export: fixed. The CSV exports and the votes-bulk import use agree = +1. */
export const EXPORT_AGREE_VALUE = 1 as const;
export const EXPORT_AGREE = EXPORT_AGREE_VALUE;
export const EXPORT_DISAGREE = -EXPORT_AGREE_VALUE as -1;
export const EXPORT_PASS = 0 as const;
/**
 * A NULL stored vote is written to the vote CSV exports as this value. This is
 * the exports' behaviour since they were written (`String(-null)` is "0"); it is
 * kept byte-identical here and named so a later change is one line.
 */
export const EXPORT_NULL_VALUE = 0 as const;

/**
 * Storage: the convention every row in votes / votes_latest_unique was written
 * under since 2012. The one TypeScript statement of it.
 */
export const STORAGE_AGREE_VALUE: AgreeValue = -1;

export interface StorageConvention {
  /** The value agree takes in storage. Disagree is its negation; pass is 0. */
  readonly agreeValue: AgreeValue;
  /** The convention row's version when it came from the database; null for the constant. */
  readonly version: number | null;
}

/**
 * Where the storage convention comes from. Today: the constant. Later: the
 * database row (P-078 PR-A), supplied through setConventionSource() at startup.
 * current() is synchronous on purpose so call sites never change shape; a
 * database-backed source caches the row it last read.
 */
export interface ConventionSource {
  current(): StorageConvention;
}

export const CONSTANT_CONVENTION_SOURCE: ConventionSource = Object.freeze({
  current: (): StorageConvention =>
    Object.freeze({ agreeValue: STORAGE_AGREE_VALUE, version: null }),
});

let activeSource: ConventionSource = CONSTANT_CONVENTION_SOURCE;

export function setConventionSource(source: ConventionSource): void {
  activeSource = source;
}

export function resetConventionSource(): void {
  activeSource = CONSTANT_CONVENTION_SOURCE;
}

export function currentStorageConvention(): StorageConvention {
  const convention = activeSource.current();
  if (convention.agreeValue !== 1 && convention.agreeValue !== -1) {
    throw new VoteConventionError(
      "storage convention agree",
      convention.agreeValue
    );
  }
  return convention;
}

// ---------------------------------------------------------------------------
// Internal: one table per numeric representation
// ---------------------------------------------------------------------------

function isNullish(raw: unknown): raw is null | undefined {
  return raw === null || raw === undefined;
}

function toSemantic(
  raw: RawVote,
  agree: AgreeValue,
  representation: string,
  onInvalid: InvalidPolicy
): Vote | null {
  if (isNullish(raw)) return null;
  if (raw === agree) return "agree";
  if (raw === -agree) return "disagree";
  if (raw === 0) return "pass";
  if (onInvalid === "skip") return null;
  throw new VoteConventionError(representation, raw);
}

function fromSemantic(vote: Vote, agree: AgreeValue): number {
  switch (vote) {
    case "agree":
      return agree;
    case "disagree":
      return -agree;
    case "pass":
      return 0;
    default:
      throw new VoteConventionError("semantic", vote);
  }
}

function convert(
  raw: RawVote,
  fromAgree: AgreeValue,
  toAgree: AgreeValue,
  representation: string,
  onInvalid: InvalidPolicy
): number | null {
  if (isNullish(raw)) return null;
  const vote = toSemantic(raw, fromAgree, representation, "skip");
  if (vote === null) {
    if (onInvalid === "keep") return raw;
    throw new VoteConventionError(representation, raw);
  }
  return fromSemantic(vote, toAgree);
}

function storageAgree(options?: ConversionOptions): AgreeValue {
  return (options?.convention ?? currentStorageConvention()).agreeValue;
}

// ---------------------------------------------------------------------------
// Public conversions
// ---------------------------------------------------------------------------

export function isVote(value: unknown): value is Vote {
  return value === "agree" || value === "disagree" || value === "pass";
}

/** Wire number → Vote. NULL → null. */
export function wireToSemantic(
  raw: RawVote,
  options?: ConversionOptions
): Vote | null {
  return toSemantic(
    raw,
    WIRE_AGREE_VALUE,
    "wire",
    options?.onInvalid ?? "throw"
  );
}

export function semanticToWire(vote: Vote): number {
  return fromSemantic(vote, WIRE_AGREE_VALUE);
}

/** Stored number → Vote. NULL → null. */
export function storageToSemantic(
  raw: RawVote,
  options?: ConversionOptions
): Vote | null {
  return toSemantic(
    raw,
    storageAgree(options),
    "storage",
    options?.onInvalid ?? "throw"
  );
}

export function semanticToStorage(
  vote: Vote,
  options?: ConversionOptions
): number {
  return fromSemantic(vote, storageAgree(options));
}

/** Export number (agree = +1) → Vote. NULL → null. */
export function exportToSemantic(
  raw: RawVote,
  options?: ConversionOptions
): Vote | null {
  return toSemantic(
    raw,
    EXPORT_AGREE_VALUE,
    "export",
    options?.onInvalid ?? "throw"
  );
}

export function semanticToExport(vote: Vote): number {
  return fromSemantic(vote, EXPORT_AGREE_VALUE);
}

/** The write path: a wire value from POST /votes or POST /comments → the value to INSERT. */
export function wireToStorage(
  raw: RawVote,
  options?: ConversionOptions
): number | null {
  return convert(
    raw,
    WIRE_AGREE_VALUE,
    storageAgree(options),
    "wire",
    options?.onInvalid ?? "throw"
  );
}

/** The read routes: a stored value → the value GET /votes, /votes/me and participationInit return. */
export function storageToWire(
  raw: RawVote,
  options?: ConversionOptions
): number | null {
  return convert(
    raw,
    storageAgree(options),
    WIRE_AGREE_VALUE,
    "storage",
    options?.onInvalid ?? "throw"
  );
}

/** The votes-bulk import: a CSV vote_value (agree = +1) → the value to INSERT. */
export function exportToStorage(
  raw: RawVote,
  options?: ConversionOptions
): number | null {
  return convert(
    raw,
    EXPORT_AGREE_VALUE,
    storageAgree(options),
    "export",
    options?.onInvalid ?? "throw"
  );
}

/**
 * The vote CSV exports: a stored value → the number written to the cell.
 * NULL → EXPORT_NULL_VALUE. An out-of-range stored integer throws by default;
 * with { onInvalid: "keep" } it is written as the exports have always written it
 * (`String(-row.vote)`: the value scaled by the storage and export agree signs),
 * so the export bytes do not change until the census (P-078 §1e.4) shows no
 * such rows exist.
 */
export function storageToExport(
  raw: RawVote,
  options?: ConversionOptions
): number {
  if (isNullish(raw)) return EXPORT_NULL_VALUE;
  const agree = storageAgree(options);
  const vote = toSemantic(raw, agree, "storage", "skip");
  if (vote === null) {
    if (options?.onInvalid === "keep") return raw * agree * EXPORT_AGREE_VALUE;
    throw new VoteConventionError("storage", raw);
  }
  return semanticToExport(vote);
}

/**
 * A votes / votes_latest_unique row as the read routes return it (GET /votes,
 * GET /votes/me, participationInit's votes): the vote in the wire convention.
 * Today wire equals storage, so the value is unchanged. An out-of-range stored
 * value is returned as stored, as the routes always have. The row is updated in
 * place so the JSON key order does not change.
 */
export function storageRowToWire<T extends { vote?: RawVote }>(
  row: T,
  options?: ConversionOptions
): T {
  if (row && "vote" in row) {
    row.vote = storageToWire(row.vote, {
      ...options,
      onInvalid: options?.onInvalid ?? "keep",
    });
  }
  return row;
}

/**
 * The integer to put in a SQL predicate that selects a stored vote, e.g.
 * `CASE WHEN v.vote = ${storageSqlValue("agree")} THEN 1 ...`. Always an
 * integer, so interpolation is safe.
 */
export function storageSqlValue(
  vote: Vote,
  options?: ConversionOptions
): number {
  const value = semanticToStorage(vote, options);
  if (!Number.isInteger(value)) throw new VoteConventionError("storage", value);
  return value;
}

/** Counts of semantic votes; NULL and skipped values are counted in `none`. */
export interface VoteTally {
  agree: number;
  disagree: number;
  pass: number;
  none: number;
}

export function emptyTally(): VoteTally {
  return { agree: 0, disagree: 0, pass: 0, none: 0 };
}

export function addToTally(
  tally: VoteTally,
  vote: Vote | null,
  n = 1
): VoteTally {
  if (vote === null) tally.none += n;
  else tally[vote] += n;
  return tally;
}

// ---------------------------------------------------------------------------
// The declared sign of the export file formats (P-078 PR-E)
// ---------------------------------------------------------------------------
//
// The CSV exports and the votes-bulk import carry the export convention above.
// They now say so: summary.csv has a `vote-convention` row, the export set has
// a format.json sidecar (exportFormat.ts), and a votes-bulk CSV may declare its
// sign on its first line or in a `format` object sent beside it. All three
// carry the same value, built here from the export constants:
//
//   agree=+1;disagree=-1;pass=0;format=polis-export/1
//
// docs/export-format.md is the prose statement of the same thing.

/** The version of the export file formats the declaration names. */
export const EXPORT_FORMAT_ID = "polis-export/1";

/** The summary.csv key, the format.json key and the import comment's name. */
export const VOTE_CONVENTION_KEY = "vote-convention";

/** A votes-bulk CSV whose first line starts with this declares its sign. */
export const IMPORT_DECLARATION_PREFIX = `# ${VOTE_CONVENTION_KEY}:`;

function signedText(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** The declaration of the export convention, as written in every file that carries it. */
export const EXPORT_VOTE_CONVENTION = [
  `agree=${signedText(EXPORT_AGREE)}`,
  `disagree=${signedText(EXPORT_DISAGREE)}`,
  `pass=${signedText(EXPORT_PASS)}`,
  `format=${EXPORT_FORMAT_ID}`,
].join(";");

/** The vote values of the export convention, as format.json states them. */
export const EXPORT_VOTE_VALUES: Readonly<Record<Vote, number>> = Object.freeze(
  {
    agree: EXPORT_AGREE,
    disagree: EXPORT_DISAGREE,
    pass: EXPORT_PASS,
  }
);

/**
 * The closed set of reasons a declared sign is refused. A declaration that
 * cannot be read is malformed; one that reads as a valid convention other than
 * the export convention (agree = -1, say, or another format id) is a mismatch.
 * Neither is ever converted: an import that names a sign the reader does not
 * hold is refused, never guessed at.
 */
export const VOTE_DECLARATION_ERRORS = Object.freeze({
  malformed: "polis_err_vote_convention_declaration_malformed",
  mismatch: "polis_err_vote_convention_declaration_mismatch",
} as const);

export type VoteDeclarationErrorCode =
  (typeof VOTE_DECLARATION_ERRORS)[keyof typeof VOTE_DECLARATION_ERRORS];

export class VoteDeclarationError extends Error {
  readonly code: VoteDeclarationErrorCode;
  readonly detail: string;
  constructor(code: VoteDeclarationErrorCode, detail: string) {
    super(code);
    this.name = "VoteDeclarationError";
    this.code = code;
    this.detail = detail;
  }
}

export interface DeclaredVoteConvention {
  /** The value agree takes in the declared file. */
  readonly agreeValue: AgreeValue;
  /** The format id the declaration names, or null when it names none. */
  readonly format: string | null;
}

function malformed(detail: string): VoteDeclarationError {
  return new VoteDeclarationError(VOTE_DECLARATION_ERRORS.malformed, detail);
}

function declaredInteger(key: string, text: unknown): number {
  const s = typeof text === "number" ? String(text) : text;
  if (typeof s !== "string" || !/^[+-]?\d+$/.test(s.trim())) {
    throw malformed(`${key} is not an integer`);
  }
  return parseInt(s.trim(), 10);
}

/**
 * The three declared values must form a convention: pass is 0, agree is +1 or
 * -1, disagree is its negation. Anything else is malformed, not a mismatch.
 */
function declaredConvention(
  values: Record<string, unknown>,
  format: unknown
): DeclaredVoteConvention {
  for (const key of VOTES) {
    if (!(key in values)) throw malformed(`${key} is missing`);
  }
  const agree = declaredInteger("agree", values.agree);
  const disagree = declaredInteger("disagree", values.disagree);
  const pass = declaredInteger("pass", values.pass);
  if (pass !== 0 || (agree !== 1 && agree !== -1) || disagree !== -agree) {
    throw malformed(
      `agree=${agree};disagree=${disagree};pass=${pass} is not a vote convention`
    );
  }
  if (format !== undefined && format !== null && typeof format !== "string") {
    throw malformed("format is not a string");
  }
  return Object.freeze({
    agreeValue: agree as AgreeValue,
    format: typeof format === "string" ? format.trim() : null,
  });
}

/**
 * Reads a declaration value: `agree=+1;disagree=-1;pass=0[;format=<id>]`, keys
 * in any order, whitespace around parts ignored. Unknown or repeated keys are
 * malformed.
 */
export function parseVoteConventionDeclaration(
  text: string
): DeclaredVoteConvention {
  if (typeof text !== "string" || text.trim() === "") {
    throw malformed("empty declaration");
  }
  const values: Record<string, string> = {};
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) throw malformed(`"${trimmed}" is not key=value`);
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!isVote(key) && key !== "format") {
      throw malformed(`unknown key "${key}"`);
    }
    if (key in values) throw malformed(`"${key}" is repeated`);
    values[key] = value;
  }
  return declaredConvention(values, values.format);
}

/**
 * Reads a format.json document (the export sidecar, or the `format` object a
 * votes-bulk request sends beside its CSV). It must carry the declaration
 * string under `vote-convention`, the values under `vote`, or both; when both
 * are present they must agree. A top-level `format` names the format id.
 */
export function parseVoteConventionDocument(
  doc: unknown
): DeclaredVoteConvention {
  let value = doc;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw malformed("format is not JSON");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw malformed("format is not an object");
  }
  const record = value as Record<string, unknown>;
  const text = record[VOTE_CONVENTION_KEY];
  const values = record.vote;
  if (text === undefined && values === undefined) {
    throw malformed(
      `format carries neither "${VOTE_CONVENTION_KEY}" nor "vote"`
    );
  }
  if (text !== undefined && typeof text !== "string") {
    throw malformed(`"${VOTE_CONVENTION_KEY}" is not a string`);
  }
  if (
    values !== undefined &&
    (values === null || typeof values !== "object" || Array.isArray(values))
  ) {
    throw malformed(`"vote" is not an object`);
  }
  const fromText =
    text === undefined ? null : parseVoteConventionDeclaration(text as string);
  const fromValues =
    values === undefined
      ? null
      : declaredConvention(values as Record<string, unknown>, null);
  if (fromText && fromValues && fromText.agreeValue !== fromValues.agreeValue) {
    throw malformed(`"${VOTE_CONVENTION_KEY}" and "vote" disagree`);
  }
  if (
    fromText?.format != null &&
    record.format != null &&
    fromText.format !== record.format
  ) {
    throw malformed(
      `"${VOTE_CONVENTION_KEY}" and "format" name different formats`
    );
  }
  const declared = (fromText ?? fromValues) as DeclaredVoteConvention;
  const format = record.format ?? declared.format;
  if (format !== null && typeof format !== "string") {
    throw malformed("format is not a string");
  }
  return Object.freeze({
    agreeValue: declared.agreeValue,
    format: typeof format === "string" ? format.trim() : null,
  });
}

/**
 * The import rule. A declared sign must be the export convention (and, when it
 * names a format, this one); otherwise it is refused with the mismatch code.
 * The returned convention is the one the reader then converts from, through
 * exportToStorage.
 */
export function requireExportConvention(
  declared: DeclaredVoteConvention
): DeclaredVoteConvention {
  if (declared.agreeValue !== EXPORT_AGREE_VALUE) {
    throw new VoteDeclarationError(
      VOTE_DECLARATION_ERRORS.mismatch,
      `declared agree=${signedText(
        declared.agreeValue
      )}; the import reads ${EXPORT_VOTE_CONVENTION}`
    );
  }
  if (declared.format !== null && declared.format !== EXPORT_FORMAT_ID) {
    throw new VoteDeclarationError(
      VOTE_DECLARATION_ERRORS.mismatch,
      `declared format=${declared.format}; the import reads ${EXPORT_FORMAT_ID}`
    );
  }
  return declared;
}

/**
 * If `line` (a CSV's first line, with or without its line ending or a byte
 * order mark) is a `# vote-convention:` declaration, returns it parsed;
 * otherwise null, and the line is the CSV header as it always was.
 */
export function readImportDeclarationLine(
  line: string
): DeclaredVoteConvention | null {
  const text = line.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  if (!text.startsWith(IMPORT_DECLARATION_PREFIX)) return null;
  return parseVoteConventionDeclaration(
    text.slice(IMPORT_DECLARATION_PREFIX.length)
  );
}

/**
 * The votes-bulk rule in one call, used by the route (to refuse early) and the
 * worker (which reads the stored file). `firstLine` is the CSV's first line;
 * `formatDoc` the optional `format` sent beside it. Absent both: null, and the
 * file is read as it always has been (export convention). Present: each must
 * be the export convention, or this throws VoteDeclarationError.
 */
export function checkImportDeclaration(
  firstLine: string | null,
  formatDoc?: unknown
): DeclaredVoteConvention | null {
  const inFile =
    firstLine === null ? null : readImportDeclarationLine(firstLine);
  const beside =
    formatDoc === undefined || formatDoc === null || formatDoc === ""
      ? null
      : parseVoteConventionDocument(formatDoc);
  if (inFile) requireExportConvention(inFile);
  if (beside) requireExportConvention(beside);
  return inFile ?? beside;
}
