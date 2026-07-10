/**
 * In-memory reference implementation — twin of
 * delphi/delphi_storage/backends/memory.py. All operations are internally
 * synchronous (no awaits between read and write), so concurrent async
 * callers cannot interleave inside an operation.
 */
import {
  AdvanceLatestOptions,
  AdvanceResult,
  AlreadyExistsError,
  BaseDelphiStore,
  ClaimOptions,
  ExtendLeaseOptions,
  InvalidError,
  LatestPointer,
  ListRunsOptions,
  NotFoundError,
  RunManifest,
  RunStatus,
  StoreItem,
  TERMINAL_STATUSES,
  coerceJobType,
  coerceRunStatus,
  mergeManifestFields,
  validateEnqueueable,
  validateGenericRead,
  validateGenericWrite,
} from "./interface";
import { claimOrder, nowTs, tsAddSeconds, utf8Compare, validateTs } from "./keys";

interface StoredValue {
  attributes: Record<string, unknown>;
  blob: Buffer | null;
}

function cloneAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(attributes));
}

function cloneRun(run: RunManifest): RunManifest {
  return JSON.parse(JSON.stringify(run));
}

export class MemoryDelphiStore extends BaseDelphiStore {
  private kv = new Map<string, Map<string, Map<string, StoredValue>>>();
  private runs = new Map<string, RunManifest>();
  private latest = new Map<string, LatestPointer>();

  async put(entity: string, item: StoreItem): Promise<void> {
    validateGenericWrite(entity, item);
    let partitions = this.kv.get(entity);
    if (!partitions) {
      partitions = new Map();
      this.kv.set(entity, partitions);
    }
    let partition = partitions.get(item.pk);
    if (!partition) {
      partition = new Map();
      partitions.set(item.pk, partition);
    }
    partition.set(item.sk, {
      attributes: cloneAttributes(item.attributes),
      blob: item.blob === null ? null : Buffer.from(item.blob),
    });
  }

  async get(entity: string, pk: string, sk: string): Promise<StoreItem | null> {
    validateGenericRead(entity);
    const stored = this.kv.get(entity)?.get(pk)?.get(sk);
    if (!stored) return null;
    return {
      pk,
      sk,
      attributes: cloneAttributes(stored.attributes),
      blob: stored.blob === null ? null : Buffer.from(stored.blob),
    };
  }

  private partitionItems(entity: string, pk: string): Map<string, StoredValue> {
    return this.kv.get(entity)?.get(pk) ?? new Map();
  }

  async queryPrefix(entity: string, pk: string, skPrefix = ""): Promise<StoreItem[]> {
    validateGenericRead(entity);
    const partition = this.partitionItems(entity, pk);
    const sks = Array.from(partition.keys())
      .filter((sk) => sk.startsWith(skPrefix))
      .sort(utf8Compare);
    return sks.map((sk) => {
      const stored = partition.get(sk)!;
      return {
        pk,
        sk,
        attributes: cloneAttributes(stored.attributes),
        blob: stored.blob === null ? null : Buffer.from(stored.blob),
      };
    });
  }

  async queryBetween(
    entity: string,
    pk: string,
    skFrom: string,
    skTo: string
  ): Promise<StoreItem[]> {
    validateGenericRead(entity);
    const partition = this.partitionItems(entity, pk);
    const sks = Array.from(partition.keys())
      .filter((sk) => utf8Compare(sk, skFrom) >= 0 && utf8Compare(sk, skTo) <= 0)
      .sort(utf8Compare);
    return sks.map((sk) => {
      const stored = partition.get(sk)!;
      return {
        pk,
        sk,
        attributes: cloneAttributes(stored.attributes),
        blob: stored.blob === null ? null : Buffer.from(stored.blob),
      };
    });
  }

  async deletePartition(entity: string, pk: string): Promise<number> {
    validateGenericRead(entity);
    const partitions = this.kv.get(entity);
    const partition = partitions?.get(pk);
    if (!partition) return 0;
    partitions!.delete(pk);
    return partition.size;
  }

  async enqueueRun(run: RunManifest): Promise<void> {
    validateEnqueueable(run);
    if (this.runs.has(run.job_id)) {
      throw new AlreadyExistsError(`run ${JSON.stringify(run.job_id)} already exists`);
    }
    this.runs.set(run.job_id, cloneRun(run));
  }

