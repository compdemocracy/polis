/**
 * The backend-neutral Delphi Storage V2 repository interface — TypeScript
 * twin of delphi/delphi_storage/interface.py.
 *
 * Method names are camelCase, but DATA FIELD NAMES ARE snake_case: manifests
 * and pointers are shared wire objects, written by the Python pipeline and
 * read here (and vice versa). Design: delphi/docs/STORAGE_V2_DESIGN.md
 * (§4.2 entities, §4.3 interface); normative conformance spec in
 * delphi/delphi_storage/conformance/README.md.
 */
import { canonicalJsonDumps } from "./codec";
import { AlreadyExistsError, InvalidError, NotFoundError, StorageError } from "./errors";
import {
  CHUNK_MARKER,
  GENERIC_ENTITIES,
  logSk,
  nowTs,
  scopesForRun,
  validateTs,
} from "./keys";

export { AlreadyExistsError, InvalidError, NotFoundError, StorageError };

export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type JobType = "FULL_PIPELINE" | "NARRATIVE_BATCH" | "SERVER_NARRATIVE" | "IMPORTED";

export const RUN_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"];
export const JOB_TYPES: readonly JobType[] = [
  "FULL_PIPELINE",
  "NARRATIVE_BATCH",
  "SERVER_NARRATIVE",
  "IMPORTED",
];
export const TERMINAL_STATUSES: readonly RunStatus[] = ["COMPLETED", "FAILED"];

/** One logical item in a generic entity: JSON attributes + optional blob. */
export interface StoreItem {
  pk: string;
  sk: string;
  attributes: Record<string, unknown>;
  blob: Buffer | null;
}

/**
 * Queue row and run manifest in one — the row becomes the manifest as the
 * job executes (design §4.2 entity 1).
 */
export interface RunManifest {
  job_id: string;
  job_type: JobType;
  enqueued_at: string;
  status: RunStatus;
  zid: number | null;
  rid: number | null;
  priority: number;
  version: number;
  worker_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  lease_expires_at: string | null;
  error: string | null;
  replay_of: string | null;
  provenance: string;
  replayable: boolean;
  imported_scope_type: string | null;
  math_tick_legacy: number | null;
  log_seq: number;
  config_requested: Record<string, unknown>;
  config_effective: Record<string, unknown>;
  code_version: Record<string, unknown>;
  seeds: Record<string, unknown>;
  input_fingerprints: Record<string, unknown>;
  stage_status: Record<string, unknown>;
}

/** First-class 'latest successful run' pointer (design §4.2 entity 4). */
export interface LatestPointer {
  scope: string;
  job_id: string;
  seq: number;
  job_type: JobType;
  updated_at: string;
}

export interface AdvanceResult {
  advanced: boolean;
  pointer: LatestPointer;
}

const OPTIONAL_TS_FIELDS = ["started_at", "completed_at", "lease_expires_at"] as const;
const DICT_FIELDS = [
  "config_requested",
  "config_effective",
  "code_version",
  "seeds",
  "input_fingerprints",
  "stage_status",
] as const;

export const MERGEABLE_DICT_FIELDS: readonly string[] = DICT_FIELDS;
export const MERGEABLE_SCALAR_FIELDS: readonly string[] = [
  "math_tick_legacy",
  "replay_of",
  "provenance",
  "replayable",
  "imported_scope_type",
];

/**
 * Apply defaults and validate — the equivalent of constructing the Python
 * Pydantic RunManifest. Throws InvalidError on contract violations.
 */
export function normalizeRunManifest(input: Record<string, unknown>): RunManifest {
  const jobId = input.job_id;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new InvalidError("job_id must be a non-empty string");
  }
  const jobType = input.job_type as JobType;
  if (!JOB_TYPES.includes(jobType)) {
    throw new InvalidError(`unknown job_type ${JSON.stringify(input.job_type)}`);
  }
  const status = (input.status ?? "QUEUED") as RunStatus;
  if (!RUN_STATUSES.includes(status)) {
    throw new InvalidError(`unknown status ${JSON.stringify(input.status)}`);
  }
  validateTs(input.enqueued_at as string);
  for (const field of OPTIONAL_TS_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== null) validateTs(value as string);
  }
  const manifest: RunManifest = {
    job_id: jobId,
    job_type: jobType,
    enqueued_at: input.enqueued_at as string,
    status,
    zid: (input.zid as number | null | undefined) ?? null,
    rid: (input.rid as number | null | undefined) ?? null,
    priority: (input.priority as number | undefined) ?? 0,
    version: (input.version as number | undefined) ?? 0,
    worker_id: (input.worker_id as string | null | undefined) ?? null,
    started_at: (input.started_at as string | null | undefined) ?? null,
    completed_at: (input.completed_at as string | null | undefined) ?? null,
    lease_expires_at: (input.lease_expires_at as string | null | undefined) ?? null,
    error: (input.error as string | null | undefined) ?? null,
    replay_of: (input.replay_of as string | null | undefined) ?? null,
    provenance: (input.provenance as string | undefined) ?? "pipeline",
    replayable: (input.replayable as boolean | undefined) ?? true,
    imported_scope_type: (input.imported_scope_type as string | null | undefined) ?? null,
    math_tick_legacy: (input.math_tick_legacy as number | null | undefined) ?? null,
    log_seq: (input.log_seq as number | undefined) ?? 0,
    config_requested: (input.config_requested as Record<string, unknown> | undefined) ?? {},
    config_effective: (input.config_effective as Record<string, unknown> | undefined) ?? {},
    code_version: (input.code_version as Record<string, unknown> | undefined) ?? {},
    seeds: (input.seeds as Record<string, unknown> | undefined) ?? {},
    input_fingerprints: (input.input_fingerprints as Record<string, unknown> | undefined) ?? {},
    stage_status: (input.stage_status as Record<string, unknown> | undefined) ?? {},
  };
  return manifest;
}

