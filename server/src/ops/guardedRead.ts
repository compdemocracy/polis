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
//   5. A client-side clock. statement_timeout is enforced by the server; if the
//      server's answer never arrives (a dropped connection, a network black
//      hole) the server-side timeout cannot help, and without a client-side
//      bound the mutex in 1 would be held forever. So every statement carries
//      pg's query_timeout (CLIENT_QUERY_TIMEOUT_MS), and the whole transaction
//      has a deadline (TRANSACTION_DEADLINE_MS). Either one firing reports
//      "timeout", destroys the client instead of returning it to the pool
//      (its protocol state is unknown) and frees the mutex.
//
// Which index each statement must be able to use is pinned separately, by
// __tests__/integration/ops-activity-index.test.ts.

import type { PoolClient } from "pg";

export const STATEMENT_TIMEOUT_MS = 3000;
export const LOCK_TIMEOUT_MS = 100;
export const CONNECT_WAIT_MS = 3000;
// The server cancels a statement at STATEMENT_TIMEOUT_MS; the client gives up
// waiting for any answer two seconds later.
export const CLIENT_QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 2000;
// No ops transaction runs longer than this, however many statements it has.
export const TRANSACTION_DEADLINE_MS = 12000;

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

// pg's own message when query_timeout fires; it carries no SQLSTATE.
const PG_READ_TIMEOUT = "Query read timeout";

function isClientTimeout(err: unknown): boolean {
  return (err as { message?: unknown } | null)?.message === PG_READ_TIMEOUT;
}

/**
 * Run `work` inside one READ ONLY transaction on one read-pool client, with
 * the guards above. Rejects only with OpsReadError.
 */
export function guardedRead<T>(
  work: (query: OpsQuery) => Promise<T>
): Promise<T> {
  return exclusive(() => {
    // Shared between the transaction and its deadline, so exactly one of them
    // returns the client and the other sees that it is gone.
    const held: {
      client?: PoolClient;
      released: boolean;
      discard: boolean;
      expired: boolean;
    } = { released: false, discard: false, expired: false };
    const release = () => {
      if (!held.client || held.released) return;
      held.released = true;
      held.client.release(held.discard);
    };

    const transaction = (async () => {
      let client: PoolClient;
      try {
        client = await checkout();
      } catch (err) {
        throw new OpsReadError(classify(err));
      }
      if (held.expired) {
        // The deadline passed while waiting for the pool.
        client.release();
        throw new OpsReadError("timeout");
      }
      held.client = client;
      const onError = () => {
        held.discard = true;
      };
      client.on("error", onError);
      const run = async (text: string, values?: unknown[]) => {
        if (held.expired || held.released) throw new OpsReadError("timeout");
        try {
          return await client.query({
            text,
            values,
            query_timeout: CLIENT_QUERY_TIMEOUT_MS,
          } as any);
        } catch (err) {
          if (isClientTimeout(err)) {
            held.discard = true;
            throw new OpsReadError("timeout");
          }
          throw err;
        }
      };
      try {
        await run("BEGIN READ ONLY");
        await run(TRANSACTION_POLICY);
        const query: OpsQuery = async (text, values) =>
          (await run(text, values)).rows;
        const result = await work(query);
        await run("COMMIT");
        return result;
      } catch (err) {
        // After a client-side timeout the connection's state is unknown:
        // do not wait on a ROLLBACK, destroy it.
        if (!held.discard && !held.released) {
          try {
            await run("ROLLBACK");
          } catch {
            held.discard = true;
          }
        }
        throw new OpsReadError(classify(err));
      } finally {
        if (!held.discard) client.removeListener("error", onError);
        release();
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        held.expired = true;
        held.discard = true;
        release();
        reject(new OpsReadError("timeout"));
      }, TRANSACTION_DEADLINE_MS);
    });
    // The losing side of the race must not surface as an unhandled rejection.
    transaction.catch(() => undefined);
    return Promise.race([transaction, deadline]).finally(() =>
      clearTimeout(timer)
    );
  });
}
