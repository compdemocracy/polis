/**
 * Backend selection for Delphi Storage V2 — twin of
 * delphi/delphi_storage/factory.py, wired through src/config.ts:
 *
 * - DELPHI_STORAGE_BACKEND      — dynamodb (default) | postgres | memory
 * - DELPHI_STORAGE_TABLE_PREFIX — DynamoDB table prefix (default Delphi2_)
 * - DELPHI_STORAGE_PG_SCHEMA    — PostgreSQL schema (default delphi)
 * - DELPHI_STORAGE_PG_URL       — PostgreSQL URL (falls back to DATABASE_URL)
 * - DYNAMODB_ENDPOINT / AWS_REGION — existing vocabulary, reused as-is
 */
import Config from "../../config";
import { InvalidError } from "./errors";
import { DelphiStore } from "./interface";
import { DynamoDelphiStore } from "./dynamoStore";
import { MemoryDelphiStore } from "./memoryStore";
import { PostgresDelphiStore } from "./postgresStore";

export function getDelphiStore(backend?: string): DelphiStore {
  const kind = backend || Config.delphiStorageBackend;
  if (kind === "memory") {
    return new MemoryDelphiStore();
  }
  if (kind === "dynamodb") {
    return new DynamoDelphiStore({
      tablePrefix: Config.delphiStorageTablePrefix,
      endpoint: Config.dynamoDbEndpoint || undefined,
      region: Config.awsRegion,
    });
  }
  if (kind === "postgres") {
    if (!Config.delphiStoragePgUrl) {
      throw new InvalidError("postgres backend needs DELPHI_STORAGE_PG_URL or DATABASE_URL");
    }
    return new PostgresDelphiStore({
      url: Config.delphiStoragePgUrl,
      schema: Config.delphiStoragePgSchema,
    });
  }
  throw new InvalidError(
    `unknown DELPHI_STORAGE_BACKEND ${JSON.stringify(kind)} (expected dynamodb|postgres|memory)`
  );
}
