/**
 * Conformance suite against the real backends (DynamoDB local + PostgreSQL),
 * plus the two-claimants-one-wins race. Services are provided by
 * docker-compose.test.yml in CI (DYNAMODB_ENDPOINT / DATABASE_URL), matching
 * the other integration suites.
 *
 * Spec + case files: delphi/delphi_storage/conformance/ (shared with pytest).
 */
import { loadCases, runCase } from "../setup/delphi-storage-conformance";
import { DynamoDelphiStore } from "../../src/storage/delphi/dynamoStore";
import { PostgresDelphiStore } from "../../src/storage/delphi/postgresStore";
import { DelphiStore, normalizeRunManifest } from "../../src/storage/delphi/interface";

const cases = loadCases();

const DYNAMO_ENDPOINT = process.env.DYNAMODB_ENDPOINT || "http://localhost:8000";
const PG_URL =
  process.env.DELPHI_STORAGE_PG_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/polis-test";

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function raceTest(store: DelphiStore): Promise<void> {
  const nJobs = 4;
  const nWorkers = 10;
  for (let i = 0; i < nJobs; i++) {
    await store.enqueueRun(
      normalizeRunManifest({
        job_id: `race-${i}`,
        job_type: "FULL_PIPELINE",
        zid: 1,
        enqueued_at: `2026-07-06T10:00:0${i}.000Z`,
      })
    );
  }
  const claims = await Promise.all(
    Array.from({ length: nWorkers }, (_, i) =>
      store.claimNextRun({ workerId: `w${i}`, leaseSeconds: 300 })
    )
  );
  const claimed = claims.filter((r) => r !== null).map((r) => r!.job_id);
  expect(claimed.length).toBe(nJobs);
  expect(new Set(claimed).size).toBe(nJobs);
  expect(await store.claimNextRun({ workerId: "late", leaseSeconds: 300 })).toBeNull();
}

describe("delphi storage conformance — dynamodb backend", () => {
  let store: DynamoDelphiStore;

  afterEach(async () => {
    if (store) await store.dropTables();
  });

  it.each(cases)("case $name", async (c) => {
    store = new DynamoDelphiStore({
      tablePrefix: `ConfTs${uniqueSuffix()}_`,
      endpoint: DYNAMO_ENDPOINT,
      region: "us-east-1",
    });
    await store.ensureTables();
    await runCase(store, c);
  });

  it("two claimants never share a run", async () => {
    store = new DynamoDelphiStore({
      tablePrefix: `ConfTs${uniqueSuffix()}_`,
      endpoint: DYNAMO_ENDPOINT,
      region: "us-east-1",
    });
    await store.ensureTables();
    await raceTest(store);
  });
});

describe("delphi storage conformance — postgres backend", () => {
  let store: PostgresDelphiStore;

  afterEach(async () => {
    if (store) await store.dropSchema();
  });

  it.each(cases)("case $name", async (c) => {
    store = new PostgresDelphiStore({ url: PG_URL, schema: `conf_ts_${uniqueSuffix()}` });
    await store.ensureSchema();
    await runCase(store, c);
  });

  it("two claimants never share a run", async () => {
    store = new PostgresDelphiStore({ url: PG_URL, schema: `conf_ts_${uniqueSuffix()}` });
    await store.ensureSchema();
    await raceTest(store);
  });
});
