import { isFunction, isString, isUndefined } from "underscore";
import { Pool, PoolClient, PoolConfig, QueryResult } from "pg";
import { parse as parsePgConnectionString } from "pg-connection-string";
import QueryStream from "pg-query-stream";

import Config from "../config";
import logger from "../utils/logger";
import { MPromise } from "../utils/metered";

// # DB Connections
//
// heroku pg standard plan has 120 connections
// plus a dev poller connection and a direct db connection
// 3 devs * (2 + 1 + 1) = 12 for devs
// plus the prod and preprod pollers = 14
// round up to 20
// so we can have 25 connections per server, of of which is the preprod server
// so we can have 1 preprod/3 prod servers, or 2 preprod / 2 prod.
const usingReplica = Config.databaseURL !== Config.readOnlyDatabaseURL;
const poolSize = Config.isDevMode ? 2 : usingReplica ? 3 : 12;

// not sure how many of these config options we really need anymore
const pgConnection = Object.assign(
  parsePgConnectionString(Config.databaseURL),
  {
    max: poolSize,
    isReadOnly: false,
    ssl: Config.databaseSSL
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
    poolLog: function (str: string, level: string) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        logger.info("pool.primary." + level + " " + str);
      }
    },
  }
);
const readsPgConnection = Object.assign(
  parsePgConnectionString(Config.readOnlyDatabaseURL),
  {
    max: poolSize,
    isReadOnly: true,
    ssl: Config.databaseSSL
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
    poolLog: function (str: string, level: string) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        logger.info("pool.readonly." + level + " " + str);
      }
    },
  }
);

// split requests into centralized read/write transactor pool vs read pool for scalability concerns in keeping
// pressure down on the transactor (read+write) server

// const PoolConstructor = pgnative?.Pool ?? Pool;
// Cast to unknown first to avoid type errors with port being string vs number
const readWritePool: Pool = new Pool(pgConnection as unknown as PoolConfig);
const readPool: Pool = new Pool(readsPgConnection as unknown as PoolConfig);

// Same syntax as pg.client.query, but uses connection pool
// Also takes care of calling 'done'.
function queryImpl(pool: Pool, queryString: string, ...args: any[]) {
  // variable arity depending on whether or not query has params (default to [])
  let params: any[];
  let callback: ((arg0: any, arg1?: any) => void) | undefined;
  if (isFunction(args[1])) {
    params = args[0];
    callback = args[1];
  } else if (isFunction(args[0])) {
    params = [];
    callback = args[0];
  } else {
    throw "unexpected db query syntax";
  }

  // Not sure whether we have to be this careful in calling release for these query results. There may or may
  // not have been a good reason why Mike did this. If just using pool.query works and doesn't exhibit scale
  // under load, might be worth stripping
  const promise = new Promise((resolve, reject) => {
    pool.connect((err, client, release) => {
      if (err) {
        if (callback) callback(err);
        // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the done() callback
        release(err);
        logger.error("pg_connect_pool_fail", err);
        return reject(err);
      }
      // Anyway, here's the actual query call
      client.query(queryString, params, function (err, results) {
        if (err) {
          // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the release() callback
          release(err);
          if (callback) callback(err);
          return reject(err);
        } else {
          release();
          if (callback) callback(null, results);
          resolve(results.rows);
        }
      });
    });
  });

  // Every caller that supplies a callback receives the failure through it and
  // ignores this promise — queryP_impl below is the largest such caller, so
  // every failing queryP produced a *second*, permanently unobserved rejection
  // in addition to the one it hands its own caller. Marking it handled here
  // stops each failed query from raising a process-level 'unhandledRejection'.
  //
  // The `if (callback)` is a guard on the code below, not a second supported
  // calling convention: the argument parser above throws
  // "unexpected db query syntax" synchronously when no function argument is
  // present, so there is no callback-free path that reaches this line. A
  // caller that awaits the returned promise directly, alongside its callback,
  // still receives the identical rejection — attaching a handler does not
  // consume it for other consumers.
  if (callback) {
    promise.catch(() => {});
  }

  return promise;
}

const pgPoolLevelRanks = ["info", "verbose"]; // TODO investigate
const pgPoolLoggingLevel = -1; // -1 to get anything more important than info and verbose. // pgPoolLevelRanks.indexOf("info");

function query(queryString: string, ...args: any[]) {
  return queryImpl(readWritePool, queryString, ...args);
}

function query_readOnly(queryString: string, ...args: any[]) {
  return queryImpl(readPool, queryString, ...args);
}

function queryP_impl<T>(pool: Pool, queryString?: string, params?: any[]) {
  if (!isString(queryString)) {
    return Promise.reject("query_was_not_string");
  }

  return new Promise(function (resolve, reject) {
    queryImpl(
      pool,
      queryString,
      params,
      function (err: Error | null, result: { rows: T[] }) {
        if (err) {
          return reject(err);
        }
        if (!result || !result.rows) {
          // caller is responsible for testing if there are results
          return resolve([]);
        }
        resolve(result.rows);
      }
    );
  });
}

function queryP<T>(queryString: string, ...args: any[]) {
  return queryP_impl<T>(readWritePool, queryString, ...args);
}

function queryP_readOnly<T>(queryString: string, ...args: any[]) {
  return queryP_impl<T>(readPool, queryString, ...args);
}

