// The only path from the ops pages to the database.
//
// There is no read replica in production, so the read pool is a second pool on
// the primary that serves votes. Every ops statement therefore runs under four
// guards, all local to this module:
//
//   1. One at a time per process. A process-wide mutex admits one ops
//      transaction at a time, so ops holds at most one read-pool connection and
//      a second panel waits for the first.
//   2. A bounded checkout. If the read pool cannot hand out a client within
//      CONNECT_WAIT_MS the panel fails as "pool_busy" instead of queueing
//      behind the vote path's reads.
//   3. A bounded, read-only transaction: BEGIN READ ONLY, statement_timeout
//      3 s, lock_timeout 100 ms, idle_in_transaction_session_timeout 5 s, all
//      SET LOCAL so nothing leaks to the pooled session.
//   4. Closed failure codes. A failure is reported as one of OpsReadReason and
//      never as driver text.
//
// Which index each statement must be able to use is pinned separately, by
// __tests__/integration/ops-activity-index.test.ts.

import type { PoolClient } from "pg";

export const STATEMENT_TIMEOUT_MS = 3000;
export const LOCK_TIMEOUT_MS = 100;
export const CONNECT_WAIT_MS = 3000;

const TRANSACTION_POLICY = [
  `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`,
  `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`,
  "SET LOCAL idle_in_transaction_session_timeout = '5s'",
].join("; ");

export type OpsReadReason =
  | "timeout"
  | "lock_timeout"
  | "pool_busy"
  | "db_error";

export class OpsReadError extends Error {
  readonly reason: OpsReadReason;
  constructor(reason: OpsReadReason) {
    super(`ops_read_${reason}`);
    this.name = "OpsReadError";
    this.reason = reason;
  }
}

export type OpsQuery = <R = Record<string, unknown>>(
  text: string,
  values: unknown[]
) => Promise<R[]>;

type Connect = () => Promise<PoolClient>;

// The read pool is loaded on first use, so importing the ops modules does not
// open or configure a database pool.
const readPoolConnect: Connect = async () =>
  (await import("../db/pg-query")).default.connectReadOnly();

let connectImpl: Connect = readPoolConnect;

// Tests replace the pool checkout; production never calls this.
export function setOpsConnectForTests(connect: Connect | null): void {
  connectImpl = connect || readPoolConnect;
}

let tail: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function classify(err: unknown): OpsReadReason {
  if (err instanceof OpsReadError) return err.reason;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "57014") return "timeout"; // query_canceled (statement_timeout)
  if (code === "55P03") return "lock_timeout"; // lock_not_available
  return "db_error";
}

function checkout(): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new OpsReadError("pool_busy"));
    }, CONNECT_WAIT_MS);
    connectImpl().then(
      (client) => {
        clearTimeout(timer);
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        resolve(client);
      },
      () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new OpsReadError("db_error"));
        }
      }
    );
  });
}

/**
 * Run `work` inside one READ ONLY transaction on one read-pool client, with
 * the guards above. Rejects only with OpsReadError.
 */
export function guardedRead<T>(
  work: (query: OpsQuery) => Promise<T>
): Promise<T> {
  return exclusive(async () => {
    let client: PoolClient;
    try {
      client = await checkout();
    } catch (err) {
      throw new OpsReadError(classify(err));
    }
    let discard = false;
    const onError = () => {
      discard = true;
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(TRANSACTION_POLICY);
      const query: OpsQuery = async (text, values) =>
        (await client.query(text, values)).rows;
      const result = await work(query);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw new OpsReadError(classify(err));
    } finally {
      client.release(discard);
      if (!discard) client.removeListener("error", onError);
    }
  });
}
