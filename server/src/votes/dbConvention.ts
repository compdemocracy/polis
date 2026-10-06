/**
 * The database's declaration of the stored vote sign, read at startup.
 *
 * Migration 000023 gives the database one row, public.vote_convention, that
 * names which stored value means "agree". This module reads it through
 * public.vote_convention_current() and decides whether THIS build of the
 * server may run against it:
 *
 *   - no table / no function  -> migration 000023 is not applied: refuse
 *   - table, no row           -> the database holds votes and nobody has
 *                                declared its sign: refuse, naming the one
 *                                command that declares it
 *   - a contract this build does not know -> a newer release changed the
 *                                database: refuse
 *   - a sign other than the one this build is built for -> refuse: serving it
 *                                would read and write every vote inverted
 *   - the sign this build is built for -> start
 *
 * The sign this build is built for is the chokepoint's STORAGE_AGREE_VALUE
 * (server/src/votes/convention.ts). No literal sign appears here.
 *
 * Every message says what is wrong, that nothing was changed, the next
 * command, and the guide (docs/vote-convention-upgrade.md). The texts are
 * mirrored by the math engine (delphi/polismath/utils/vote_convention_boot.py)
 * and the coordinator (coordinator-rs/src/vote_convention.rs).
 */
import {
  STORAGE_AGREE_VALUE,
  type AgreeValue,
  type StorageConvention,
} from "./convention";

/** The installed-surface contracts this build understands. */
export const SUPPORTED_VOTE_CONTRACTS: readonly number[] = Object.freeze([1]);

export const VOTE_CONVENTION_GUIDE = "docs/vote-convention-upgrade.md";
export const VOTE_CONVENTION_MIGRATION =
  "server/postgres/migrations/000023_vote_convention.sql";

/** A `query(sql)` that resolves to the rows, as pg-query's queryP does. */
export type ConventionQuery = (
  sql: string
) => Promise<ReadonlyArray<Record<string, unknown>>>;

export type DatabaseConvention =
  | { readonly state: "no-table" }
  | { readonly state: "no-row" }
  | {
      readonly state: "declared";
      readonly version: number;
      readonly agreeValue: number;
      readonly contractVersion: number;
    };

export type ConventionRefusal =
  | "vote_convention_not_installed"
  | "vote_convention_undeclared"
  | "vote_convention_contract_unsupported"
  | "vote_convention_mismatch";

export type ConventionVerdict =
  | { readonly ok: true; readonly convention: StorageConvention }
  | {
      readonly ok: false;
      readonly code: ConventionRefusal;
      readonly message: string;
    };

export class VoteConventionStartupError extends Error {
  readonly code: ConventionRefusal;
  constructor(code: ConventionRefusal, message: string) {
    super(message);
    this.name = "VoteConventionStartupError";
    this.code = code;
  }
}

const PRESENT_SQL =
  "SELECT to_regclass('public.vote_convention') IS NOT NULL AND to_regprocedure('public.vote_convention_current()') IS NOT NULL AS present";
const ROW_SQL =
  "SELECT version, agree_value, contract_version FROM public.vote_convention_current()";

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** The exact command an operator runs to declare an existing database's sign. */
export function declareCommand(agree: AgreeValue = STORAGE_AGREE_VALUE): string {
  return `make vote-convention-declare AGREE=${signed(agree)}`;
}

function integer(value: unknown, what: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new VoteConventionStartupError(
      "vote_convention_mismatch",
      `Polis cannot start: public.vote_convention_current() returned a ${what} that is not an integer (${String(
        value
      )}). Nothing has been changed. Guide: ${VOTE_CONVENTION_GUIDE}#inconsistent`
    );
  }
  return n;
}

/** What the database declares, without judging it. */
export async function readDatabaseConvention(
  query: ConventionQuery
): Promise<DatabaseConvention> {
  const present = await query(PRESENT_SQL);
  if (!present.length || present[0].present !== true) {
    return { state: "no-table" };
  }
  const rows = await query(ROW_SQL);
  if (rows.length === 0) return { state: "no-row" };
  if (rows.length !== 1) {
    throw new VoteConventionStartupError(
      "vote_convention_mismatch",
      `Polis cannot start: public.vote_convention_current() returned ${rows.length} rows; exactly one is required. Nothing has been changed. Guide: ${VOTE_CONVENTION_GUIDE}#inconsistent`
    );
  }
  return {
    state: "declared",
    version: integer(rows[0].version, "version"),
    agreeValue: integer(rows[0].agree_value, "agree_value"),
    contractVersion: integer(rows[0].contract_version, "contract_version"),
  };
}

