/**
 * DynamoDB backend — twin of delphi/delphi_storage/backends/dynamodb.py.
 * Same physical layout (tables, sparse claim GSI, U+007F chunk rows for
 * blobs >300KB) and the same conditional-write discipline: every run/latest
 * mutation conditions on the version/seq that was read.
 *
 * Marshalling note: uses DynamoDBDocumentClient WITHOUT convertEmptyValues
 * (deliberate deviation from the older house pattern) — empty strings must
 * round-trip, per the conformance contract.
 */
import * as crypto from "crypto";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

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
import { CHUNK_MARKER, claimOrder, nowTs, tsAddSeconds, utf8Compare, validateTs } from "./keys";

/**
 * Max blob bytes stored inline in one item (DynamoDB item limit is 400KB
 * including attribute names; 300KB leaves ample headroom for attributes).
 */
export const CHUNK_SIZE = 300_000;

const ENTITY_TABLES: Record<string, string> = {
  run_inputs: "RunInputs",
  artifacts: "Artifacts",
  topic_moderation: "TopicModeration",
  collective_statements: "CollectiveStatements",
};

const RUNS_INDEX_ATTRS = ["claim_status", "claim_order", "zid_key", "rid_key"];

const MUTATION_RETRIES = 8;

function kvTableSchema(tableName: string) {
  return {
    TableName: tableName,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  };
}