/** Shared shallow-merge semantics for merge_run_fields (mirrors memory.py). */
export function mergeManifestFields(
  run: RunManifest,
  fields: Record<string, unknown>
): RunManifest {
  const merged: RunManifest = { ...run };
  for (const [key, value] of Object.entries(fields)) {
    if ((MERGEABLE_DICT_FIELDS as string[]).includes(key)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new InvalidError(`field ${JSON.stringify(key)} must be a dict`);
      }
      (merged as unknown as Record<string, unknown>)[key] = {
        ...(run as unknown as Record<string, unknown>)[key] as Record<string, unknown>,
        ...(value as Record<string, unknown>),
      };
    } else if ((MERGEABLE_SCALAR_FIELDS as string[]).includes(key)) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    } else {
      throw new InvalidError(`field ${JSON.stringify(key)} is not mergeable`);
    }
  }
  return merged;
}

/** Contract checks shared by every backend's generic write path. */
export function validateGenericWrite(entity: string, item: StoreItem): void {
  if (!(GENERIC_ENTITIES as readonly string[]).includes(entity)) {
    throw new InvalidError(
      `entity ${JSON.stringify(entity)} is not writable through generic ops ` +
        `(allowed: ${GENERIC_ENTITIES.join(", ")})`
    );
  }
  if (!item.pk) throw new InvalidError("pk must be non-empty");
  if (!item.sk) throw new InvalidError("sk must be non-empty");
  if (item.sk.includes(CHUNK_MARKER) || item.pk.includes(CHUNK_MARKER)) {
    throw new InvalidError("keys must not contain U+007F (reserved chunk marker)");
  }
  for (const key of Object.keys(item.attributes)) {
    if (key.startsWith("_")) {
      throw new InvalidError(
        `attribute ${JSON.stringify(key)}: top-level '_' prefix is reserved for backends`
      );
    }
  }
  canonicalJsonDumps(item.attributes); // throws InvalidError on NaN etc.
}

export function validateGenericRead(entity: string): void {
  if (!(GENERIC_ENTITIES as readonly string[]).includes(entity)) {
    throw new InvalidError(`entity ${JSON.stringify(entity)} is not readable through generic ops`);
  }
}

/**
 * Backends validate every externally supplied status — a typo'd status
 * silently persisted would make a run permanently unclaimable. Twin of
 * Python's RunStatus(status) coercion.
 */
export function coerceRunStatus(status: RunStatus | string): RunStatus {
  if (!RUN_STATUSES.includes(status as RunStatus)) {
    throw new InvalidError(`unknown status ${JSON.stringify(status)}`);
  }
  return status as RunStatus;
}

export function coerceJobType(jobType: JobType | string): JobType {
  if (!JOB_TYPES.includes(jobType as JobType)) {
    throw new InvalidError(`unknown job_type ${JSON.stringify(jobType)}`);
  }
  return jobType as JobType;
}

/**
 * Contract checks shared by every backend's enqueueRun: status must be QUEUED
 * and the job_type↔zid/rid coupling must already be satisfiable, so a run can
 * never reach COMPLETED and then fail to derive its latest scopes (that would
 * leave it stuck: completed but never published).
 */
export function validateEnqueueable(run: RunManifest): void {
  if (run.status !== "QUEUED") {
    throw new InvalidError(`enqueued runs must be QUEUED, got ${run.status}`);
  }
  scopesForRun(run); // throws InvalidError on an unsatisfiable coupling
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  now?: string;
}

export interface ExtendLeaseOptions {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
  now?: string;
}

export interface AdvanceLatestOptions {
  scope: string;
  jobId: string;
  jobType: JobType | string;
  onlyIfAbsentOrImported?: boolean;
  now?: string;
}

export interface ListRunsOptions {
  zid?: number | null;
  rid?: number | null;
  status?: RunStatus | string | null;
  limit?: number;
}

