/**
 * P-024 Postgres queue substrate, first slice: dev/test-only noop enqueue.
 *
 * This module is the only Node code that calls the queue schema installed by
 * server/postgres/migrations/000019_create_polis_queue.sql. It is deliberately
 * not reachable from any route: nothing under src/routes imports it, and
 * src/routes/delphi/jobs.ts is untouched. Wiring a real route would route real
 * work, which this slice must not do. Its callers are the integration test and
 * local experiments.
 *
 * Three guards, all required:
 *   1. Config.queueSubstrateEnabled (POLIS_QUEUE_SUBSTRATE_ENABLED), default
 *      off and forced off when NODE_ENV is production.
 *   2. The env namespace must be dev or test, so a synthetic job cannot be
 *      addressed at some other environment's product heads.
 *   3. The migration must have been applied. It is not applied automatically to
 *      an existing database; see docs/queue-substrate.md.
 *
 * What this is NOT, yet:
 *   - It does not run under the fenced polis_queue_executor role. The server
 *     connects with its existing broad read-write login, so the grant boundary
 *     in the migration is real in the database but is not what constrains this
 *     caller. A dedicated service login with executor membership is separate,
 *     separately reviewed provisioning work. The Python executor does require
 *     the restricted login.
 *   - The input descriptor is fixed and synthetic, and is built here rather
 *     than accepted from the caller. /1 enqueue pins expected_output_uri and
 *     expected_output_sha256 to that descriptor, and the noop stage returns it
 *     unchanged. Admitting a real captured artifact is Q21 plus a reviewed
 *     migration widening the stage CHECK.
 */
import { createHash, randomUUID } from "node:crypto";
import { PoolClient } from "pg";

import Config from "../config";
import pgQuery, { CommitOutcomeUnknownError } from "../db/pg-query";
import {
  assertOrdinaryResult,
  QUEUE_CONTRACT_VERSION,
  QUEUE_STAGE,
  QueueOrdinaryResult,
  QueueProtocolError,
} from "./protocol";

export const QUEUE_SUBSTRATE_FLAG = "POLIS_QUEUE_SUBSTRATE_ENABLED";

/**
 * The fixed synthetic input descriptor of the /1 noop stage. Not caller
 * supplied: the enqueuer pins it, and the executor refuses any job whose
 * descriptor differs.
 */
export const NOOP_INPUT_URI = "synthetic:polis-queue-noop/1";
export const NOOP_INPUT_SHA256 = createHash("sha256")
  .update("polis-queue-noop/1\n")
  .digest("hex");
export const NOOP_IMAGE_DIGEST = "synthetic-noop/1";

/** dev or test, optionally suffixed for per-run isolation in tests. */
const ENV_NAMESPACE = /^(dev|test)(-[a-z0-9][a-z0-9-]{0,48})?$/;

/** Transient SQLSTATEs the design document admits for a bounded retry. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);
const MAX_TRANSACTION_RETRIES = 3;

export type EnqueueOutcome = "enqueued" | "existing" | "conflict";

export interface NoopEnqueueRequest {
  /** Queue environment namespace: dev, test, or a suffix of either. */
  env: string;
  /** Existing conversations.zid. pq_enqueue takes FOR KEY SHARE on it. */
  zid: number;
  /** Opaque logical output slot; one conversation per product_key. */
  productKey: string;
  /** Authorization scope of the producer, authenticated before this call. */
  actorScope: string;
  /** Idempotency key within (env, actorScope, productKey). */
  requestKey: string;
  /** 0 is most urgent. Defaults to 1. */
  priority?: number;
  /** Budgeted claims including the first, 1..100. Defaults to 3. */
  maxAttempts?: number;
}

export interface NoopEnqueueOutcome {
  outcome: EnqueueOutcome;
  /** Digest this call computed over the canonical request. */
  requestSha256: string;
  /** IDs this call minted. On existing/conflict the result names the originals. */
  mintedRunId: string;
  mintedJobId: string;
  result: QueueOrdinaryResult;
}

function assertEnabled(): void {
  if (!Config.queueSubstrateEnabled) {
    throw new Error(
      `polis queue substrate is disabled; set ${QUEUE_SUBSTRATE_FLAG}=true outside ` +
        "production to use it. It is a dev/test facility: no route calls it and " +
        "no worker runs by default."
    );
  }
}

/**
 * Digest of the canonical request. The producer computes it; it never accepts a
 * caller-supplied digest, because the digest is what separates an exact replay
 * ("existing") from a changed request reusing a key ("conflict").
 *
 * Every semantic input is covered: the request identity, the captured
 * input/config/image descriptor, the stage and the retry policy. Field order is
 * fixed here rather than taken from object insertion order.
 */
