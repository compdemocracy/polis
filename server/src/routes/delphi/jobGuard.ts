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

/**
 * How a withdrawn admission is recorded.
 *
 * The row is marked rather than deleted: an id already handed to a client has
 * to keep resolving to something real. It is marked **FAILED**, not with a
 * status of its own — a new status would be an unknown-status anomaly to the
 * P-003 S1 demand observer, which classifies COMPLETED and FAILED and treats
 * everything else as unknown and fail-closed. Every compensation would
 * manufacture one of those permanently. All the meaning lives in the fields
 * instead: `superseded_by` names the job that won, `withdrawn_reason` says why,
 * and `process_exit_confirmed` is true because nothing ever ran.
 */
export const WITHDRAWN_STATUS = "FAILED";
export const WITHDRAWN_REASON = "superseded_by_unguarded_producer";
export const JOB_GUARD_TABLE = "Delphi_JobActiveGuard";

/**
 * Statuses that mean a job row is durably finished. Everything else — PENDING,
 * PROCESSING, AWAITING_RECHECK, LOCKED_FOR_CHECKING, an unknown or a missing
 * status — is treated as still possibly holding paid work. Mirrors
 * `delphi/scripts/job_poller.py` and `803_check_batch_status.py`.
 */
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

/**
 * Does this terminal row's completion carry the worker's confirmation that the
 * job's process tree is gone?
 *
 * `process_exit_confirmed === false` is the worker saying, explicitly, that it
 * could not confirm — it can write that on a *successful* completion too, when
 * the group could not be verified. That is outstanding work whatever the
 * status, so it is treated the same way as an unconfirmed failure.
 *
 * The attribute being **absent** is a different thing: a row written before the
 * flag existed. Blocking on those would wedge every historical scope forever,
 * so the migration rule is asymmetric and deliberate — an absent flag is
 * accepted on COMPLETED (nothing about it suggests an orphan) and still
 * rejected on FAILED, where round 3 established that an unfenced failure is
 * exactly where orphans come from.
 */
function terminalWriteIsResolved(row: {
  status: string;
  process_exit_confirmed?: boolean;
}): boolean {
  if (row.process_exit_confirmed === false) {
    return false;
  }
  if (row.status === "FAILED") {
    return row.process_exit_confirmed === true;
  }
  return true;
}

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
 * How many candidate roots of one scope adoption will classify before giving
 * up. A conversation with more than this many is not a shape this code
 * understands, so it fails closed rather than picking one.
 */
const ADOPTION_CANDIDATE_LIMIT = 25;

/**
 * How recently a terminal write has to be for adoption to refuse to prune it on
 * the sweep's own word and insist on an anchored assessment instead. A sweep
 * cannot take longer than this without hitting its own page cap first, so a
 * root that finished before this window cannot have finished *during* the
 * sweep — which is the only case where a single observation misleads.
 */