/**
 * Neutral repository over runs / run_inputs / artifacts / latest /
 * topic_moderation / collective_statements (design §4.2-4.3).
 */
export interface DelphiStore {
  put(entity: string, item: StoreItem): Promise<void>;
  putBatch(entity: string, items: StoreItem[]): Promise<void>;
  get(entity: string, pk: string, sk: string): Promise<StoreItem | null>;
  queryPrefix(entity: string, pk: string, skPrefix?: string): Promise<StoreItem[]>;
  queryBetween(entity: string, pk: string, skFrom: string, skTo: string): Promise<StoreItem[]>;
  deletePartition(entity: string, pk: string): Promise<number>;

  enqueueRun(run: RunManifest): Promise<void>;
  getRun(jobId: string): Promise<RunManifest | null>;
  claimNextRun(options: ClaimOptions): Promise<RunManifest | null>;
  extendLease(options: ExtendLeaseOptions): Promise<boolean>;
  updateRunStatus(
    jobId: string,
    status: RunStatus | string,
    options?: { error?: string | null; now?: string }
  ): Promise<RunManifest>;
  mergeRunFields(jobId: string, fields: Record<string, unknown>): Promise<RunManifest>;
  completeRun(jobId: string, now?: string): Promise<RunManifest>;
  appendLog(jobId: string, message: string, now?: string): Promise<number>;
  advanceLatest(options: AdvanceLatestOptions): Promise<AdvanceResult>;
  getLatest(scope: string): Promise<LatestPointer | null>;
  listRuns(options: ListRunsOptions): Promise<RunManifest[]>;
}

/**
 * Shared semantics implemented once for all backends (twin of the concrete
 * methods on the Python ABC).
 */
export abstract class BaseDelphiStore implements DelphiStore {
  abstract put(entity: string, item: StoreItem): Promise<void>;
  abstract get(entity: string, pk: string, sk: string): Promise<StoreItem | null>;
  abstract queryPrefix(entity: string, pk: string, skPrefix?: string): Promise<StoreItem[]>;
  abstract queryBetween(
    entity: string,
    pk: string,
    skFrom: string,
    skTo: string
  ): Promise<StoreItem[]>;
  abstract deletePartition(entity: string, pk: string): Promise<number>;
  abstract enqueueRun(run: RunManifest): Promise<void>;
  abstract getRun(jobId: string): Promise<RunManifest | null>;
  abstract claimNextRun(options: ClaimOptions): Promise<RunManifest | null>;
  abstract extendLease(options: ExtendLeaseOptions): Promise<boolean>;
  abstract updateRunStatus(
    jobId: string,
    status: RunStatus | string,
    options?: { error?: string | null; now?: string }
  ): Promise<RunManifest>;
  abstract mergeRunFields(jobId: string, fields: Record<string, unknown>): Promise<RunManifest>;
  abstract advanceLatest(options: AdvanceLatestOptions): Promise<AdvanceResult>;
  abstract getLatest(scope: string): Promise<LatestPointer | null>;
  abstract listRuns(options: ListRunsOptions): Promise<RunManifest[]>;

  protected abstract incrementLogSeq(jobId: string): Promise<number>;

  async putBatch(entity: string, items: StoreItem[]): Promise<void> {
    for (const item of items) {
      await this.put(entity, item);
    }
  }

  /**
   * Mark COMPLETED then advance latest for the run's scopes — the pointer is
   * the commit point, written last (design §4.2). Idempotent and
   * crash-healing. Throws InvalidError on FAILED runs.
   */
  async completeRun(jobId: string, now?: string): Promise<RunManifest> {
    const at = now !== undefined ? validateTs(now) : nowTs();
    let run = await this.getRun(jobId);
    if (run === null) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
    if (run.status === "FAILED") {
      throw new InvalidError(`run ${JSON.stringify(jobId)} is FAILED and cannot be completed`);
    }
    // Derive scopes BEFORE flipping the status: a run that cannot publish
    // must fail cleanly, not end up COMPLETED-but-unpublished.
    const scopes = scopesForRun(run);
    if (run.status !== "COMPLETED") {
      run = await this.updateRunStatus(jobId, "COMPLETED", { now: at });
    }
    for (const scope of scopes) {
      await this.advanceLatest({ scope, jobId: run.job_id, jobType: run.job_type, now: at });
    }
    return run;
  }

  /**
   * Append-only run log as artifacts items (replaces the old truncate-to-50
   * job log). Returns the 1-based seq.
   */
  async appendLog(jobId: string, message: string, now?: string): Promise<number> {
    const at = now !== undefined ? validateTs(now) : nowTs();
    const seq = await this.incrementLogSeq(jobId);
    await this.put("artifacts", {
      pk: jobId,
      sk: logSk(seq),
      attributes: { ts: at, message },
      blob: null,
    });
    return seq;
  }
}
