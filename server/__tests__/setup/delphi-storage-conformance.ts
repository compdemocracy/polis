/**
 * Jest executor for the shared Delphi Storage V2 conformance case files —
 * twin of delphi/delphi_storage/conformance/runner.py, executing the SAME
 * JSON operation-scripts from delphi/delphi_storage/conformance/cases/.
 * The op vocabulary is specified in the README next to the cases; keep the
 * three in sync.
 */
import * as fs from "fs";
import * as path from "path";

import {
  F64,
  decodePayload,
  encodePayload,
  packF64,
} from "../../src/storage/delphi/codec";
import { StorageError } from "../../src/storage/delphi/errors";
import {
  DelphiStore,
  RunManifest,
  StoreItem,
  normalizeRunManifest,
} from "../../src/storage/delphi/interface";

export const CASES_DIR = path.resolve(
  __dirname,
  "../../../delphi/delphi_storage/conformance/cases"
);

export interface ConformanceOp {
  op: string;
  expect?: Record<string, unknown>;
  expect_error?: string;
  [key: string]: unknown;
}

export interface ConformanceCase {
  name: string;
  description: string;
  ops: ConformanceOp[];
}

function loadFile(file: string): ConformanceCase {
  return JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8")) as ConformanceCase;
}

export function loadCases(): ConformanceCase[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("codec_"))
    .sort()
    .map(loadFile);
}

export function loadCodecCases(): ConformanceCase[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json") && f.startsWith("codec_"))
    .sort()
    .map(loadFile);
}

/** Deterministic blob generators shared with the pytest runner. */
export function genBlob(spec: { kind: string; n: number }): Buffer {
  if (spec.kind === "f64_seq") {
    return packF64(Array.from({ length: spec.n }, (_, i) => i * 0.5));
  }
  throw new Error(`unknown blob generator ${JSON.stringify(spec.kind)}`);
}

function isPlainNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Deep equality; numbers compare by value (DynamoDB may return 2 for a
 * stored 2.0), booleans strictly.
 */
