/** PostgreSQL result reads: one short snapshot per read, never per request.
 *
 * A DynamoDB Query, Scan or Get sees every write committed before it starts,
 * so each adapter call runs in its own REPEATABLE READ READ ONLY transaction
 * (its statements share one publication) and returns the connection as soon
 * as that call ends. Nothing is held across a request's other work, such as a
 * model call, and a read that follows a write in the same request sees it. */
import { PoolClient } from "pg";
import pg from "../db/pg-query";

export type ResultQuery = <T = any>(sql: string, params?: any[]) => Promise<T[]>;

/** Primary connection: replicas may lag a newly published result pointer. */
export async function withResultSnapshot<R>(read: (query: ResultQuery) => Promise<R>): Promise<R> {
  const client: PoolClient = await pg.connectResultSnapshot();
  let failure: Error | undefined;
  const onError = (error: Error) => { failure = error; };
  // A discarded socket may still emit an asynchronous error.
  client.on("error", onError);
  const query: ResultQuery = async <T>(sql: string, params?: any[]) => {
    if (failure) throw failure;
    return (await client.query(sql, params)).rows as T[];
  };
  let release: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'; SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const result = await read(query);
    if (failure) throw failure;
    return result;
  } catch (error) {
    // A failed statement leaves a healthy connection; a failed socket does not.
    release = failure;
    throw error;
  } finally {
    if (!release) {
      try { await client.query("ROLLBACK"); } catch (error) { release = error as Error; }
    }
    if (!release) client.removeListener("error", onError);
    client.release(release);
  }
}

/** One statement in its own snapshot. */
export function resultQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  return withResultSnapshot(query => query<T>(sql, params));
}
