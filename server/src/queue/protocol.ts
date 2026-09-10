/**
 * The closed polis-queue/1 wire boundary, shared by every Node caller of the
 * queue schema.
 *
 * The field set is frozen by the migration, not by the string "polis-queue/1",
 * so this validator rejects missing AND unknown fields. An adapter that
 * tolerated an extra field would also tolerate a different schema, which is the
 * exact failure the round-4 review asked both adapters to pin against.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const QUEUE_CONTRACT_VERSION = "polis-queue/1";

/** The only stage the /1 schema admits. It is a table CHECK, not a setting. */
export const QUEUE_STAGE = "noop";

/**
 * SHA-256 of server/postgres/migrations/000019_create_polis_queue.sql as this
 * adapter was written against it. Round 4 requires both adapters to pin the
 * SQL, so that no deployed adapter is silently upgraded by a schema change.
 * The Python executor pins the same value.
 *
 * This pins the file in the repository. It is not runtime attestation: it says
 * nothing about what an administrator later did to the live catalog. The
 * migration's own catalog fingerprints cover that.
 */
export const QUEUE_SQL_SHA256 =
  "240d445ecc88c0ddb3b24ba2d62a8ad00316fe4381dadb566d2c5d1f48c2c1bc";

export const QUEUE_MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "..",
  "postgres",
  "migrations",
  "000019_create_polis_queue.sql"
);

/** Digest the migration file on disk, for the test that enforces the pin. */
export function migrationSha256(): string {
  return createHash("sha256")
    .update(fs.readFileSync(QUEUE_MIGRATION_PATH))
    .digest("hex");
}

/** Closed field set of an ordinary polis-queue/1 result. */
export const ORDINARY_RESULT_FIELDS: readonly string[] = [
  "attempt_count",
  "attempt_id",
  "eligible_at",
  "env",
  "first_parked_at",
  "input",
  "job_id",
  "last_error_code",
  "lease_epoch",
  "locked_until",
  "max_attempts",
  "mgmt_version",
  "outcome",
  "output_sha256",
  "owner_id",
  "parked_attempt_count",
  "published",
  "run_id",
  "schema_version",
  "stage",
  "stage_instance",
  "state",
  "version",
];

const INPUT_FIELDS: readonly string[] = [
  "code_image_digest",
  "config_sha256",
  "sha256",
  "uri",
];

/** Counters that cross the wire as decimal strings, never as JSON numbers. */
const DECIMAL_STRING_FIELDS = ["lease_epoch", "version", "mgmt_version"];
const BOUNDED_INTEGER_FIELDS = [
  "attempt_count",
  "max_attempts",
  "parked_attempt_count",
];
const UTC_TIMESTAMP_FIELDS = ["locked_until", "eligible_at", "first_parked_at"];
const NULLABLE_TEXT_FIELDS = [
  "env",
  "job_id",
  "run_id",
  "attempt_id",
  "owner_id",
  "state",
  "output_sha256",
  "stage",
  "stage_instance",
  "last_error_code",
  "outcome",
];

export interface QueueOrdinaryResult {
  schema_version: string;
  outcome: string;
  env: string | null;
  job_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  owner_id: string | null;
  lease_epoch: string | null;
  version: string | null;
  mgmt_version: string | null;
  locked_until: string | null;
  state: string | null;
  output_sha256: string | null;
  published: boolean;
  stage: string | null;
  stage_instance: string | null;
  attempt_count: number | null;
  max_attempts: number | null;
  parked_attempt_count: number | null;
  eligible_at: string | null;
  first_parked_at: string | null;
  last_error_code: string | null;
  input: {
    uri: string;
    sha256: string;
    config_sha256: string;
    code_image_digest: string;
  } | null;
}

export class QueueProtocolError extends Error {
  constructor(detail: string) {
    super(`invalid_queue_reply: ${detail}`);
    this.name = "QueueProtocolError";
  }
}

/**
 * Reject anything that is not an ordinary polis-queue/1 result: wrong version,
 * missing field, unknown field, wrongly typed counter, non-UTC timestamp, or a
 * published flag that is not a boolean.
 */
export function assertOrdinaryResult(value: unknown): QueueOrdinaryResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QueueProtocolError("reply is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== QUEUE_CONTRACT_VERSION) {
    throw new QueueProtocolError(
      `wire version ${String(record.schema_version)}; ` +
        `this adapter is pinned to ${QUEUE_CONTRACT_VERSION}`
    );
  }
  const seen = Object.keys(record).sort();
  const want = [...ORDINARY_RESULT_FIELDS].sort();
  const unknown = seen.filter((field) => !want.includes(field));
  const missing = want.filter((field) => !seen.includes(field));
  if (unknown.length > 0 || missing.length > 0) {
    throw new QueueProtocolError(
      `field set mismatch; unknown=[${unknown.join(
        ","
      )}] missing=[${missing.join(",")}]`
    );
  }
  if (typeof record.published !== "boolean") {
    throw new QueueProtocolError("published must be a boolean");
  }
  for (const field of DECIMAL_STRING_FIELDS) {
    const raw = record[field];
    if (raw !== null && (typeof raw !== "string" || !/^\d+$/.test(raw))) {
      throw new QueueProtocolError(`${field} must be a decimal string or null`);
    }
  }
  for (const field of BOUNDED_INTEGER_FIELDS) {
    const raw = record[field];
    if (
      raw !== null &&
      (!Number.isInteger(raw) ||
        (raw as number) < 0 ||
        (raw as number) > 2147483647)
    ) {
      throw new QueueProtocolError(
        `${field} must be a bounded integer or null`
      );
    }
  }
  for (const field of UTC_TIMESTAMP_FIELDS) {
    const raw = record[field];
    if (raw !== null && (typeof raw !== "string" || !raw.endsWith("+00:00"))) {
      throw new QueueProtocolError(`${field} must be a UTC timestamp or null`);
    }
  }
  for (const field of NULLABLE_TEXT_FIELDS) {
    const raw = record[field];
    if (raw !== null && typeof raw !== "string") {
      throw new QueueProtocolError(`${field} must be text or null`);
    }
  }
  if (record.input !== null) {
    if (typeof record.input !== "object" || Array.isArray(record.input)) {
      throw new QueueProtocolError("input must be an object or null");
    }
    const input = record.input as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(",") !== [...INPUT_FIELDS].sort().join(",")
    ) {
      throw new QueueProtocolError(
        `input field set mismatch: ${Object.keys(input).sort().join(",")}`
      );
    }
    if (!Object.values(input).every((v) => typeof v === "string")) {
      throw new QueueProtocolError("input fields must all be text");
    }
  }
  return record as unknown as QueueOrdinaryResult;
}
