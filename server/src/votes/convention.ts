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
