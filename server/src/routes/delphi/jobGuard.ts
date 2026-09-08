/**
 * Server-side active-work deduplication for Delphi job submission (P-003 S3).
 *
 * Both HTTP producers (`POST /api/v3/delphi/jobs` and
 * `POST /api/v3/delphi/batchReports`) used to mint a fresh id and do an
 * unconditional `PutItem`, so an impatient user who reloaded and resubmitted
 * during a long PENDING paid for two Anthropic batch runs. This module is the
 * paid-work correctness gate named in P-003 rev3.
 *
 * The shape of the thing, after two rounds of review:
 *
 * - **Scope** is `job_type + conversation + report`. Rev3 excludes simultaneous
 *   work by that triple; two different configs still reset and publish into the
 *   same structures, so configuration is payload binding, not a concurrency
 *   exemption.
 * - **Admission** is one `TransactWriteItems`: the queue row and the guard row,
 *   both conditional on non-existence. Either both land or neither does.
 * - **Release needs proof, from two sides.** The server's half: a
 *   strongly-consistent terminal root and a *completed*, strongly-consistent
 *   base-table scan finding no non-terminal descendant. A GSI cannot serve here
 *   — it is eventually consistent and does not accept `ConsistentRead` — and an
 *   error, a cap, or a missing root row is uncertainty, which keeps the guard.
 *   The writer's half: `job_poller.py` stops and joins a job's child process
 *   before marking it FAILED, and records `process_exit_confirmed`. Without
 *   that, a FAILED root can still grow a checker afterwards, so a FAILED root
 *   that does not carry the confirmation is *not* released.
 * - **Fail closed.** A missing guard table, or any sweep that cannot be
 *   completed, raises {@link JobAdmissionUnavailableError} and writes nothing.
 * - **Migration.** A guard table that has just been created knows nothing about
 *   running jobs. Admission first looks for existing active work in the scope —
 *   including a live checker under an already-terminal root — and adopts its
 *   root. It then re-checks after writing, because a producer that does not
 *   participate in the transaction cannot be fenced by a read; see
 *   {@link admitDelphiJob} for what that window does and does not cover.
 * - **Idempotency.** Every accepted key is bound to the job actually
 *   acknowledged, including on deduplication and adoption, so the declared
 *   retry window applies to the first keyed response and not only to keys that
 *   happened to create a job.
 *
 * G6 / "guard and queue migrate together": every read and write goes through
 * {@link JobAdmissionStore}, against one substrate, and creation is one
 * transaction. There is no path that writes one store without the other, so
 * P-024 re-points both in the same cutover.
 */
import { createHash, randomUUID } from "crypto";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import logger from "../../utils/logger";
import Config from "../../config";

export const JOB_QUEUE_TABLE = "Delphi_JobQueue";
export const JOB_GUARD_TABLE = "Delphi_JobActiveGuard";

/**
 * Statuses that mean a job row is durably finished. Everything else — PENDING,
 * PROCESSING, AWAITING_RECHECK, LOCKED_FOR_CHECKING, an unknown or a missing
 * status — is treated as still possibly holding paid work. Mirrors
 * `delphi/scripts/job_poller.py` and `803_check_batch_status.py`.
 */
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

/**
 * Bounds on the strongly-consistent base-table sweeps. Reaching either bound is
 * an incomplete observation, which keeps the guard rather than releasing it.
 * The queue was measured at 255 rows / ~1.1 MB, so these are generous.
 */
const SCAN_MAX_PAGES = 40;
const SCAN_MAX_SCANNED_ITEMS = 20000;
const SCAN_PAGE_SIZE = 200;

/** Attempts of the whole admit/resolve cycle before giving up. */
const MAX_ADMISSION_ATTEMPTS = 3;

/**
 * How long a supplied idempotency key stays bound to the job it was
 * acknowledged with. **Anchored at the moment the binding is written**, not at
 * the job's completion: a key first used at T is replayable until T + 24 h,
 * whether the job is still running or finished ten minutes in. Beyond it the
 * key is stale and a new run is admitted, so an intentional rerun needs a new
 * key (or none) rather than a wait.
 *
 * Evaluated in code. There is deliberately no DynamoDB TTL, which could expire
 * a row while paid work is still live.
 */
export const IDEMPOTENCY_BINDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Byte that separates hash components; escaped so the file stays text. */
const HASH_SEPARATOR = "\u0000";

