/**
 * PostgreSQL backend — twin of delphi/delphi_storage/backends/postgres.py.
 * Same physical layout: one schema (default `delphi`) with `runs` (typed
 * queue columns + JSONB manifest), `latest`, and four KV tables whose sort
 * keys use COLLATE "C" (UTF-8 byte order, matching DynamoDB). Queue claims
 * use FOR UPDATE SKIP LOCKED. The migration 000019 (P4) materializes the
 * same DDL for server-managed deployments.
 */
import { Pool, PoolClient } from "pg";

import { canonicalJsonDumps } from "./codec";
import {
  AdvanceLatestOptions,
  AdvanceResult,
  AlreadyExistsError,
  BaseDelphiStore,
  ClaimOptions,
  ExtendLeaseOptions,
  InvalidError,
  JobType,
  LatestPointer,
  ListRunsOptions,
  NotFoundError,
  RunManifest,
  RunStatus,
  StorageError,
  StoreItem,
  TERMINAL_STATUSES,
  coerceJobType,
  coerceRunStatus,
  mergeManifestFields,
  validateEnqueueable,
  validateGenericRead,
  validateGenericWrite,
} from "./interface";
import { GENERIC_ENTITIES, claimOrder, nowTs, tsAddSeconds, validateTs } from "./keys";

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const MUTATION_RETRIES = 8;

export function schemaDdl(schema: string): string[] {
  if (!IDENTIFIER_RE.test(schema)) {
    throw new InvalidError(`schema name ${JSON.stringify(schema)} must match ${IDENTIFIER_RE}`);
  }
  const statements: string[] = [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${schema}.runs (
        job_id text PRIMARY KEY,
        status text NOT NULL,
        claim_order text COLLATE "C",
        zid bigint,
        rid bigint,
        enqueued_at text NOT NULL,
        version bigint NOT NULL,
        manifest jsonb NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS runs_claim_idx
        ON ${schema}.runs (claim_order) WHERE status = 'QUEUED'`,
    `CREATE INDEX IF NOT EXISTS runs_zid_idx ON ${schema}.runs (zid, enqueued_at)`,
    `CREATE INDEX IF NOT EXISTS runs_rid_idx ON ${schema}.runs (rid, enqueued_at)`,
    `CREATE TABLE IF NOT EXISTS ${schema}.latest (
        scope text PRIMARY KEY,
        job_id text NOT NULL,
        seq bigint NOT NULL,
        job_type text NOT NULL,
        updated_at text NOT NULL
    )`,
  ];
  for (const entity of GENERIC_ENTITIES) {
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${schema}.${entity} (
          pk text NOT NULL,
          sk text COLLATE "C" NOT NULL,
          attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
          blob bytea,
          PRIMARY KEY (pk, sk)
      )`
    );
  }
  return statements;
}

export interface PostgresDelphiStoreOptions {
  url: string;
  schema: string;
  poolSize?: number;
}

export class PostgresDelphiStore extends BaseDelphiStore {
  private readonly pool: Pool;
  readonly schema: string;