const RECENTLY_TERMINAL_MS = 10 * 60 * 1000;

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
  /** Every row of one conversation, strongly read. */
  sweepConversation(conversationId: string): Promise<SweepResult<any[]>>;
  /** Write a guard row for an already-existing root; false if one appeared first. */
  adoptGuard(guardItem: Record<string, unknown>): Promise<boolean>;
  /** Write an idempotency alias; false if one appeared first. */
  bindAlias(aliasItem: Record<string, unknown>): Promise<boolean>;
  /** Delete a guard row under an exact job/version condition. */
  clearGuard(guard: GuardRow): Promise<boolean>;
  /** Delete an expired idempotency alias under an exact job condition. */
  clearAlias(alias: GuardRow): Promise<boolean>;
  /**
   * Withdraw an admission this request made after losing a race with a producer
   * outside the guard transaction: mark the queue row superseded and remove its
   * scope guard and idempotency alias, in one transaction, and only while the
   * row is still unclaimed.
   *
   * The row is marked, not deleted. Its id may already have gone out to a
   * client, and an acknowledged id has to keep resolving to something real —
   * deleting it left that client tracking nothing. Atomic because a reader
   * catching the parts separately sees a guard or an alias naming a row that
   * has moved on.
   */
  withdrawAdmission(
    jobId: string,
    scopeKey: string,
    aliasKey: string | null,
    supersededBy: string
  ): Promise<boolean>;
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
    // Every row in the conversation, then classify with the same rule the
    // guarded path uses. Filtering on status here was wrong twice over: a live
    // checker means its *root* still owns the scope even when that root is
    // COMPLETED, and a root whose terminal write is unresolved — FAILED with no
    // confirmed process exit, or `checker_schedule_failed` — is outstanding
    // work that a status filter hides. Those are precisely the old-worker and
    // operator-reset states adoption exists for.
    const sweepStartedAt = Date.now();
    const rows = await this.sweepConversation(scope.conversationId);
    if (rows.kind !== "found") {
      return rows;
    }

    const wantReport = scope.reportId || "";
    const inScope = (row: any) =>
      row &&
      row.job_type === scope.jobType &&
      (row.report_id || "") === wantReport;

    // Candidate roots of this scope, plus the roots of any live checker.
    const candidates: string[] = [];
    const consider = (jobId: string) => {
      if (jobId !== exceptJobId && !candidates.includes(jobId)) {
        candidates.push(jobId);
      }
    };

    // Pruning on the sweep's own observation is only safe for rows that were
    // *already* finished before the sweep began. A multi-page scan is not a
    // snapshot: a root that goes terminal while the sweep runs, after a page
    // has passed the position where its child is being written, looks settled
    // and is not. So a row is pruned cheaply only when its terminal write is
    // demonstrably older than this sweep; anything terminal-but-recent, or
    // terminal with no timestamp to judge by, becomes a candidate and is
    // decided by the anchored assessment below.
    const settledBefore = sweepStartedAt - RECENTLY_TERMINAL_MS;
    const settledByScan = (row: any) => {
      if (
        !TERMINAL_STATUSES.has(row.status) ||
        row.checker_schedule_failed ||
        !terminalWriteIsResolved(row)
      ) {
        return false;
      }
      const finishedAt = Date.parse(row.completed_at || row.updated_at || "");
      return Number.isFinite(finishedAt) && finishedAt < settledBefore;
    };

    for (const row of rows.value) {
      const jobId = String(row.job_id);
      const parentId = row.batch_job_id ? String(row.batch_job_id) : null;
      if (!parentId) {
        if (inScope(row) && !settledByScan(row)) {
          consider(jobId);
        }
        continue;
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        continue; // a finished checker says nothing about its root
      }
      if (jobId === exceptJobId || parentId === exceptJobId) {
        continue;
      }
      // A live checker: its root owns the scope. Read the root to classify it.
      const parent = await this.readJob(parentId);
      if (!parent) {
        // Live child, unreadable lineage. We cannot tell whose scope this
        // occupies, and guessing either way risks a second paid run.
        return {
          kind: "unknown",
          reason: `live descendant ${jobId} has no readable root`,
        };
      }
      if (inScope(parent)) {
        consider(parentId);
      }
    }

    if (!candidates.length) {
      return { kind: "none" };
    }
    if (candidates.length > ADOPTION_CANDIDATE_LIMIT) {
      return {
        kind: "unknown",
        reason: `${candidates.length} candidate roots in scope; too many to classify`,
      };
    }
    for (const candidate of candidates) {
      const liveness = await assessJobLiveness(this, candidate);
      if (liveness.live) {
        return { kind: "found", value: candidate };
      }
    }
    return { kind: "none" };
  },

  async sweepConversation(conversationId) {
    return baseTableSweep(
      "conversation_id = :cid",
      { ":cid": conversationId },
      "conversation liveness"
    );
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

  async withdrawAdmission(jobId, scopeKey, aliasKey, supersededBy) {
    const now = new Date().toISOString();
    const items: any[] = [
      {
        Update: {
          TableName: JOB_QUEUE_TABLE,
          Key: { job_id: jobId },
          UpdateExpression:
            "SET #s = :superseded, superseded_by = :winner, withdrawn_reason = :reason, updated_at = :now, completed_at = :now, process_exit_confirmed = :confirmed",
          // Only while no worker has taken it: `job_poller.py:claim_job` moves
          // status to PROCESSING and stamps worker_id.
          ConditionExpression: "#s = :pending AND #w = :unclaimed",
          ExpressionAttributeNames: { "#s": "status", "#w": "worker_id" },
          ExpressionAttributeValues: {
            ":superseded": WITHDRAWN_STATUS,
            ":reason": WITHDRAWN_REASON,
            ":winner": supersededBy,
            ":now": now,
            // Nothing ever ran, so there is no process to be uncertain about.
            ":confirmed": true,
            ":pending": "PENDING",
            ":unclaimed": "none",
          },
        },
      },
      {
        Delete: {
          TableName: JOB_GUARD_TABLE,
          Key: { guard_key: scopeKey },
          ConditionExpression: "job_id = :jid",
          ExpressionAttributeValues: { ":jid": jobId },
        },
      },
    ];
    if (aliasKey) {
      items.push({
        Delete: {
          TableName: JOB_GUARD_TABLE,
          Key: { guard_key: aliasKey },
          ConditionExpression: "job_id = :jid",
          ExpressionAttributeValues: { ":jid": jobId },
        },
      });
    }
    try {
      await docClient.transactWrite({ TransactItems: items });
      return true;
    } catch (error: any) {
      if (error?.name === "TransactionCanceledException") {
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

  // The sweep below is a multi-page read, and DynamoDB is explicit that a
  // strongly-consistent Scan is not a snapshot: a child written between pages,
  // at a position page one has already gone past, is invisible to it. The
  // anchor is what makes the sweep's silence mean something — the writer only
  // creates children while the root is non-terminal, so if the root was
  // *already* terminal before the first page, no child can appear after it.
  // A root that goes terminal during the sweep is uncertain this round.
  const anchor = row ? rowAnchor(row) : null;
  const rootWasTerminalBeforeSweep = Boolean(
    row && TERMINAL_STATUSES.has(row.status)
  );

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
  if (!rootWasTerminalBeforeSweep) {
    return {
      status: row.status,
      live: true,
      reason: "root became terminal during the descendant sweep",
    };
  }
  // Two agreeing reads: the root must not have moved while the sweep ran.
  let after: JobRow | null;
  try {
    after = await store.readJob(jobId);
  } catch {
    after = null;
  }
  if (!after || rowAnchor(after) !== anchor) {
    return {
      status: row.status,
      live: true,
      reason: "the root changed while its descendants were being swept",
    };
  }
  if (row.checker_schedule_failed) {
    return {
      status: row.status,
      live: true,
      reason: "the root could not schedule its checker after submitting work",
    };
  }
  if (!terminalWriteIsResolved(row)) {
    return {
      status: row.status,
      live: true,
      reason:
        "terminal without a confirmed process-tree exit; the worker may still be running",
    };
  }
  return { status: row.status, live: false, reason: "terminal and childless" };
}

/**
 * Strongly-read effective-work state for every job in one conversation.
 *
 * The visualizations reader needs this because its own view comes from
 * `ConversationIndex`, and a global secondary index that has not caught up with
 * a newly written checker row would report its parent as finished — which the
 * client would then act on by stopping its polling. One consistent base-table
 * scan of the conversation answers for every job at once, from the same
 * evidence {@link assessJobLiveness} uses.
 *
 * `complete: false` means the sweep could not be finished, in which case every
 * answer is `true`: uncertainty is live work.
 */
export async function assessConversationLiveness(
  conversationId: string,
  store: JobAdmissionStore = dynamoJobAdmissionStore
): Promise<{
  complete: boolean;
  liveByJobId: Map<string, boolean>;
  /** Rows as the first sweep read them, for callers needing more than liveness. */
  rowsByJobId: Map<string, any>;
}> {
  const liveByJobId = new Map<string, boolean>();
  let rowsByJobId = new Map<string, any>();

  const sweep = async () => {
    const rows = await store.sweepConversation(conversationId);
    if (rows.kind === "unknown") {
      return {
        ok: false as const,
        reason: rows.reason,
        live: new Map<string, boolean>(),
        anchors: new Map<string, string>(),
        rows: new Map<string, any>(),
      };
    }
    const all = rows.kind === "found" ? rows.value : [];
    const liveChildParents = new Set<string>();
    for (const row of all) {
      if (row.batch_job_id && !TERMINAL_STATUSES.has(row.status)) {
        liveChildParents.add(String(row.batch_job_id));
      }
    }
    const live = new Map<string, boolean>();
    const anchors = new Map<string, string>();
    for (const row of all) {
      const jobId = String(row.job_id);
      live.set(
        jobId,
        liveChildParents.has(jobId) ||
          !TERMINAL_STATUSES.has(row.status) ||
          Boolean(row.checker_schedule_failed) ||
          !terminalWriteIsResolved(row)
      );
      anchors.set(jobId, rowAnchor(row));
    }
    return { ok: true as const, reason: "", live, anchors };
  };

  const first = await sweep();
  if (!first.ok) {
    logger.warn(
      `Delphi conversation liveness incomplete: ${first.reason}; reporting live`
    );
    return { complete: false, liveByJobId, rowsByJobId };
  }
  rowsByJobId = first.rows;
  if (![...first.live.values()].some((live) => !live)) {
    // Nothing is about to be reported finished, so there is nothing a second
    // read could make safer.
    return { complete: true, liveByJobId: first.live, rowsByJobId };
  }

  // A multi-page strong scan is not a snapshot: a child written between pages,
  // past the point page one already read, is invisible. Only a "not live"
  // answer can do harm — a client stops polling on it — so confirm those with a
  // second sweep and report live wherever the two disagree or a row moved.
  const second = await sweep();
  if (!second.ok) {
    logger.warn(
      `Delphi conversation liveness could not be confirmed: ${second.reason}; reporting live`
    );
    return { complete: false, liveByJobId, rowsByJobId };
  }
  for (const [jobId, live] of second.live) {
    const agreed =
      first.live.get(jobId) === live &&
      first.anchors.get(jobId) === second.anchors.get(jobId);
    liveByJobId.set(jobId, agreed ? live : true);
  }
  for (const jobId of first.live.keys()) {
    if (!liveByJobId.has(jobId)) {
      // Present in the first sweep and gone from the second: uncertain.
      liveByJobId.set(jobId, true);
    }
  }
  return { complete: true, liveByJobId, rowsByJobId };
}

/**
 * A cheap fingerprint of everything about a row that would change the answer.
 * Two reads that produce the same anchor were not separated by a write.
 */
function rowAnchor(row: any): string {
  return JSON.stringify([
    row.status,
    row.version ?? null,
    row.updated_at ?? null,
    row.completed_at ?? null,
    row.process_exit_confirmed ?? null,
    row.checker_schedule_failed ?? null,
  ]);
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
): Promise<
  | { kind: "bound"; jobId: string }
  | { kind: "conflict"; jobId: string }
  | { kind: "retry" }
> {
  const written = await store.bindAlias(
    aliasItemFor(aliasKey, scopeKey, scope, jobId, configHash)
  );
  if (written) {
    return { kind: "bound", jobId };
  }
  // Someone else bound this key first. Which job did *they* record? Assuming it
  // was ours would hand back a job id whose retry resolves a different one, and
  // the same key must always name the same job.
  const existing = await resolveAlias(store, aliasKey, scopeKey, configHash);
  if (existing.kind === "conflict") {
    return { kind: "conflict", jobId: existing.jobId };
  }
  if (existing.kind === "absent") {
    // Cleared between the failed put and the read: nothing is bound, so re-run
    // rather than acknowledging an unbound key.
    return { kind: "retry" };
  }
  return { kind: "bound", jobId: existing.jobId };
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

  /**
   * Commit an acknowledgement.
   *
   * Two things must hold before a job id goes back to the caller, and neither
   * was checked before: a supplied key must be bound to *that* job — and if
   * someone else bound the key first, theirs is the answer, or the same key
   * would name two jobs — and the job must still exist. Compensation and
   * concurrent binding can both leave a result naming a row that has been
   * deleted or superseded. Returns null for "start the cycle again"; the caller
   * must not acknowledge anything.
   */
  const settle = async (
    result: AdmissionResult
  ): Promise<AdmissionResult | null> => {
    if (result.outcome === "idempotency_conflict") {
      return result;
    }

    let acknowledged: AdmissionResult = result;
    if (aliasKey) {
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
      if (bound.kind === "retry") {
        return null;
      }
      if (bound.jobId !== result.jobId) {
        logger.warn(
          `Delphi scope ${logScope(
            scopeKey
          )}: idempotency key was already bound to ${
            bound.jobId
          }; acknowledging that job instead of ${result.jobId}`
        );
        acknowledged = {
          outcome: "deduplicated",
          jobId: bound.jobId,
          jobStatus: "UNKNOWN",
          workLive: true,
        };
      }
    }

    if (acknowledged.outcome === "created") {
      // Its queue row and guard went in together, in one transaction, and the
      // compensating path never reaches here.
      return acknowledged;
    }

    // Re-read what backs this id before naming it. Compensation and concurrent
    // binding can both leave a result pointing at a row that has been withdrawn
    // or a scope that has moved on; either way the honest move is to resolve
    // again rather than hand out an id nothing stands behind.
    const guardNow = await store.readGuard(scopeKey);
    if (guardNow) {
      if (guardNow.job_id !== acknowledged.jobId) {
        logger.warn(
          `Delphi scope ${logScope(scopeKey)}: guard now names ${
            guardNow.job_id
          }, not ${acknowledged.jobId}; re-resolving`
        );
        return null;
      }
      // The guard is still held, so by construction this scope is not finished
      // — whatever a fresh assessment says a moment later. Telling the caller
      // "not live" here while refusing to release the scope would be two
      // different answers to the same question, and the client stops polling on
      // the first one.
      const held = await assessJobLiveness(store, acknowledged.jobId);
      return { ...acknowledged, jobStatus: held.status, workLive: true };
    } else if (!(await store.readJob(acknowledged.jobId))) {
      logger.warn(
        `Delphi scope ${logScope(scopeKey)}: job ${
          acknowledged.jobId
        } is unguarded and gone; re-resolving`
      );
      return null;
    }

    const liveness = await assessJobLiveness(store, acknowledged.jobId);
    return {
      ...acknowledged,
      jobStatus: liveness.status,
      workLive: liveness.live,
    };
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
          // The alias is only an answer while the job it names still exists.
          // Compensation withdraws a job, its guard and its alias in three
          // writes, and a request arriving between them would otherwise be
          // handed the id of a row that has just been deleted.
          if (!(await store.readJob(alias.jobId))) {
            logger.warn(
              `Delphi scope ${logScope(scopeKey)}: idempotency key names ${
                alias.jobId
              }, which no longer exists; re-resolving`
            );
            await store.clearAlias({
              guard_key: aliasKey,
              job_id: alias.jobId,
            } as GuardRow);
            continue;
          }
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
          const settled = await settle({
            outcome: "deduplicated",
            jobId: guard.job_id,
            jobStatus: liveness.status,
            workLive: true,
          });
          if (settled) {
            return settled;
          }
          continue;
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
        const settled = await settle({
          outcome: "deduplicated",
          jobId: legacy.value,
          jobStatus: liveness.status,
          workLive: liveness.live,
          adopted: true,
        });
        if (settled) {
          return settled;
        }
        continue;
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
        const settled = await settle(admission.result);
        if (settled) {
          return settled;
        }
        continue;
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
          // One transaction, and it comes first: the row is marked superseded
          // while its guard and alias are removed, so there is no ordering in
          // which a reader can acknowledge this job and then find it gone. An
          // acknowledgement that slipped through just before this still names a
          // real, terminal, not-live row.
          const withdrawn = await store.withdrawAdmission(
            String(jobItem.job_id),
            scopeKey,
            aliasKey,
            raced.value
          );
          if (withdrawn) {
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
        const settled = await settle(created);
        if (settled) {
          return settled;
        }
        continue;
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