function runsTableSchema(tableName: string) {
  return {
    TableName: tableName,
    KeySchema: [{ AttributeName: "job_id", KeyType: "HASH" as const }],
    AttributeDefinitions: [
      { AttributeName: "job_id", AttributeType: "S" as const },
      { AttributeName: "claim_status", AttributeType: "S" as const },
      { AttributeName: "claim_order", AttributeType: "S" as const },
      { AttributeName: "zid_key", AttributeType: "S" as const },
      { AttributeName: "rid_key", AttributeType: "S" as const },
      { AttributeName: "enqueued_at", AttributeType: "S" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "claim-index",
        KeySchema: [
          { AttributeName: "claim_status", KeyType: "HASH" as const },
          { AttributeName: "claim_order", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "KEYS_ONLY" as const },
      },
      {
        IndexName: "zid-index",
        KeySchema: [
          { AttributeName: "zid_key", KeyType: "HASH" as const },
          { AttributeName: "enqueued_at", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
      {
        IndexName: "rid-index",
        KeySchema: [
          { AttributeName: "rid_key", KeyType: "HASH" as const },
          { AttributeName: "enqueued_at", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
    BillingMode: "PAY_PER_REQUEST" as const,
  };
}

function latestTableSchema(tableName: string) {
  return {
    TableName: tableName,
    KeySchema: [{ AttributeName: "scope", KeyType: "HASH" as const }],
    AttributeDefinitions: [{ AttributeName: "scope", AttributeType: "S" as const }],
    BillingMode: "PAY_PER_REQUEST" as const,
  };
}

function chunkPrefix(sk: string): string {
  return `${CHUNK_MARKER}${sk}${CHUNK_MARKER}`;
}

function chunkSk(sk: string, gen: string, index: number): string {
  return `${chunkPrefix(sk)}${gen}${CHUNK_MARKER}${String(index).padStart(5, "0")}`;
}

function newGeneration(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function isChunkSk(sk: string): boolean {
  return sk.startsWith(CHUNK_MARKER);
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}

export interface DynamoDelphiStoreOptions {
  tablePrefix: string;
  endpoint?: string;
  region?: string;
}

interface RawItem {
  pk: string;
  sk: string;
  attributes: Record<string, unknown>;
  blob?: Uint8Array;
  _chunks?: number;
  _blob_len?: number;
  _blob_gen?: string;
}

export class DynamoDelphiStore extends BaseDelphiStore {
  private readonly tablePrefix: string;
  private readonly client: DynamoDBClient;
  private readonly doc: DynamoDBDocumentClient;

  constructor(options: DynamoDelphiStoreOptions) {
    super();
    this.tablePrefix = options.tablePrefix;
    const config: DynamoDBClientConfig = { region: options.region || "us-east-1" };
    if (options.endpoint) {
      config.endpoint = options.endpoint;
      config.credentials = {
        accessKeyId: "DUMMYIDEXAMPLE",
        secretAccessKey: "DUMMYEXAMPLEKEY",
      };
    }
    this.client = new DynamoDBClient(config);
    this.doc = DynamoDBDocumentClient.from(this.client, {
      // No convertEmptyValues: empty strings must round-trip (conformance).
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private tableSchemas() {
    return [
      runsTableSchema(`${this.tablePrefix}Runs`),
      latestTableSchema(`${this.tablePrefix}Latest`),
      ...Object.values(ENTITY_TABLES).map((name) => kvTableSchema(`${this.tablePrefix}${name}`)),
    ];
  }

  async ensureTables(): Promise<void> {
    const existing = new Set<string>();
    let start: string | undefined;
    do {
      const page = await this.client.send(
        new ListTablesCommand(start ? { ExclusiveStartTableName: start } : {})
      );
      (page.TableNames || []).forEach((n) => existing.add(n));
      start = page.LastEvaluatedTableName;
    } while (start);
    for (const schema of this.tableSchemas()) {
      if (!existing.has(schema.TableName)) {
        await this.client.send(new CreateTableCommand(schema));
      }
    }
    for (const schema of this.tableSchemas()) {
      await waitUntilTableExists(
        { client: this.client, maxWaitTime: 60 },
        { TableName: schema.TableName }
      );
    }
  }

  async dropTables(): Promise<void> {
    for (const schema of this.tableSchemas()) {
      try {
        await this.client.send(new DeleteTableCommand({ TableName: schema.TableName }));
      } catch (error) {
        if ((error as { name?: string })?.name !== "ResourceNotFoundException") throw error;
      }
    }
    this.client.destroy();
  }

  private table(entity: string): string {
    return `${this.tablePrefix}${ENTITY_TABLES[entity]}`;
  }

  private async queryAll(input: {
    TableName: string;
    IndexName?: string;
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
    ProjectionExpression?: string;
    ConsistentRead?: boolean;
    ScanIndexForward?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new QueryCommand({ ...input, ExclusiveStartKey: startKey })
      );
      items.push(...((page.Items as Record<string, unknown>[]) || []));
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items;
  }

  // ---- generic ----

  /**
   * Crash-safe write order for chunked blobs: new-generation chunk rows first
   * (invisible — the main item still references the old generation), THEN the
   * main item (the commit point flips readers atomically), THEN
   * stale-generation cleanup. A crash at any point leaves the previous value
   * fully readable; orphaned generations are swept by the next successful put.
   */
  async put(entity: string, item: StoreItem): Promise<void> {
    validateGenericWrite(entity, item);
    const table = this.table(entity);
    const blob = item.blob ?? Buffer.alloc(0);
    const nChunks =
      item.blob !== null && blob.length > CHUNK_SIZE ? Math.ceil(blob.length / CHUNK_SIZE) : 0;
    const gen = newGeneration();
    for (let i = 0; i < nChunks; i++) {
      await this.doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: item.pk,
            sk: chunkSk(item.sk, gen, i),
            part: blob.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          },
        })
      );
    }
    const record: Record<string, unknown> = {
      pk: item.pk,
      sk: item.sk,
      attributes: item.attributes,
    };
    if (item.blob !== null) {
      if (nChunks > 0) {
        record._chunks = nChunks;
        record._blob_len = blob.length;
        record._blob_gen = gen;
      } else {
        record.blob = blob;
      }
    }
    await this.doc.send(new PutCommand({ TableName: table, Item: record }));
    await this.deleteChunkRows(table, item.pk, item.sk, nChunks > 0 ? gen : undefined);
  }

  private async deleteChunkRows(
    table: string,
    pk: string,
    sk: string,
    keepGen?: string
  ): Promise<void> {
    const prefix = chunkPrefix(sk);
    const keepPrefix = keepGen !== undefined ? `${prefix}${keepGen}${CHUNK_MARKER}` : undefined;
    const rows = await this.queryAll({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ProjectionExpression: "pk, sk",
      ConsistentRead: true,
    });
    for (const row of rows) {
      if (keepPrefix !== undefined && (row.sk as string).startsWith(keepPrefix)) continue;
      await this.doc.send(
        new DeleteCommand({ TableName: table, Key: { pk: row.pk, sk: row.sk } })
      );
    }
  }

  private async readBlob(table: string, raw: RawItem): Promise<Buffer | null> {
    if (raw.blob !== undefined) return Buffer.from(raw.blob);
    if (raw._chunks === undefined) return null;
    // Fetch exactly the deterministic chunk keys of the committed generation —
    // stale rows from other generations can never interfere.
    const gen = raw._blob_gen as string;
    const parts: Buffer[] = [];
    for (let i = 0; i < raw._chunks; i++) {
      const response = await this.doc.send(
        new GetCommand({
          TableName: table,
          Key: { pk: raw.pk, sk: chunkSk(raw.sk, gen, i) },
          ConsistentRead: true,
        })
      );
      if (!response.Item) {
        throw new StorageError(
          `corrupt chunked blob at ${raw.pk}/${raw.sk}: missing chunk ${i}/${raw._chunks} ` +
            `of generation ${gen}`
        );
      }
      parts.push(Buffer.from(response.Item.part as Uint8Array));
    }
    const blob = Buffer.concat(parts);
    if (blob.length !== raw._blob_len) {
      throw new StorageError(
        `corrupt chunked blob at ${raw.pk}/${raw.sk}: ${blob.length}/${raw._blob_len} bytes`
      );
    }
    return blob;
  }

  private async toStoreItem(table: string, raw: RawItem): Promise<StoreItem> {
    return {
      pk: raw.pk,
      sk: raw.sk,
      attributes: raw.attributes,
      blob: await this.readBlob(table, raw),
    };
  }

  async get(entity: string, pk: string, sk: string): Promise<StoreItem | null> {
    validateGenericRead(entity);
    const table = this.table(entity);
    const response = await this.doc.send(
      new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true })
    );
    if (!response.Item) return null;
    return this.toStoreItem(table, response.Item as unknown as RawItem);
  }

  async queryPrefix(entity: string, pk: string, skPrefix = ""): Promise<StoreItem[]> {
    validateGenericRead(entity);
    const table = this.table(entity);
    const input = {
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :prefix)" : "pk = :pk",
      ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":prefix": skPrefix } : { ":pk": pk },
    };
    const rows = (await this.queryAll(input)) as unknown as RawItem[];
    const logical = rows.filter((row) => !isChunkSk(row.sk));
    return Promise.all(logical.map((row) => this.toStoreItem(table, row)));
  }

  async queryBetween(
    entity: string,
    pk: string,
    skFrom: string,
    skTo: string
  ): Promise<StoreItem[]> {
    validateGenericRead(entity);
    const table = this.table(entity);
    const rows = (await this.queryAll({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
      ExpressionAttributeValues: { ":pk": pk, ":lo": skFrom, ":hi": skTo },
    })) as unknown as RawItem[];
    const logical = rows.filter((row) => !isChunkSk(row.sk));
    return Promise.all(logical.map((row) => this.toStoreItem(table, row)));
  }

  async deletePartition(entity: string, pk: string): Promise<number> {
    validateGenericRead(entity);
    const table = this.table(entity);
    const rows = await this.queryAll({
      TableName: table,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ProjectionExpression: "pk, sk",
    });
    let logical = 0;
    for (const row of rows) {
      if (!isChunkSk(row.sk as string)) logical += 1;
      await this.doc.send(
        new DeleteCommand({ TableName: table, Key: { pk: row.pk, sk: row.sk } })
      );
    }
    return logical;
  }

  // ---- runs / queue ----

  private get runsTable(): string {
    return `${this.tablePrefix}Runs`;
  }

  private get latestTable(): string {
    return `${this.tablePrefix}Latest`;
  }

  private runRecord(run: RunManifest): Record<string, unknown> {
    const record: Record<string, unknown> = { ...run };
    if (run.status === "QUEUED") {
      record.claim_status = "QUEUED";
      record.claim_order = claimOrder(run.priority, run.enqueued_at, run.job_id);
    }
    if (run.zid !== null && run.zid !== undefined) record.zid_key = String(run.zid);
    if (run.rid !== null && run.rid !== undefined) record.rid_key = String(run.rid);
    return record;
  }

  private recordToRun(raw: Record<string, unknown>): RunManifest {
    const fields = { ...raw };
    for (const attr of RUNS_INDEX_ATTRS) delete fields[attr];
    return fields as unknown as RunManifest;
  }

  private async getRunRaw(jobId: string): Promise<Record<string, unknown> | null> {
    const response = await this.doc.send(
      new GetCommand({ TableName: this.runsTable, Key: { job_id: jobId }, ConsistentRead: true })
    );
    return (response.Item as Record<string, unknown>) ?? null;
  }

  /** Full-item replace conditional on the version we read; false on a lost race. */
  private async putRunVersioned(run: RunManifest, expectedVersion: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.runsTable,
          Item: this.runRecord(run),
          ConditionExpression: "#version = :v",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":v": expectedVersion },
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }

  async enqueueRun(run: RunManifest): Promise<void> {
    validateEnqueueable(run);
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.runsTable,
          Item: this.runRecord(run),
          ConditionExpression: "attribute_not_exists(job_id)",
        })
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new AlreadyExistsError(`run ${JSON.stringify(run.job_id)} already exists`);
      }
      throw error;
    }
  }

  async getRun(jobId: string): Promise<RunManifest | null> {
    const raw = await this.getRunRaw(jobId);
    return raw ? this.recordToRun(raw) : null;
  }

  async claimNextRun(options: ClaimOptions): Promise<RunManifest | null> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    // Candidates come from the (eventually consistent) sparse GSI; the claim
    // itself is a conditional write on the base table, so staleness only
    // costs a wasted attempt, never a double claim.
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.doc.send(
        new QueryCommand({
          TableName: this.runsTable,
          IndexName: "claim-index",
          KeyConditionExpression: "claim_status = :queued",
          ExpressionAttributeValues: { ":queued": "QUEUED" },
          ScanIndexForward: true,
          Limit: 10,
          ExclusiveStartKey: startKey,
        })
      );
      for (const candidate of (page.Items as Record<string, unknown>[]) || []) {
        const raw = await this.getRunRaw(candidate.job_id as string);
        if (!raw || raw.status !== "QUEUED") continue;
        const run = this.recordToRun(raw);
        const claimed: RunManifest = {
          ...run,
          status: "RUNNING",
          worker_id: options.workerId,
          started_at: at,
          lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
          version: run.version + 1,
        };
        if (await this.putRunVersioned(claimed, run.version)) {
          return claimed;
        }
      }
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return null;
  }

  async extendLease(options: ExtendLeaseOptions): Promise<boolean> {
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    for (let attempt = 0; attempt < MUTATION_RETRIES; attempt++) {
      const raw = await this.getRunRaw(options.jobId);
      if (!raw) return false;
      const run = this.recordToRun(raw);
      if (run.status !== "RUNNING" || run.worker_id !== options.workerId) return false;
      const extended: RunManifest = {
        ...run,
        lease_expires_at: tsAddSeconds(at, options.leaseSeconds),
        version: run.version + 1,
      };
      if (await this.putRunVersioned(extended, run.version)) return true;
    }
    return false;
  }

  private async mutateRun(
    jobId: string,
    mutate: (run: RunManifest) => RunManifest
  ): Promise<RunManifest> {
    for (let attempt = 0; attempt < MUTATION_RETRIES; attempt++) {
      const raw = await this.getRunRaw(jobId);
      if (!raw) throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
      const run = this.recordToRun(raw);
      const updated: RunManifest = { ...mutate(run), version: run.version + 1 };
      if (await this.putRunVersioned(updated, run.version)) return updated;
    }
    throw new StorageError(
      `run ${JSON.stringify(jobId)}: lost ${MUTATION_RETRIES} optimistic-lock races`
    );
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
    try {
      const response = await this.doc.send(
        new UpdateCommand({
          TableName: this.runsTable,
          Key: { job_id: jobId },
          UpdateExpression: "SET log_seq = log_seq + :one, #version = #version + :one",
          ConditionExpression: "attribute_exists(job_id)",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "UPDATED_NEW",
        })
      );
      return (response.Attributes as { log_seq: number }).log_seq;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new NotFoundError(`run ${JSON.stringify(jobId)} not found`);
      }
      throw error;
    }
  }

  // ---- latest ----

  async advanceLatest(options: AdvanceLatestOptions): Promise<AdvanceResult> {
    const jobType = coerceJobType(options.jobType);
    const at = options.now !== undefined ? validateTs(options.now) : nowTs();
    for (let attempt = 0; attempt < MUTATION_RETRIES; attempt++) {
      const current = await this.getLatest(options.scope);
      if (current) {
        if (current.job_id === options.jobId) return { advanced: false, pointer: current };
        if (options.onlyIfAbsentOrImported && current.job_type !== "IMPORTED") {
          return { advanced: false, pointer: current };
        }
      }
      const pointer: LatestPointer = {
        scope: options.scope,
        job_id: options.jobId,
        seq: current ? current.seq + 1 : 1,
        job_type: jobType,
        updated_at: at,
      };
      try {
        await this.doc.send(
          new PutCommand({
            TableName: this.latestTable,
            Item: pointer as unknown as Record<string, unknown>,
            ...(current
              ? {
                  ConditionExpression: "#seq = :old",
                  ExpressionAttributeNames: { "#seq": "seq" },
                  ExpressionAttributeValues: { ":old": current.seq },
                }
              : {
                  ConditionExpression: "attribute_not_exists(#scope)",
                  ExpressionAttributeNames: { "#scope": "scope" },
                }),
          })
        );
        return { advanced: true, pointer };
      } catch (error) {
        if (isConditionalCheckFailed(error)) continue; // concurrent advance — re-read
        throw error;
      }
    }
    throw new StorageError(
      `latest ${JSON.stringify(options.scope)}: lost ${MUTATION_RETRIES} optimistic-lock races`
    );
  }

  async getLatest(scope: string): Promise<LatestPointer | null> {
    const response = await this.doc.send(
      new GetCommand({ TableName: this.latestTable, Key: { scope }, ConsistentRead: true })
    );
    return (response.Item as unknown as LatestPointer) ?? null;
  }

  async listRuns(options: ListRunsOptions): Promise<RunManifest[]> {
    const hasZid = options.zid !== undefined && options.zid !== null;
    const hasRid = options.rid !== undefined && options.rid !== null;
    if (hasZid === hasRid) throw new InvalidError("exactly one of zid/rid is required");
    const statusFilter =
      options.status !== undefined && options.status !== null
        ? coerceRunStatus(options.status)
        : null;
    const [index, attr, value] = hasZid
      ? ["zid-index", "zid_key", String(options.zid)]
      : ["rid-index", "rid_key", String(options.rid)];
    const rows = await this.queryAll({
      TableName: this.runsTable,
      IndexName: index,
      KeyConditionExpression: `${attr} = :key`,
      ExpressionAttributeValues: { ":key": value },
      ScanIndexForward: false,
    });
    let runs = rows.map((row) => this.recordToRun(row));
    if (statusFilter !== null) {
      runs = runs.filter((r) => r.status === statusFilter);
    }
    runs.sort((a, b) => {
      const byTime = utf8Compare(b.enqueued_at, a.enqueued_at);
      return byTime !== 0 ? byTime : utf8Compare(b.job_id, a.job_id);
    });
    return runs.slice(0, options.limit ?? 100);
  }
}