  constructor(options: PostgresDelphiStoreOptions) {
    super();
    if (!IDENTIFIER_RE.test(options.schema)) {
      throw new InvalidError(
        `schema name ${JSON.stringify(options.schema)} must match ${IDENTIFIER_RE}`
      );
    }
    this.schema = options.schema;
    this.pool = new Pool({ connectionString: options.url, max: options.poolSize ?? 10 });
  }

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const statement of schemaDdl(this.schema)) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }
  }

  async dropSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await this.pool.end();
  }

  private kv(entity: string): string {
    validateGenericRead(entity);
    return `${this.schema}.${entity}`;
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- generic ----

  async put(entity: string, item: StoreItem): Promise<void> {
    validateGenericWrite(entity, item);
    await this.pool.query(
      `INSERT INTO ${this.kv(entity)} (pk, sk, attributes, blob)
       VALUES ($1, $2, CAST($3 AS jsonb), $4)
       ON CONFLICT (pk, sk) DO UPDATE SET attributes = EXCLUDED.attributes, blob = EXCLUDED.blob`,
      [item.pk, item.sk, canonicalJsonDumps(item.attributes), item.blob]
    );
  }

  private static rowToItem(row: {
    pk: string;
    sk: string;
    attributes: Record<string, unknown>;
    blob: Buffer | null;
  }): StoreItem {
    return {
      pk: row.pk,
      sk: row.sk,
      attributes: row.attributes,
      blob: row.blob === null ? null : Buffer.from(row.blob),
    };
  }

  async get(entity: string, pk: string, sk: string): Promise<StoreItem | null> {
    const result = await this.pool.query(
      `SELECT pk, sk, attributes, blob FROM ${this.kv(entity)} WHERE pk = $1 AND sk = $2`,
      [pk, sk]
    );
    return result.rows.length ? PostgresDelphiStore.rowToItem(result.rows[0]) : null;
  }

  async queryPrefix(entity: string, pk: string, skPrefix = ""): Promise<StoreItem[]> {
    const result = await this.pool.query(
      `SELECT pk, sk, attributes, blob FROM ${this.kv(entity)}
       WHERE pk = $1 AND left(sk, $2) = $3
       ORDER BY sk COLLATE "C"`,
      [pk, skPrefix.length, skPrefix]
    );
    return result.rows.map(PostgresDelphiStore.rowToItem);
  }

  async queryBetween(
    entity: string,
    pk: string,
    skFrom: string,
    skTo: string
  ): Promise<StoreItem[]> {
    const result = await this.pool.query(
      `SELECT pk, sk, attributes, blob FROM ${this.kv(entity)}
       WHERE pk = $1 AND sk >= $2 AND sk <= $3
       ORDER BY sk COLLATE "C"`,
      [pk, skFrom, skTo]
    );
    return result.rows.map(PostgresDelphiStore.rowToItem);
  }

  async deletePartition(entity: string, pk: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${this.kv(entity)} WHERE pk = $1`, [pk]);
    return result.rowCount ?? 0;
  }

  // ---- runs / queue ----

  private get runsTable(): string {
    return `${this.schema}.runs`;
  }

  private get latestTable(): string {
    return `${this.schema}.latest`;
  }

  private runParams(run: RunManifest): unknown[] {
    return [
      run.job_id,
      run.status,
      run.status === "QUEUED" ? claimOrder(run.priority, run.enqueued_at, run.job_id) : null,
      run.zid,
      run.rid,
      run.enqueued_at,
      run.version,
      canonicalJsonDumps(run),
    ];
  }

  async enqueueRun(run: RunManifest): Promise<void> {
    validateEnqueueable(run);
    const result = await this.pool.query(
      `INSERT INTO ${this.runsTable}
          (job_id, status, claim_order, zid, rid, enqueued_at, version, manifest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CAST($8 AS jsonb))
       ON CONFLICT (job_id) DO NOTHING`,
      this.runParams(run)
    );
    if (!result.rowCount) {
      throw new AlreadyExistsError(`run ${JSON.stringify(run.job_id)} already exists`);
    }
  }

  async getRun(jobId: string): Promise<RunManifest | null> {
    const result = await this.pool.query(
      `SELECT manifest FROM ${this.runsTable} WHERE job_id = $1`,
      [jobId]
    );
    return result.rows.length ? (result.rows[0].manifest as RunManifest) : null;
  }

  private async writeRun(
    client: PoolClient,
    run: RunManifest,
    expectedVersion: number
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE ${this.runsTable}
       SET status = $2, claim_order = $3, version = $4, manifest = CAST($5 AS jsonb)
       WHERE job_id = $1 AND version = $6`,
      [
        run.job_id,
        run.status,
        run.status === "QUEUED" ? claimOrder(run.priority, run.enqueued_at, run.job_id) : null,
        run.version,
        canonicalJsonDumps(run),
        expectedVersion,
      ]
    );
    return Boolean(result.rowCount);
  }

  async claimNextRun(options: ClaimOptions): Promise<RunManifest | null> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    return this.withTransaction(async (client) => {
      const candidate = await client.query(
        `SELECT manifest FROM ${this.runsTable}
         WHERE status = 'QUEUED'
         ORDER BY claim_order COLLATE "C"
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      if (!candidate.rows.length) return null;
      const run = candidate.rows[0].manifest as RunManifest;
      const claimed: RunManifest = {
        ...run,
        status: "RUNNING",
        worker_id: options.workerId,
        started_at: at,
        lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
        version: run.version + 1,
      };
      if (!(await this.writeRun(client, claimed, run.version))) {
        throw new StorageError(`claim of ${run.job_id} lost a race despite row lock`);
      }
      return claimed;
    });
  }

  async extendLease(options: ExtendLeaseOptions): Promise<boolean> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT manifest FROM ${this.runsTable} WHERE job_id = $1 FOR UPDATE`,
        [options.jobId]
      );
      if (!result.rows.length) return false;
      const run = result.rows[0].manifest as RunManifest;
      if (run.status !== "RUNNING" || run.worker_id !== options.workerId) return false;
      const extended: RunManifest = {
        ...run,
        lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
        version: run.version + 1,
      };
      return this.writeRun(client, extended, run.version);
    });
  }

  private async mutateRun(
    jobId: string,
    mutate: (run: RunManifest) => RunManifest
  ): Promise<RunManifest> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT manifest FROM ${this.runsTable} WHERE job_id = $1 FOR UPDATE`,
        [jobId]
      );
      if (!result.rows.length) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
      const run = result.rows[0].manifest as RunManifest;
      const updated: RunManifest = { ...mutate(run), version: run.version + 1 };
      if (!(await this.writeRun(client, updated, run.version))) {
        throw new StorageError(`update of ${JSON.stringify(jobId)} lost a race despite row lock`);
      }
      return updated;
    });
  }

  async updateRunStatus(
    jobId: string,
    status: RunStatus | string,
    options: { error?: string | null; now?: string } = {}
  ): Promise<RunManifest> {
    status = coerceRunStatus(status);
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    return this.mutateRun(jobId, (run) => {
      const updated: RunManifest = { ...run, status: status as RunStatus };
      if (options.error !== undefined && options.error !== null) updated.error = options.error;
      if ((TERMINAL_STATUSES as string[]).includes(status as string) && run.completed_at === null) {
        updated.completed_at = at;
      }
      return updated;
    });
  }

  async mergeRunFields(jobId: string, fields: Record<string, unknown>): Promise<RunManifest> {
    return this.mutateRun(jobId, (run) => mergeManifestFields(run, fields));
  }

  protected async incrementLogSeq(jobId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.runsTable}
       SET version = version + 1,
           manifest = jsonb_set(
               jsonb_set(manifest, '{log_seq}',
                   to_jsonb(COALESCE((manifest->>'log_seq')::bigint, 0) + 1)),
               '{version}', to_jsonb(version + 1))
       WHERE job_id = $1
       RETURNING (manifest->>'log_seq')::bigint AS log_seq`,
      [jobId]
    );
    if (!result.rows.length) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
    return Number(result.rows[0].log_seq);
  }

  // ---- latest ----

  async advanceLatest(options: AdvanceLatestOptions): Promise<AdvanceResult> {
    const jobType = coerceJobType(options.jobType);
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    for (let attempt = 0; attempt < MUTATION_RETRIES; attempt++) {
      const result = await this.withTransaction<AdvanceResult | null>(async (client) => {
        const existing = await client.query(
          `SELECT scope, job_id, seq, job_type, updated_at FROM ${this.latestTable}
           WHERE scope = $1 FOR UPDATE`,
          [options.scope]
        );
        if (existing.rows.length) {
          const current = PostgresDelphiStore.rowToPointer(existing.rows[0]);
          if (current.job_id === options.jobId) return { advanced: false, pointer: current };
          if (options.onlyIfAbsentOrImported && current.job_type !== "IMPORTED") {
            return { advanced: false, pointer: current };
          }
          const pointer: LatestPointer = {
            scope: options.scope,
            job_id: options.jobId,
            seq: current.seq + 1,
            job_type: jobType,
            updated_at: at,
          };
          await client.query(
            `UPDATE ${this.latestTable}
             SET job_id = $2, seq = $3, job_type = $4, updated_at = $5
             WHERE scope = $1`,
            [pointer.scope, pointer.job_id, pointer.seq, pointer.job_type, pointer.updated_at]
          );
          return { advanced: true, pointer };
        }
        const pointer: LatestPointer = {
          scope: options.scope,
          job_id: options.jobId,
          seq: 1,
          job_type: jobType,
          updated_at: at,
        };
        const inserted = await client.query(
          `INSERT INTO ${this.latestTable} (scope, job_id, seq, job_type, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (scope) DO NOTHING`,
          [pointer.scope, pointer.job_id, pointer.seq, pointer.job_type, pointer.updated_at]
        );
        if (inserted.rowCount) return { advanced: true, pointer };
        return null; // lost the empty-scope insert race — re-read and re-decide
      });
      if (result !== null) return result;
    }
    throw new StorageError(
      `latest ${JSON.stringify(options.scope)}: lost ${MUTATION_RETRIES} insert races`
    );
  }

  private static rowToPointer(row: {
    scope: string;
    job_id: string;
    seq: number | string;
    job_type: string;
    updated_at: string;
  }): LatestPointer {
    return {
      scope: row.scope,
      job_id: row.job_id,
      seq: Number(row.seq),
      job_type: row.job_type as JobType,
      updated_at: row.updated_at,
    };
  }

  async getLatest(scope: string): Promise<LatestPointer | null> {
    const result = await this.pool.query(
      `SELECT scope, job_id, seq, job_type, updated_at FROM ${this.latestTable} WHERE scope = $1`,
      [scope]
    );
    return result.rows.length ? PostgresDelphiStore.rowToPointer(result.rows[0]) : null;
  }

  async listRuns(options: ListRunsOptions): Promise<RunManifest[]> {
    const hasZid = options.zid !== undefined && options.zid !== null;
    const hasRid = options.rid !== undefined && options.rid !== null;
    if (hasZid === hasRid) throw new InvalidError("exactly one of zid/rid is required");
    const statusFilter =
      options.status !== undefined && options.status !== null
        ? coerceRunStatus(options.status)
        : null;
    const column = hasZid ? "zid" : "rid";
    const value = hasZid ? options.zid : options.rid;
    const params: unknown[] = [value];
    let statusClause = "";
    if (statusFilter !== null) {
      params.push(statusFilter);
      statusClause = ` AND status = $${params.length}`;
    }
    params.push(options.limit ?? 100);
    const result = await this.pool.query(
      `SELECT manifest FROM ${this.runsTable}
       WHERE ${column} = $1${statusClause}
       ORDER BY enqueued_at DESC, job_id DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => row.manifest as RunManifest);
  }
}
