import Config from "../config";
/** One publication snapshot for every PostgreSQL result read in an HTTP request. */
import { AsyncLocalStorage } from "async_hooks";
import { RequestHandler } from "express";
import { PoolClient } from "pg";
import pg from "../db/pg-query";
import logger from "./logger";

type Snapshot = { client?: Promise<PoolClient>; closed: boolean; failure?: Error; onError?: (error: Error) => void };
const snapshots = new AsyncLocalStorage<Snapshot>();

export const delphiResultSnapshot: RequestHandler = (_req, res, next) => {
  if (Config.delphiResultBackend !== "postgres") return next();
  const snapshot: Snapshot = { closed: false };
  const close = () => {
    if (snapshot.closed) return;
    snapshot.closed = true;
    if (!snapshot.client) return;
    void snapshot.client.then(async client => {
      let failure: Error | undefined = snapshot.failure;
      try { await client.query("ROLLBACK"); }
      catch (error) { failure = error as Error; logger.error("delphi_result_snapshot_close", error); }
      finally {
        client.release(failure);
        if (!failure && snapshot.onError) client.removeListener("error", snapshot.onError);
      }
    }, () => { /* Failed setup already released its client. */ });
  };
  res.once("finish", close);
  res.once("close", close);
  snapshots.run(snapshot, next);
};

/** Primary connection: replicas may lag a newly published result pointer. */
export async function resultQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const snapshot = snapshots.getStore();
  if (!snapshot) return pg.queryP<T>(sql, params) as Promise<T[]>;
  if (snapshot.closed) throw new Error("Delphi result request has closed");
  if (snapshot.failure) throw snapshot.failure;
  if (!snapshot.client) snapshot.client = pg.connectResultSnapshot().then(async client => {
    snapshot.onError = error => { snapshot.failure = error; };
    client.on("error", snapshot.onError);
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'; SET LOCAL idle_in_transaction_session_timeout = '30s'");
      return client;
    } catch (error) {
      client.release(error as Error);
      // Discarded sockets may still emit an asynchronous error.
      throw error;
    }
  });
  const client = await snapshot.client;
  if (snapshot.failure) throw snapshot.failure;
  return (await client.query(sql, params)).rows as T[];
}