  async getRun(jobId: string): Promise<RunManifest | null> {
    const run = this.runs.get(jobId);
    return run ? cloneRun(run) : null;
  }

  async claimNextRun(options: ClaimOptions): Promise<RunManifest | null> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    const queued = Array.from(this.runs.values()).filter((r) => r.status === "QUEUED");
    if (queued.length === 0) return null;
    queued.sort((a, b) =>
      utf8Compare(
        claimOrder(a.priority, a.enqueued_at, a.job_id),
        claimOrder(b.priority, b.enqueued_at, b.job_id)
      )
    );
    const run = queued[0];
    const claimed: RunManifest = {
      ...cloneRun(run),
      status: "RUNNING",
      worker_id: options.workerId,
      started_at: at,
      lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
      version: run.version + 1,
    };
    this.runs.set(run.job_id, claimed);
    return cloneRun(claimed);
  }

  async extendLease(options: ExtendLeaseOptions): Promise<boolean> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    const run = this.runs.get(options.jobId);
    if (!run || run.status !== "RUNNING" || run.worker_id !== options.workerId) {
      return false;
    }
    this.runs.set(options.jobId, {
      ...run,
      lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
      version: run.version + 1,
    });
    return true;
  }

  async updateRunStatus(
    jobId: string,
    status: RunStatus | string,
    options: { error?: string | null; now?: string } = {}
  ): Promise<RunManifest> {
    status = coerceRunStatus(status);
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    const run = this.runs.get(jobId);
    if (!run) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
    const updated: RunManifest = { ...cloneRun(run), status: status as RunStatus, version: run.version + 1 };
    if (options.error !== undefined && options.error !== null) updated.error = options.error;
    if ((TERMINAL_STATUSES as string[]).includes(status as string) && run.completed_at === null) {
      updated.completed_at = at;
    }
    this.runs.set(jobId, updated);
    return cloneRun(updated);
  }

  async mergeRunFields(jobId: string, fields: Record<string, unknown>): Promise<RunManifest> {
    const run = this.runs.get(jobId);
    if (!run) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
    const merged: RunManifest = { ...mergeManifestFields(run, fields), version: run.version + 1 };
    this.runs.set(jobId, merged);
    return cloneRun(merged);
  }

  async advanceLatest(options: AdvanceLatestOptions): Promise<AdvanceResult> {
    const jobType = coerceJobType(options.jobType);
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    const current = this.latest.get(options.scope);
    if (current) {
      if (current.job_id === options.jobId) {
        return { advanced: false, pointer: { ...current } };
      }
      if (options.onlyIfAbsentOrImported && current.job_type !== "IMPORTED") {
        return { advanced: false, pointer: { ...current } };
      }
    }
    const pointer: LatestPointer = {
      scope: options.scope,
      job_id: options.jobId,
      seq: current ? current.seq + 1 : 1,
      job_type: jobType,
      updated_at: at,
    };
    this.latest.set(options.scope, pointer);
    return { advanced: true, pointer: { ...pointer } };
  }

  async getLatest(scope: string): Promise<LatestPointer | null> {
    const pointer = this.latest.get(scope);
    return pointer ? { ...pointer } : null;
  }

  async listRuns(options: ListRunsOptions): Promise<RunManifest[]> {
    const hasZid = options.zid !== undefined && options.zid !== null;
    const hasRid = options.rid !== undefined && options.rid !== null;
    if (hasZid === hasRid) {
      throw new InvalidError("exactly one of zid/rid is required");
    }
    const statusFilter =
      options.status !== undefined && options.status !== null
        ? coerceRunStatus(options.status)
        : null;
    let runs = Array.from(this.runs.values()).filter((r) =>
      hasZid ? r.zid === options.zid : r.rid === options.rid
    );
    if (statusFilter !== null) {
      runs = runs.filter((r) => r.status === statusFilter);
    }
    runs.sort((a, b) => {
      const byTime = utf8Compare(b.enqueued_at, a.enqueued_at);
      return byTime !== 0 ? byTime : utf8Compare(b.job_id, a.job_id);
    });
    return runs.slice(0, options.limit ?? 100).map(cloneRun);
  }

  protected async incrementLogSeq(jobId: string): Promise<number> {
    const run = this.runs.get(jobId);
    if (!run) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
    const seq = run.log_seq + 1;
    this.runs.set(jobId, { ...run, log_seq: seq, version: run.version + 1 });
    return seq;
  }
}