export function canonicalRequestDigest(request: NoopEnqueueRequest): string {
  const canonical = JSON.stringify([
    QUEUE_CONTRACT_VERSION,
    request.env,
    request.zid,
    request.productKey,
    request.actorScope,
    request.requestKey,
    QUEUE_STAGE,
    NOOP_INPUT_URI,
    NOOP_INPUT_SHA256,
    NOOP_INPUT_SHA256,
    NOOP_IMAGE_DIGEST,
    request.priority ?? 1,
    request.maxAttempts ?? 3,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const ENQUEUE_SQL =
  "SELECT public.pq_enqueue($1::text,$2::integer,$3::text,$4::text,$5::text,$6::text," +
  "$7::uuid,$8::uuid,$9::text,$10::text,$11::text,$12::text,$13::smallint,$14::integer) AS result";

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof CommitOutcomeUnknownError ||
    RETRYABLE_SQLSTATES.has(sqlState(error) ?? "")
  );
}

/**
 * The deterministic backoff family the design document specifies for bounded
 * transaction retries, in milliseconds, keyed on the minted job id so two
 * concurrent producers do not retry in lockstep.
 */
function retryDelayMs(attempt: number, jobId: string): number {
  const jitter = parseInt(jobId.slice(-2), 16) % 5;
  return (Math.min(300, 5 * 2 ** attempt) + jitter) * 1000;
}

/**
 * Enqueue one noop job, atomically with its request reservation, run row and
 * desired-head advance. Repeating the call with the same key and an unchanged
 * request returns the original job ("existing"); the same key with a changed
 * request returns "conflict" and changes nothing.
 *
 * The whole call is one transaction on one pinned client. Do not add a
 * queryP/queryP_readOnly call to this flow: those run on a different session
 * and would not be part of the transaction.
 *
 * A transient failure, including a COMMIT whose outcome is unknown, is retried
 * at most three times with the SAME request key, digest and minted UUIDs, so a
 * retry after a lost acknowledgement returns the original job rather than
 * creating a second one. Exhaustion rethrows the typed error; an unknown COMMIT
 * outcome is never reported as a rollback.
 */
export async function enqueueNoopJob(
  request: NoopEnqueueRequest
): Promise<NoopEnqueueOutcome> {
  assertEnabled();
  if (!ENV_NAMESPACE.test(request.env)) {
    throw new Error(
      `env must be "dev" or "test", optionally suffixed (got ${JSON.stringify(
        request.env
      )})`
    );
  }
  if (
    !Number.isSafeInteger(request.zid) ||
    request.zid <= 0 ||
    request.zid > 2147483647
  ) {
    throw new Error("zid must be a positive 32-bit integer");
  }
  for (const [name, value] of [
    ["productKey", request.productKey],
    ["actorScope", request.actorScope],
    ["requestKey", request.requestKey],
  ] as const) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {
      throw new Error(`${name} must be a string of length 1..256`);
    }
  }
  const priority = request.priority ?? 1;
  const maxAttempts = request.maxAttempts ?? 3;
  if (![0, 1, 2].includes(priority)) {
    throw new Error("priority must be 0, 1 or 2 (0 is most urgent)");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("maxAttempts must be an integer in 1..100");
  }

  const requestSha256 = canonicalRequestDigest(request);
  const mintedRunId = randomUUID();
  const mintedJobId = randomUUID();
  const args = [
    request.env,
    request.zid,
    request.productKey,
    request.actorScope,
    request.requestKey,
    requestSha256,
    mintedRunId,
    mintedJobId,
    NOOP_INPUT_URI,
    NOOP_INPUT_SHA256,
    NOOP_INPUT_SHA256,
    NOOP_IMAGE_DIGEST,
    priority,
    maxAttempts,
  ];

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await pgQuery.withTransaction(
        async (client: PoolClient) => {
          const reply = await client.query(ENQUEUE_SQL, args);
          const value = assertOrdinaryResult(reply.rows[0]?.result);
          if (
            value.outcome !== "enqueued" &&
            value.outcome !== "existing" &&
            value.outcome !== "conflict"
          ) {
            throw new QueueProtocolError(
              `unexpected pq_enqueue outcome ${value.outcome}`
            );
          }
          if (
            typeof value.job_id !== "string" ||
            typeof value.run_id !== "string"
          ) {
            throw new QueueProtocolError("enqueue reply has no job identity");
          }
          return value;
        }
      );
      return {
        outcome: result.outcome as EnqueueOutcome,
        requestSha256,
        mintedRunId,
        mintedJobId,
        result,
      };
    } catch (err) {
      if (attempt >= MAX_TRANSACTION_RETRIES || !isRetryable(err)) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs(attempt, mintedJobId))
      );
    }
  }
}

export default { enqueueNoopJob, canonicalRequestDigest };