function queryP_readOnly_wRetryIfEmpty<T>(queryString: string, ...args: any[]) {
  function retryIfEmpty(rows: T[]) {
    if (!rows.length) {
      return queryP<T>(queryString, ...args);
    }
    return Promise.resolve(rows);
  }

  return queryP_impl<T>(readPool, queryString, ...args).then(
    retryIfEmpty as any
  );
}

function queryP_metered_impl(
  isReadOnly: boolean,
  name?: string,
  queryString?: string,
  params?: any[]
) {
  const f = isReadOnly ? queryP_readOnly : queryP;
  if (isUndefined(name) || isUndefined(queryString) || isUndefined(params)) {
    throw new Error("polis_err_queryP_metered_impl missing params");
  }
  return MPromise(name, function (resolve, reject) {
    f(queryString, params).then(resolve, reject);
  });
}

function queryP_metered(name: string, queryString: string, params: any[]) {
  return queryP_metered_impl(false, name, queryString, params);
}

function queryP_metered_readOnly(
  name: string,
  queryString: string,
  params: any[]
) {
  return queryP_metered_impl(true, name, queryString, params);
}

function stream_queryP_readOnly(
  queryString: string,
  params: any[],
  onRow: (row: any) => void,
  onEnd: () => void,
  onError: (error: Error) => void
) {
  const query = new QueryStream(queryString, params);

  readPool.connect((err, client, done) => {
    if (err) {
      onError(err);
      return;
    }

    const stream = client.query(query);

    stream.on("data", (row: QueryResult) => {
      onRow(row);
    });

    stream.on("end", () => {
      done();
      onEnd();
    });

    stream.on("error", (error: Error) => {
      done(error);
      onError(error);
    });
  });
}

function connect() {
  // Returns a Promise that resolves to a raw PoolClient.
  // The client will have a .release() method on it.
  return readWritePool.connect();
}

// Session policy applied immediately after BEGIN, from
// cost-reduction/04-plans/P-024-queue-substrate.md. These are declared initial
// bounds for the queue substrate, not a general-purpose transaction profile;
// changing them is a pinned contract change with its own tests.
//
// transaction_timeout only exists on PostgreSQL 17, so it is set through
// set_config() behind a server-version guard: on an older server the target
// list is never evaluated and the SET is simply skipped, rather than aborting
// the transaction with "unrecognized configuration parameter".
const TRANSACTION_SESSION_POLICY = `SET LOCAL TIME ZONE 'UTC';
   SET LOCAL lock_timeout = '500ms';
   SET LOCAL statement_timeout = '5s';
   SET LOCAL idle_in_transaction_session_timeout = '5s';
   SELECT set_config('transaction_timeout', '10s', true)
     WHERE current_setting('server_version_num')::int >= 170000`;

/**
 * A COMMIT that did not report success. The transaction may or may not be
 * durable: a lost acknowledgement is unknown, never proof of rollback. Callers
 * must resolve it by reading authoritative state back under the original
 * request identity, not by assuming either outcome.
 */
export class CommitOutcomeUnknownError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("transaction_commit_outcome_unknown");
    this.name = "CommitOutcomeUnknownError";
    this.cause = cause;
  }
}

/**
 * Run `callback` inside one transaction on one pinned readWritePool client.
 *
 * Every read and write that must be atomic with the callback's writes has to go
 * through the client passed in. queryP / queryP_readOnly acquire and release
 * their own connection per statement, so a statement issued through them is a
 * different session and is NOT part of this transaction, idempotency and
 * read-back checks included.
 *
 * No network call, upload, child-process execution or other long work belongs
 * inside the callback: the session policy above bounds how long the transaction
 * may hold its locks.
 *
 * Three failure modes are handled explicitly, because each of them can
 * otherwise be mistaken for success:
 *
 *   * The backend can die, or the socket can drop, while the callback is
 *     between queries. A borrowed pg client emits that on its own "error"
 *     event; with no listener attached it escapes as an unhandled EventEmitter
 *     error. It is captured here, fails the transaction, and discards the
 *     client.
 *   * A callback that catches a statement error and continues leaves the
 *     transaction aborted, and PostgreSQL then answers COMMIT with a ROLLBACK
 *     command tag. Returning normally there would report a write that did not
 *     happen, so the command tag is checked.
 *   * A failure raised by COMMIT itself is rethrown as
 *     CommitOutcomeUnknownError, and that client is discarded rather than
 *     pooled.
 *
 * A client whose transaction state is unknown is never handed back to the pool.
 */
async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client: PoolClient = await connect();
  let discard = false;
  let committing = false;
  let connectionError: Error | undefined;
  const onClientError = (error: Error) => {
    connectionError = error;
    discard = true;
  };
  client.on("error", onClientError);
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(TRANSACTION_SESSION_POLICY);
    const result = await callback(client);
    if (connectionError) throw connectionError;
    committing = true;
    const commit = await client.query("COMMIT");
    committing = false;
    if (commit.command !== "COMMIT") {
      throw new Error("transaction_was_aborted");
    }
    return result;
  } catch (err) {
    discard = discard || committing;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("pg_transaction_rollback_failed", rollbackErr);
      discard = true;
    }
    if (committing) throw new CommitOutcomeUnknownError(err);
    throw err;
  } finally {
    client.release(discard);
    // A discarded client may still emit a socket error asynchronously, so it
    // keeps its listener. A healthy pooled client is handed back clean.
    if (!discard) client.removeListener("error", onClientError);
  }
}

export default {
  query,
  query_readOnly,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty,
  stream_queryP_readOnly,
  connect,
  withTransaction,
};