export function assertJsonEqual(actual: unknown, expected: unknown, at = "$"): void {
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    if (actual !== expected) {
      throw new Error(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (isPlainNumber(expected) && isPlainNumber(actual)) {
    if (actual !== expected) {
      throw new Error(`${at}: expected ${expected}, got ${actual}`);
    }
    return;
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      throw new Error(`${at}: expected object, got ${JSON.stringify(actual)}`);
    }
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      throw new Error(
        `${at}: key mismatch — expected ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`
      );
    }
    for (const key of expectedKeys) {
      assertJsonEqual(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${at}.${key}`
      );
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(
        `${at}: expected ${expected.length}-element list, got ${JSON.stringify(actual)}`
      );
    }
    expected.forEach((e, i) => assertJsonEqual(actual[i], e, `${at}[${i}]`));
    return;
  }
  if (actual !== expected) {
    throw new Error(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function itemFromSpec(spec: Record<string, unknown>): StoreItem {
  let blob: Buffer | null = null;
  if (spec.blob_b64 !== undefined && spec.blob_b64 !== null) {
    blob = Buffer.from(spec.blob_b64 as string, "base64");
  } else if (spec.blob_gen !== undefined && spec.blob_gen !== null) {
    blob = genBlob(spec.blob_gen as { kind: string; n: number });
  }
  return {
    pk: spec.pk as string,
    sk: spec.sk as string,
    attributes: (spec.attributes as Record<string, unknown>) ?? {},
    blob,
  };
}

function expectedBlob(expect: Record<string, unknown>): Buffer | null {
  if (expect.blob_b64 !== undefined && expect.blob_b64 !== null) {
    return Buffer.from(expect.blob_b64 as string, "base64");
  }
  if (expect.blob_gen !== undefined && expect.blob_gen !== null) {
    return genBlob(expect.blob_gen as { kind: string; n: number });
  }
  return null;
}

function assertManifestSubset(
  run: RunManifest,
  expect: Record<string, unknown>,
  context: string
): void {
  for (const [key, expected] of Object.entries(expect)) {
    if (key === "found" || key === "latest") continue;
    assertJsonEqual(
      (run as unknown as Record<string, unknown>)[key],
      expected,
      `${context}.${key}`
    );
  }
}

async function runOp(store: DelphiStore, op: ConformanceOp): Promise<void> {
  const expect = op.expect ?? {};
  const expectedError = op.expect_error;

  const call = async (): Promise<unknown> => {
    switch (op.op) {
      case "put":
        return store.put(op.entity as string, itemFromSpec(op.item as Record<string, unknown>));
      case "put_batch":
        return store.putBatch(
          op.entity as string,
          (op.items as Record<string, unknown>[]).map(itemFromSpec)
        );
      case "get":
        return store.get(op.entity as string, op.pk as string, op.sk as string);
      case "query_prefix":
        return store.queryPrefix(
          op.entity as string,
          op.pk as string,
          (op.sk_prefix as string) ?? ""
        );
      case "query_between":
        return store.queryBetween(
          op.entity as string,
          op.pk as string,
          op.sk_from as string,
          op.sk_to as string
        );
      case "delete_partition":
        return store.deletePartition(op.entity as string, op.pk as string);
      case "enqueue_run":
        return store.enqueueRun(normalizeRunManifest(op.run as Record<string, unknown>));
      case "get_run":
        return store.getRun(op.job_id as string);
      case "claim_next_run":
        return store.claimNextRun({
          workerId: op.worker_id as string,
          leaseSeconds: op.lease_seconds as number,
          now: op.now as string | undefined,
        });
      case "extend_lease":
        return store.extendLease({
          jobId: op.job_id as string,
          workerId: op.worker_id as string,
          leaseSeconds: op.lease_seconds as number,
          now: op.now as string | undefined,
        });
      case "update_run_status":
        return store.updateRunStatus(op.job_id as string, op.status as string, {
          error: op.error as string | undefined,
          now: op.now as string | undefined,
        });
      case "merge_run_fields":
        return store.mergeRunFields(op.job_id as string, op.fields as Record<string, unknown>);
      case "complete_run":
        return store.completeRun(op.job_id as string, op.now as string | undefined);
      case "append_log":
        return store.appendLog(
          op.job_id as string,
          op.message as string,
          op.now as string | undefined
        );
      case "advance_latest":
        return store.advanceLatest({
          scope: op.scope as string,
          jobId: op.job_id as string,
          jobType: op.job_type as string,
          onlyIfAbsentOrImported: (op.only_if_absent_or_imported as boolean) ?? false,
          now: op.now as string | undefined,
        });
      case "get_latest":
        return store.getLatest(op.scope as string);
      case "list_runs":
        return store.listRuns({
          zid: op.zid as number | undefined,
          rid: op.rid as number | undefined,
          status: op.status as string | undefined,
        });
      default:
        throw new Error(`unknown op ${JSON.stringify(op.op)}`);
    }
  };

  if (expectedError !== undefined) {
    try {
      await call();
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.code !== expectedError) {
          throw new Error(
            `expected error ${JSON.stringify(expectedError)}, got ${error.code} (${error.message})`
          );
        }
        return;
      }
      throw error;
    }
    throw new Error(`expected error ${JSON.stringify(expectedError)}, but op succeeded`);
  }

  const result = await call();

  switch (op.op) {
    case "get": {
      if (!Object.keys(expect).length) return;
      const item = result as StoreItem | null;
      if (!expect.found) {
        if (item !== null) throw new Error(`expected absent item, got ${JSON.stringify(item)}`);
        return;
      }
      if (item === null) throw new Error("expected item, got null");
      if (expect.attributes !== undefined) {
        assertJsonEqual(item.attributes, expect.attributes, "attributes");
      }
      const blob = expectedBlob(expect);
      if (blob !== null) {
        if (item.blob === null || !blob.equals(item.blob)) {
          throw new Error("blob bytes differ");
        }
      }
      if (expect.blob_len !== undefined) {
        if (item.blob === null || item.blob.length !== expect.blob_len) {
          throw new Error(
            `expected blob of ${expect.blob_len} bytes, got ${item.blob?.length ?? null}`
          );
        }
      }
      return;
    }
    case "query_prefix":
    case "query_between": {
      if (expect.sks !== undefined) {
        const sks = (result as StoreItem[]).map((i) => i.sk);
        assertJsonEqual(sks, expect.sks, "sks");
      }
      return;
    }
    case "delete_partition": {
      if (expect.deleted !== undefined) {
        assertJsonEqual(result, expect.deleted, "deleted");
      }
      return;
    }
    case "get_run": {
      if (!Object.keys(expect).length) return;
      const run = result as RunManifest | null;
      if (!expect.found) {
        if (run !== null) throw new Error(`expected absent run, got ${JSON.stringify(run)}`);
        return;
      }
      if (run === null) throw new Error("expected run, got null");
      assertManifestSubset(run, expect, "run");
      return;
    }
    case "claim_next_run": {
      if (!("job_id" in expect)) return;
      const run = result as RunManifest | null;
      if (expect.job_id === null) {
        if (run !== null) throw new Error(`expected no claim, got ${run.job_id}`);
        return;
      }
      if (run === null || run.job_id !== expect.job_id) {
        throw new Error(
          `expected claim of ${JSON.stringify(expect.job_id)}, got ${run ? run.job_id : null}`
        );
      }
      const rest = { ...expect };
      delete rest.job_id;
      assertManifestSubset(run, rest, "claim");
      return;
    }
    case "extend_lease": {
      if (expect.ok !== undefined && result !== expect.ok) {
        throw new Error(`expected ok=${expect.ok}, got ${result}`);
      }
      return;
    }
    case "update_run_status":
    case "merge_run_fields":
    case "complete_run": {
      const run = result as RunManifest;
      assertManifestSubset(run, expect, op.op);
      if (op.op === "complete_run" && expect.latest !== undefined) {
        for (const pointerExpect of expect.latest as Array<Record<string, unknown>>) {
          const pointer = await store.getLatest(pointerExpect.scope as string);
          if (pointer === null) {
            throw new Error(`no latest pointer for ${JSON.stringify(pointerExpect.scope)}`);
          }
          assertJsonEqual(pointer.job_id, pointerExpect.job_id, "latest.job_id");
          assertJsonEqual(pointer.seq, pointerExpect.seq, "latest.seq");
        }
      }
      return;
    }
    case "append_log": {
      if (expect.seq !== undefined) assertJsonEqual(result, expect.seq, "seq");
      return;
    }
    case "advance_latest": {
      const advance = result as { advanced: boolean; pointer: { seq: number } };
      if (expect.advanced !== undefined && advance.advanced !== expect.advanced) {
        throw new Error(`expected advanced=${expect.advanced}, got ${advance.advanced}`);
      }
      if (expect.seq !== undefined) assertJsonEqual(advance.pointer.seq, expect.seq, "seq");
      return;
    }
    case "get_latest": {
      if (!Object.keys(expect).length) return;
      const pointer = result as Record<string, unknown> | null;
      if (!expect.found) {
        if (pointer !== null) {
          throw new Error(`expected no pointer, got ${JSON.stringify(pointer)}`);
        }
        return;
      }
      if (pointer === null) throw new Error("expected pointer, got null");
      for (const key of ["job_id", "seq", "job_type"]) {
        if (expect[key] !== undefined) {
          assertJsonEqual(pointer[key], expect[key], `latest.${key}`);
        }
      }
      return;
    }
    case "list_runs": {
      if (expect.job_ids !== undefined) {
        const jobIds = (result as RunManifest[]).map((r) => r.job_id);
        assertJsonEqual(jobIds, expect.job_ids, "job_ids");
      }
      return;
    }
    default:
      return;
  }
}

export async function runCase(store: DelphiStore, testCase: ConformanceCase): Promise<void> {
  for (let i = 0; i < testCase.ops.length; i++) {
    try {
      await runOp(store, testCase.ops[i]);
    } catch (error) {
      throw new Error(
        `case ${testCase.name}, op ${i} (${testCase.ops[i].op}): ${(error as Error).message}`
      );
    }
  }
}

export function runCodecCase(testCase: ConformanceCase): void {
  for (let i = 0; i < testCase.ops.length; i++) {
    const op = testCase.ops[i];
    try {
      if (op.op === "codec_roundtrip") {
        const value = op.value;
        const enc = encodePayload(value);
        assertJsonEqual(decodePayload(enc.meta, enc.blob), value);
        const forced = encodePayload(value, "json+zstd");
        assertJsonEqual(decodePayload(forced.meta, forced.blob), value);
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((v) => typeof v === "number")
        ) {
          const f64 = encodePayload(new F64(value as number[]));
          const decoded = decodePayload(f64.meta, f64.blob) as number[];
          assertJsonEqual(decoded, value);
        }
      } else if (op.op === "codec_decode_fixture") {
        const blob =
          op.blob_b64 !== undefined && op.blob_b64 !== null
            ? Buffer.from(op.blob_b64 as string, "base64")
            : null;
        const decoded = decodePayload(
          op.meta as { enc: string; [key: string]: unknown },
          blob
        );
        assertJsonEqual(decoded, op.expect_value);
      } else {
        throw new Error(`unknown codec op ${JSON.stringify(op.op)}`);
      }
    } catch (error) {
      throw new Error(
        `case ${testCase.name}, op ${i} (${op.op}): ${(error as Error).message}`
      );
    }
  }
}