/**
 * Raised when the admission substrate cannot answer safely. The producer must
 * report unavailability and write nothing: an un-deduplicated fallback would be
 * a second paid provider run.
 */
export class JobAdmissionUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "JobAdmissionUnavailable";
  }
}

export interface JobScope {
  /** Internal conversation id (zid) as stored on the queue row. */
  conversationId: string;
  /** Public report id, when the request carried one. */
  reportId?: string | null;
  jobType: string;
  /**
   * The `job_config` JSON string that will be written on the queue row. Not
   * part of the scope; it is the payload an idempotency key binds to.
   */
  jobConfig: string;
}

export interface AdmissionRequest {
  scope: JobScope;
  /** Fully-built queue row, written verbatim on admission. */
  jobItem: Record<string, unknown>;
  /** Optional client-supplied idempotency key; binds the request payload. */
  idempotencyKey?: string | null;
}

export interface GuardRow {
  guard_key: string;
  job_id: string;
  version: number;
  conversation_id: string;
  report_id?: string | null;
  job_type: string;
  scope_guard_key?: string;
  config_hash?: string;
  binding_expires_at?: string;
  [key: string]: unknown;
}

/** The queue-row fields the guard reads. */
export interface JobRow {
  status: string;
  process_exit_confirmed?: boolean;
  checker_schedule_failed?: boolean;
  batch_job_id?: string;
  job_type?: string;
  report_id?: string;
  conversation_id?: string;
}

export type AdmissionResult =
  /** A new queue row and its guard were created in one transaction. */
  | { outcome: "created"; jobId: string; jobStatus: string; workLive: true }
  /**
   * No new paid work. `adopted` marks the migration case: active work that
   * predates the guard table, now covered by a freshly written guard.
   */
  | {
      outcome: "deduplicated";
      jobId: string;
      jobStatus: string;
      workLive: boolean;
      adopted?: boolean;
    }
  /** The idempotency key was reused with a different payload or scope. */
  | { outcome: "idempotency_conflict"; jobId: string };

/** Result of a sweep that must be authoritative to be actionable. */
type SweepResult<T> =
  | { kind: "found"; value: T }
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

/** What a job row means for "is paid work still outstanding?". */
export interface Liveness {
  status: string;
  /** True whenever work may still be outstanding, including every unknown. */
  live: boolean;
  /** Why the answer is what it is, for logs. */
  reason: string;
}

/**
 * The one seam P-024 re-points. Guard and queue reads/writes all go through it,
 * so the substrate moves as a unit.
 */
export interface JobAdmissionStore {
  /** Atomically create the queue row and its guard row(s). */
  admit(
    request: AdmissionRequest,
    guardItem: Record<string, unknown>,
    aliasItem: Record<string, unknown> | null
  ): Promise<
    | { outcome: "admitted" }
    | { outcome: "scope_taken" }
    | { outcome: "idempotency_taken" }
    | { outcome: "job_id_taken" }
  >;
  /** Strongly-consistent read of a guard row. */
  readGuard(guardKey: string): Promise<GuardRow | null>;
  /** Strongly-consistent read of a queue row; null when absent. */
  readJob(jobId: string): Promise<JobRow | null>;
  /**
   * Authoritative answer to "does this root still have a non-terminal
   * provider/checker descendant?". Must be a strongly-consistent base-table
   * read; `unknown` whenever the sweep could not be completed.
   */
  sweepLiveDescendants(rootJobId: string): Promise<SweepResult<string>>;
  /**
   * Authoritative answer to "is there active work in this scope that no guard
   * covers?" — the migration case. Returns the *root* job id of whatever it
   * finds, including the root of a live checker under an already-terminal
   * parent. `unknown` whenever the sweep could not be completed or a row could
   * not be classified.
   */
  sweepUnguardedActiveRoot(
    scope: JobScope,
    exceptJobId?: string
  ): Promise<SweepResult<string>>;
  /** Write a guard row for an already-existing root; false if one appeared first. */
  adoptGuard(guardItem: Record<string, unknown>): Promise<boolean>;
  /** Write an idempotency alias; false if one appeared first. */
  bindAlias(aliasItem: Record<string, unknown>): Promise<boolean>;
  /** Delete a guard row under an exact job/version condition. */
  clearGuard(guard: GuardRow): Promise<boolean>;
  /** Delete an expired idempotency alias under an exact job condition. */
  clearAlias(alias: GuardRow): Promise<boolean>;
  /**
   * Delete a queue row this request created, only while it is still unclaimed.
   * The compensating action for losing a race with a producer that does not
   * participate in the guard transaction.
   */
  deleteUnclaimedJob(jobId: string): Promise<boolean>;
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalise(source[key]);
        return acc;
      }, {});
  }
  return value;
}