/**
 * The decision: may a build made for `builtFor` run against what the
 * database declares? `component` names the process in the message ("server",
 * "import worker").
 */
export function judgeDatabaseConvention(
  found: DatabaseConvention,
  component: string,
  builtFor: AgreeValue = STORAGE_AGREE_VALUE,
  supportedContracts: readonly number[] = SUPPORTED_VOTE_CONTRACTS
): ConventionVerdict {
  const prefix = `Polis cannot start (${component}):`;
  switch (found.state) {
    case "no-table":
      return {
        ok: false,
        code: "vote_convention_not_installed",
        message:
          `${prefix} this database has no vote_convention table, so it does not record which stored vote value means "agree". ` +
          `Migration 000023 has not been applied. Nothing has been changed. ` +
          `Next: back up the database, apply ${VOTE_CONVENTION_MIGRATION} (see docs/migrations.md), ` +
          `then, if the database already holds votes, run "${declareCommand()}". ` +
          `Guide: ${VOTE_CONVENTION_GUIDE}#guard`,
      };
    case "no-row":
      return {
        ok: false,
        code: "vote_convention_undeclared",
        message:
          `${prefix} this database does not record which stored vote value means "agree". ` +
          `Older Polis databases store agree as ${signed(
            builtFor
          )}; this release no longer assumes it. Nothing has been changed. ` +
          `Next: back up the database, then declare its convention with "${declareCommand()}" ` +
          `(AGREE=${signed(
            -builtFor
          )} only if your deployment reversed its vote signs itself). ` +
          `Guide: ${VOTE_CONVENTION_GUIDE}#declare`,
      };
    case "declared": {
      if (!supportedContracts.includes(found.contractVersion)) {
        return {
          ok: false,
          code: "vote_convention_contract_unsupported",
          message:
            `${prefix} this database uses vote convention contract ${found.contractVersion}; ` +
            `this release understands ${supportedContracts.join(", ")}. A newer Polis release changed the database. ` +
            `Nothing has been changed. Next: run that newer release, or restore the backup taken before it. ` +
            `Guide: ${VOTE_CONVENTION_GUIDE}#a-newer-database`,
        };
      }
      if (found.agreeValue !== builtFor) {
        return {
          ok: false,
          code: "vote_convention_mismatch",
          message:
            `${prefix} this database declares vote convention version ${found.version} (agree = ${signed(
              found.agreeValue
            )}), but this release of the ${component} is built for agree = ${signed(
              builtFor
            )}. Running it would read and write every vote inverted. Nothing has been changed. ` +
            `Next: run a Polis release built for the declared convention, or restore the database this release was built for. ` +
            `Guide: ${VOTE_CONVENTION_GUIDE}#mismatch`,
        };
      }
      return {
        ok: true,
        convention: Object.freeze({
          agreeValue: builtFor,
          version: found.version,
        }),
      };
    }
  }
}

/**
 * The startup check: read, judge, and either return the declared convention
 * or throw VoteConventionStartupError with the operator message. When a
 * read replica is in use its declaration is read too and must equal the
 * primary's.
 */
export async function requireDeclaredConvention(
  query: ConventionQuery,
  component: string,
  readOnlyQuery?: ConventionQuery
): Promise<StorageConvention> {
  const found = await readDatabaseConvention(query);
  const verdict = judgeDatabaseConvention(found, component);
  // Compared with false, not negated: the server compiles without
  // strictNullChecks, where truthiness does not narrow the union.
  if (verdict.ok === false) {
    throw new VoteConventionStartupError(verdict.code, verdict.message);
  }
  if (readOnlyQuery) {
    const replica = await readDatabaseConvention(readOnlyQuery);
    const replicaVerdict = judgeDatabaseConvention(
      replica,
      `${component}, read replica`
    );
    if (replicaVerdict.ok === false) {
      throw new VoteConventionStartupError(
        replicaVerdict.code,
        replicaVerdict.message
      );
    }
    if (
      replica.state === "declared" &&
      found.state === "declared" &&
      replica.version !== found.version
    ) {
      throw new VoteConventionStartupError(
        "vote_convention_mismatch",
        `Polis cannot start (${component}): the primary database declares vote convention version ${found.version} but the read replica declares version ${replica.version}. ` +
          `Wait for the replica to catch up, or point READ_ONLY_DATABASE_URL at the primary. Nothing has been changed. Guide: ${VOTE_CONVENTION_GUIDE}#replicas`
      );
    }
  }
  return verdict.convention;
}