function sha256(parts: string[]): string {
  return createHash("sha256").update(parts.join(HASH_SEPARATOR)).digest("hex");
}

/**
 * Fingerprint of the request payload, normalised so that key order and
 * whitespace do not make two identical submissions look different. Used only
 * for idempotency-key payload binding, never for the scope.
 */
export function configFingerprint(jobConfig: string): string {
  try {
    return sha256([
      "cfg1",
      JSON.stringify(canonicalise(JSON.parse(jobConfig))),
    ]);
  } catch {
    return sha256(["cfg1", jobConfig]);
  }
}

/**
 * The authorized scope: at most one active root per job type per
 * conversation/report. Rev3's exclusion, and deliberately not the job config.
 */
export function scopeGuardKey(scope: JobScope): string {
  return `s:${sha256([
    "v2",
    scope.jobType,
    scope.conversationId,
    scope.reportId || "",
  ])}`;
}

export function idempotencyGuardKey(
  scope: JobScope,
  idempotencyKey: string
): string {
  return `i:${sha256([
    "v2",
    scope.conversationId,
    scope.reportId || "",
    idempotencyKey,
  ])}`;
}

/** Hashed scope, safe to log. */
function logScope(guardKey: string): string {
  return guardKey.slice(0, 14);
}

const dynamoDbConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDbConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDbConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  dynamoDbConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}

const docClient = DynamoDBDocument.from(new DynamoDB(dynamoDbConfig));

function cancellationCodes(error: any): string[] {
  const reasons = error?.CancellationReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.map((reason: any) => reason?.Code || "None");
}

function isSubstrateMissing(error: any): boolean {
  return error?.name === "ResourceNotFoundException";
}

const JOB_PROJECTION =
  "#s, #jid, batch_job_id, job_type, report_id, conversation_id, process_exit_confirmed, checker_schedule_failed";
const JOB_PROJECTION_NAMES = { "#s": "status", "#jid": "job_id" };

export const dynamoJobAdmissionStore: JobAdmissionStore = {
  async admit(request, guardItem, aliasItem) {
    const transactItems: any[] = [
      {
        Put: {
          TableName: JOB_QUEUE_TABLE,
          Item: request.jobItem,
          ConditionExpression: "attribute_not_exists(job_id)",
        },
      },
      {
        Put: {
          TableName: JOB_GUARD_TABLE,
          Item: guardItem,
          ConditionExpression: "attribute_not_exists(guard_key)",
        },
      },
    ];

    if (aliasItem) {
      transactItems.push({
        Put: {
          TableName: JOB_GUARD_TABLE,
          Item: aliasItem,
          ConditionExpression: "attribute_not_exists(guard_key)",
        },
      });
    }

    try {
      await docClient.transactWrite({ TransactItems: transactItems });
      return { outcome: "admitted" };
    } catch (error: any) {
      if (error?.name !== "TransactionCanceledException") {
        throw error;
      }
      const codes = cancellationCodes(error);
      // Order matters only as a hint: every resolution path re-validates the
      // alias and the guard, because more than one condition can fail at once.
      if (codes[0] === "ConditionalCheckFailed") {
        return { outcome: "job_id_taken" };
      }
      if (codes[1] === "ConditionalCheckFailed") {
        return { outcome: "scope_taken" };
      }
      if (codes[2] === "ConditionalCheckFailed") {
        return { outcome: "idempotency_taken" };
      }
      throw error;
    }
  },

  async readGuard(guardKey) {
    const result = await docClient.get({
      TableName: JOB_GUARD_TABLE,
      Key: { guard_key: guardKey },
      ConsistentRead: true,
    });
    return (result.Item as GuardRow | undefined) || null;
  },

  async readJob(jobId) {
    const result = await docClient.get({
      TableName: JOB_QUEUE_TABLE,
      Key: { job_id: jobId },
      ConsistentRead: true,
      ProjectionExpression: JOB_PROJECTION,
      ExpressionAttributeNames: JOB_PROJECTION_NAMES,
    });
    if (!result.Item) {
      return null;
    }
    return {
      ...(result.Item as JobRow),
      status: (result.Item.status as string) || "UNKNOWN",
    };
  },

  async sweepLiveDescendants(rootJobId) {
    // `801_narrative_report_batch.py` schedules checker rows carrying
    // `batch_job_id = <root job id>`. They are not indexed by that attribute,
    // and a ConversationIndex query could not prove their absence anyway: a GSI
    // is eventually consistent and does not accept ConsistentRead. Only a
    // strongly-consistent base-table scan is authoritative.
    const rows = await baseTableSweep(
      "batch_job_id = :root AND NOT (#s IN (:completed, :failed))",
      { ":root": rootJobId, ":completed": "COMPLETED", ":failed": "FAILED" },
      "descendants of a terminal root"
    );
    if (rows.kind !== "found") {
      return rows;
    }
    return { kind: "found", value: String(rows.value[0].job_id) };
  },

  async sweepUnguardedActiveRoot(scope, exceptJobId) {
    // Every non-terminal row in the conversation, then classify. A live checker
    // means its *root* still owns the scope even if that root is already
    // COMPLETED, so filtering children out here would miss exactly the state
    // the guarded path exists to protect.
    const rows = await baseTableSweep(
      "conversation_id = :cid AND NOT (#s IN (:completed, :failed))",
      {
        ":cid": scope.conversationId,
        ":completed": "COMPLETED",
        ":failed": "FAILED",
      },
      "unguarded active work"
    );
    if (rows.kind !== "found") {
      return rows;
    }

    const wantReport = scope.reportId || "";
    for (const row of rows.value) {
      const jobId = String(row.job_id);
      if (exceptJobId && jobId === exceptJobId) {
        continue;
      }
      const parentId = row.batch_job_id ? String(row.batch_job_id) : null;
      if (!parentId) {
        // A root of its own. Does it belong to this scope?
        if (
          row.job_type === scope.jobType &&
          (row.report_id || "") === wantReport
        ) {
          return { kind: "found", value: jobId };
        }
        continue;
      }
      if (exceptJobId && parentId === exceptJobId) {
        continue;
      }
      // A checker child: its root owns the scope. Read the root to classify it.
      const parent = await this.readJob(parentId);
      if (!parent) {
        // Live child, unreadable lineage. We cannot tell whose scope this
        // occupies, and guessing either way risks a second paid run.
        return {
          kind: "unknown",
          reason: `live descendant ${jobId} has no readable root`,
        };
      }
      if (
        parent.job_type === scope.jobType &&
        (parent.report_id || "") === wantReport
      ) {
        return { kind: "found", value: parentId };
      }
    }
    return { kind: "none" };
  },

  async adoptGuard(guardItem) {
    return conditionalPut(JOB_GUARD_TABLE, guardItem, "guard_key");
  },

  async bindAlias(aliasItem) {
    return conditionalPut(JOB_GUARD_TABLE, aliasItem, "guard_key");
  },

  async clearGuard(guard) {
    try {
      await docClient.delete({
        TableName: JOB_GUARD_TABLE,
        Key: { guard_key: guard.guard_key },
        // `version` is a DynamoDB reserved word, hence the name placeholder.
        ConditionExpression: "job_id = :jid AND #ver = :ver",
        ExpressionAttributeNames: { "#ver": "version" },
        ExpressionAttributeValues: {
          ":jid": guard.job_id,
          ":ver": guard.version,
        },
      });
      return true;
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        // Someone else already reconciled this guard; re-read and retry.
        return false;
      }
      throw error;
    }
  },

  async clearAlias(alias) {
    try {
      await docClient.delete({
        TableName: JOB_GUARD_TABLE,
        Key: { guard_key: alias.guard_key },
        ConditionExpression: "job_id = :jid",
        ExpressionAttributeValues: { ":jid": alias.job_id },
      });
      return true;
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },

  async deleteUnclaimedJob(jobId) {
    try {
      await docClient.delete({
        TableName: JOB_QUEUE_TABLE,
        Key: { job_id: jobId },
        // Only while no worker has taken it: `job_poller.py:claim_job` moves
        // status to PROCESSING and stamps worker_id.
        ConditionExpression: "#s = :pending AND #w = :unclaimed",
        ExpressionAttributeNames: { "#s": "status", "#w": "worker_id" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":unclaimed": "none",
        },
      });
      return true;
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },
};

async function conditionalPut(
  table: string,
  item: Record<string, unknown>,
  keyName: string
): Promise<boolean> {
  try {
    await docClient.put({
      TableName: table,
      Item: item,
      ConditionExpression: `attribute_not_exists(${keyName})`,
    });
    return true;
  } catch (error: any) {
    if (error?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

/**
 * Bounded, strongly-consistent scan of the queue's base table.
 *
 * Returns `unknown` — never `none` — if the scan errors or hits a bound, so a
 * partial observation can never be mistaken for proof that nothing matched.
 * The projection is a privacy control: DynamoDB charges on the items read.
 */
async function baseTableSweep(
  filterExpression: string,
  values: Record<string, unknown>,
  what: string
): Promise<SweepResult<any[]>> {
  const params: any = {
    TableName: JOB_QUEUE_TABLE,
    ConsistentRead: true,
    FilterExpression: filterExpression,
    ExpressionAttributeValues: values,
    ExpressionAttributeNames: JOB_PROJECTION_NAMES,
    ProjectionExpression: JOB_PROJECTION,
    Limit: SCAN_PAGE_SIZE,
  };

  let scanned = 0;
  const matches: any[] = [];
  try {
    for (let page = 0; page < SCAN_MAX_PAGES; page++) {
      const result = await docClient.scan(params);
      if (result.Items?.length) {
        matches.push(...result.Items);
      }
      scanned += result.ScannedCount || 0;
      if (!result.LastEvaluatedKey) {
        return matches.length
          ? { kind: "found", value: matches }
          : { kind: "none" };
      }
      if (scanned >= SCAN_MAX_SCANNED_ITEMS) {
        return { kind: "unknown", reason: `${what}: scanned-item cap reached` };
      }
      params.ExclusiveStartKey = result.LastEvaluatedKey;
    }
    return { kind: "unknown", reason: `${what}: page cap reached` };
  } catch (error: any) {
    if (isSubstrateMissing(error)) {
      throw error;
    }
    return {
      kind: "unknown",
      reason: `${what}: ${error?.name || "read failed"}`,
    };
  }
}

/**
 * Is paid work still outstanding under this job?
 *
 * Every uncertain answer resolves to "yes". Releasing a guard authorises a
 * second paid provider run, so it needs proof, not the absence of evidence.
 * The descendant sweep runs whatever the root's status is, so that the answer
 * is the same on every path that reports it — a COMPLETED root with a live
 * checker is live work, however the caller arrived at it.
 *
 * Three things must all hold before this reports `live: false`:
 *
 * 1. a strongly-consistent read shows the root COMPLETED or FAILED;
 * 2. a *completed* strongly-consistent descendant sweep finds nothing;
 * 3. the terminal transition is trustworthy. A FAILED root must carry
 *    `process_exit_confirmed`, which `job_poller.py` writes only after it has
 *    stopped and joined the job's child process. Without that the root may have
 *    been failed out from under a live subprocess that can still create a
 *    checker. `checker_schedule_failed` — written by
 *    `801_narrative_report_batch.py` when a provider batch was submitted but
 *    its checker row could not be scheduled — is outstanding work with nothing
 *    left to find, so it also keeps the guard.
 */
export async function assessJobLiveness(
  store: JobAdmissionStore,
  jobId: string
): Promise<Liveness> {
  let row: JobRow | null;
  try {
    row = await store.readJob(jobId);
  } catch (error: any) {
    if (isSubstrateMissing(error)) {
      throw error;
    }
    return {
      status: "UNKNOWN",
      live: true,
      reason: `root unreadable (${error?.name || error})`,
    };
  }

  const descendants = await store.sweepLiveDescendants(jobId);
  if (descendants.kind === "found") {
    return {
      status: row?.status || "UNKNOWN",
      live: true,
      reason: "a descendant is still non-terminal",
    };
  }
  if (descendants.kind === "unknown") {
    return {
      status: row?.status || "UNKNOWN",
      live: true,
      reason: descendants.reason,
    };
  }

  if (!row) {
    // Removed by a reset, or never written. Not proof that paid work ended.
    return {
      status: "UNKNOWN",
      live: true,
      reason: "root row absent; clear the guard by hand if this was a reset",
    };
  }
  if (!TERMINAL_STATUSES.has(row.status)) {
    return { status: row.status, live: true, reason: "root is not terminal" };
  }
  if (row.checker_schedule_failed) {
    return {
      status: row.status,
      live: true,
      reason: "the root could not schedule its checker after submitting work",
    };
  }
  if (row.status === "FAILED" && !row.process_exit_confirmed) {
    return {
      status: row.status,
      live: true,
      reason:
        "FAILED without a confirmed child-process exit; the worker may still be running",
    };
  }
  return { status: row.status, live: false, reason: "terminal and childless" };
}

function aliasIsExpired(alias: GuardRow, now: number): boolean {
  const expiry = alias.binding_expires_at;
  if (typeof expiry !== "string" || !expiry) {
    // Aliases written before the binding window existed; treat as unbounded
    // rather than silently releasing a key that may still be replayed.
    return false;
  }
  const parsed = Date.parse(expiry);
  return Number.isFinite(parsed) && parsed <= now;
}

/**
 * Validate a supplied idempotency key before anything else on every resolution
 * path. The key binds the payload, so a key reused with a different scope or a
 * different config must fail explicitly even when the target scope is occupied
 * by some other request's job.
 */
async function resolveAlias(
  store: JobAdmissionStore,
  aliasKey: string,
  scopeKey: string,
  configHash: string
): Promise<
  | { kind: "absent" }
  | { kind: "conflict"; jobId: string }
  | { kind: "bound"; jobId: string }
> {
  const alias = await store.readGuard(aliasKey);
  if (!alias) {
    return { kind: "absent" };
  }
  if (alias.scope_guard_key !== scopeKey || alias.config_hash !== configHash) {
    return { kind: "conflict", jobId: alias.job_id };
  }
  if (aliasIsExpired(alias, Date.now())) {
    await store.clearAlias(alias);
    return { kind: "absent" };
  }
  return { kind: "bound", jobId: alias.job_id };
}

function guardItemFor(
  scopeKey: string,
  scope: JobScope,
  jobId: string,
  configHash: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    guard_key: scopeKey,
    guard_kind: "scope",
    job_id: jobId,
    job_type: scope.jobType,
    conversation_id: scope.conversationId,
    report_id: scope.reportId || "",
    config_hash: configHash,
    version: 1,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

function aliasItemFor(
  aliasKey: string,
  scopeKey: string,
  scope: JobScope,
  jobId: string,
  configHash: string
): Record<string, unknown> {
  const now = Date.now();
  return {
    guard_key: aliasKey,
    guard_kind: "idempotency",
    scope_guard_key: scopeKey,
    config_hash: configHash,
    job_id: jobId,
    // Carried so a conversation's guard rows can be found without a join.
    conversation_id: scope.conversationId,
    report_id: scope.reportId || "",
    job_type: scope.jobType,
    version: 1,
    created_at: new Date(now).toISOString(),
    binding_expires_at: new Date(
      now + IDEMPOTENCY_BINDING_WINDOW_MS
    ).toISOString(),
  };
}

/**
 * Bind an accepted key to the job actually acknowledged.
 *
 * Called on every successful resolution, not only when a job was created:
 * without this, the first keyed request to be *deduplicated* returns a job id
 * with no binding, and the retry it invites starts a second run once the first
 * finishes. Returns a conflict if the key turns out to belong elsewhere.
 */
async function bindKeyToJob(
  store: JobAdmissionStore,
  aliasKey: string,
  scopeKey: string,
  scope: JobScope,
  jobId: string,
  configHash: string
): Promise<{ kind: "bound" } | { kind: "conflict"; jobId: string }> {
  const written = await store.bindAlias(
    aliasItemFor(aliasKey, scopeKey, scope, jobId, configHash)
  );
  if (written) {
    return { kind: "bound" };
  }
  const existing = await resolveAlias(store, aliasKey, scopeKey, configHash);
  if (existing.kind === "conflict") {
    return { kind: "conflict", jobId: existing.jobId };
  }
  return { kind: "bound" };
}

/**
 * Run the admission transaction, and settle an *ambiguous* failure rather than
 * reporting it.
 *
 * A transaction is all-or-nothing, but a lost HTTP acknowledgement looks the
 * same as a failure that wrote nothing. Rev3's rule is to resolve it by
 * strongly reading the guard: if the write actually landed, the caller gets the
 * job it created, in the same response shape. Only a genuinely unresolved error
 * propagates.
 */
async function admitOrResolve(
  store: JobAdmissionStore,
  request: AdmissionRequest,
  guardItem: Record<string, unknown>,
  aliasItem: Record<string, unknown> | null,
  scopeKey: string,
  aliasKey: string | null,
  configHash: string
): Promise<
  | { outcome: "admitted" }
  | { outcome: "scope_taken" }
  | { outcome: "idempotency_taken" }
  | { outcome: "job_id_taken" }
  | { outcome: "resolved"; result: AdmissionResult }
> {
  try {
    return await store.admit(request, guardItem, aliasItem);
  } catch (error: any) {
    if (isSubstrateMissing(error)) {
      throw error;
    }
    if (aliasKey) {
      const alias = await resolveAlias(store, aliasKey, scopeKey, configHash);
      if (alias.kind === "conflict") {
        return {
          outcome: "resolved",
          result: { outcome: "idempotency_conflict", jobId: alias.jobId },
        };
      }
      if (alias.kind === "bound") {
        const liveness = await assessJobLiveness(store, alias.jobId);
        return {
          outcome: "resolved",
          result: {
            outcome: "deduplicated",
            jobId: alias.jobId,
            jobStatus: liveness.status,
            workLive: liveness.live,
          },
        };
      }
    }
    const guard = await store.readGuard(scopeKey);
    if (guard) {
      const liveness = await assessJobLiveness(store, guard.job_id);
      if (liveness.live) {
        logger.warn(
          `Delphi admission for scope ${logScope(scopeKey)} failed with ${
            error?.name || "an error"
          } but the guard is present; returning ${guard.job_id}`
        );
        return {
          outcome: "resolved",
          result: {
            outcome: "deduplicated",
            jobId: guard.job_id,
            jobStatus: liveness.status,
            workLive: true,
          },
        };
      }
    }
    throw error;
  }
}

/**
 * Admit one Delphi job submission.
 *
 * Returns the existing job instead of enqueuing a duplicate whenever the scope
 * already has active work, or whenever a supplied idempotency key is still
 * bound. Throws {@link JobAdmissionUnavailableError} when the substrate cannot
 * answer safely; the caller must report unavailability and write nothing.
 *
 * **What the migration path can and cannot do.** The pre-admission sweep finds
 * work that already exists. It cannot fence a producer that writes *after* the
 * sweep and does not participate in the transaction — an older build of this
 * server during a rolling deploy is exactly that. The post-admission re-check
 * below narrows that window by compensating (deleting the row it just created,
 * while it is still unclaimed) but does not close it: if the other row appears
 * after the re-check, or a worker claims ours first, two roots exist. Deploying
 * every producer before relying on the guard is still required; this is
 * mitigation, not a cutover protocol.
 */
export async function admitDelphiJob(
  request: AdmissionRequest,
  store: JobAdmissionStore = dynamoJobAdmissionStore
): Promise<AdmissionResult> {
  const { scope } = request;
  const scopeKey = scopeGuardKey(scope);
  const configHash = configFingerprint(scope.jobConfig);
  const aliasKey = request.idempotencyKey
    ? idempotencyGuardKey(scope, request.idempotencyKey)
    : null;
  const jobItem = { ...request.jobItem };

  // Every successful resolution funnels through here so a supplied key is
  // always bound to the job the caller is actually told about.
  const settle = async (result: AdmissionResult): Promise<AdmissionResult> => {
    if (!aliasKey || result.outcome === "idempotency_conflict") {
      return result;
    }
    const bound = await bindKeyToJob(
      store,
      aliasKey,
      scopeKey,
      scope,
      result.jobId,
      configHash
    );
    if (bound.kind === "conflict") {
      return { outcome: "idempotency_conflict", jobId: bound.jobId };
    }
    return result;
  };

  try {
    for (let attempt = 0; attempt < MAX_ADMISSION_ATTEMPTS; attempt++) {
      // 1. A supplied idempotency key is authoritative about the payload,
      //    whatever the scope is doing.
      if (aliasKey) {
        const alias = await resolveAlias(store, aliasKey, scopeKey, configHash);
        if (alias.kind === "conflict") {
          return { outcome: "idempotency_conflict", jobId: alias.jobId };
        }
        if (alias.kind === "bound") {
          const liveness = await assessJobLiveness(store, alias.jobId);
          return {
            outcome: "deduplicated",
            jobId: alias.jobId,
            jobStatus: liveness.status,
            workLive: liveness.live,
          };
        }
      }

      // 2. An existing guard decides the scope.
      const guard = await store.readGuard(scopeKey);
      if (guard) {
        const liveness = await assessJobLiveness(store, guard.job_id);
        if (liveness.live) {
          logger.info(
            `Delphi job ${jobItem.job_id} deduplicated onto active job ${
              guard.job_id
            } for scope ${logScope(scopeKey)} (${liveness.reason})`
          );
          return settle({
            outcome: "deduplicated",
            jobId: guard.job_id,
            jobStatus: liveness.status,
            workLive: true,
          });
        }
        logger.info(
          `Delphi scope ${logScope(scopeKey)} released from job ${
            guard.job_id
          }: ${liveness.reason}`
        );
        await store.clearGuard(guard);
        continue;
      }

      // 3. No guard. Before creating anything, look for active work in this
      //    scope that predates the guard table, including a live checker under
      //    an already-terminal root.
      const legacy = await store.sweepUnguardedActiveRoot(scope);
      if (legacy.kind === "unknown") {
        throw new JobAdmissionUnavailableError(
          `cannot verify existing active work for scope ${logScope(
            scopeKey
          )}: ${legacy.reason}`
        );
      }
      if (legacy.kind === "found") {
        const adopted = await store.adoptGuard(
          guardItemFor(scopeKey, scope, legacy.value, configHash, {
            adopted_at: new Date().toISOString(),
          })
        );
        if (!adopted) {
          continue;
        }
        logger.info(
          `Delphi scope ${logScope(scopeKey)} adopted pre-existing active job ${
            legacy.value
          }`
        );
        const liveness = await assessJobLiveness(store, legacy.value);
        return settle({
          outcome: "deduplicated",
          jobId: legacy.value,
          jobStatus: liveness.status,
          workLive: liveness.live,
          adopted: true,
        });
      }

      // 4. Create the job and its guard in one transaction.
      const admission = await admitOrResolve(
        store,
        { ...request, jobItem },
        guardItemFor(scopeKey, scope, String(jobItem.job_id), configHash),
        aliasKey
          ? aliasItemFor(
              aliasKey,
              scopeKey,
              scope,
              String(jobItem.job_id),
              configHash
            )
          : null,
        scopeKey,
        aliasKey,
        configHash
      );

      if (admission.outcome === "resolved") {
        return settle(admission.result);
      }

      if (admission.outcome === "admitted") {
        const created: AdmissionResult = {
          outcome: "created",
          jobId: String(jobItem.job_id),
          jobStatus: String(jobItem.status || "PENDING"),
          workLive: true,
        };
        // 5. Re-check for unguarded work that appeared while we were writing.
        //    A producer outside the transaction cannot be fenced by the read in
        //    step 3; if one raced us, give up our row rather than leave two.
        const raced = await store.sweepUnguardedActiveRoot(
          scope,
          String(jobItem.job_id)
        );
        if (raced.kind === "found") {
          const withdrawn = await store.deleteUnclaimedJob(
            String(jobItem.job_id)
          );
          if (withdrawn) {
            await store.clearGuard({
              guard_key: scopeKey,
              job_id: String(jobItem.job_id),
              version: 1,
            } as GuardRow);
            logger.warn(
              `Delphi scope ${logScope(
                scopeKey
              )}: withdrew a just-created job after an unguarded producer wrote ${
                raced.value
              }; deploy every producer before relying on the guard`
            );
            continue;
          }
          logger.error(
            `Delphi scope ${logScope(scopeKey)}: an unguarded producer wrote ${
              raced.value
            } and our job was already claimed; two roots now exist for this scope`
          );
        } else if (raced.kind === "unknown") {
          logger.warn(
            `Delphi scope ${logScope(
              scopeKey
            )}: post-admission re-check inconclusive (${raced.reason})`
          );
        }
        return settle(created);
      }

      if (admission.outcome === "job_id_taken") {
        // Only reachable for the batchReports id scheme, which is derived
        // rather than random. Mint a fresh suffix and retry.
        jobItem.job_id = `${jobItem.job_id}_${randomUUID().slice(0, 8)}`;
      }
      // Every other cancellation loops back to step 1, which re-validates the
      // alias and then the guard rather than trusting the cancellation order.
    }
  } catch (error: any) {
    if (error instanceof JobAdmissionUnavailableError) {
      throw error;
    }
    if (isSubstrateMissing(error)) {
      // No un-deduplicated fallback: writing the job without a guard is how a
      // second paid provider run happens.
      throw new JobAdmissionUnavailableError(
        `Delphi job admission substrate is unavailable (${JOB_GUARD_TABLE} or ${JOB_QUEUE_TABLE} is missing)`,
        error
      );
    }
    throw error;
  }

  throw new JobAdmissionUnavailableError(
    `Delphi job admission did not settle for scope ${logScope(scopeKey)}`
  );
}
