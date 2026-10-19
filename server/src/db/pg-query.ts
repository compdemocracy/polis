import { isFunction, isString, isUndefined } from "underscore";
import { Pool, PoolClient, PoolConfig, QueryResult } from "pg";
import { parse as parsePgConnectionString } from "pg-connection-string";
import QueryStream from "pg-query-stream";

import Config from "../config";
import logger from "../utils/logger";
import { MPromise } from "../utils/metered";
import { onParticipationPath } from "./participation-scope";

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

// Which pool a Pool is, for tests and diagnostics. Every pool below registers
// itself here when it is created.
export type PoolRole =
  | "participation"
  | "participation-read"
  | "read-write"
  | "read"
  | "result-snapshot"
  | "report-export"
  | "agent-exchange";
const poolRoles = new WeakMap<Pool, PoolRole>();
function withRole(pool: Pool, role: PoolRole): Pool {
  poolRoles.set(pool, role);
  return pool;
}
export function poolRole(pool: Pool): PoolRole | undefined {
  return poolRoles.get(pool);
}

// The read-write and read pools serve everything except the four participation
// routes, which have pools of their own below. Participant-facing requests still
// run here (the opinion map, the comment list, GET /votes, topic selection), so
// neither pool has an acquire timeout or a statement timeout: a participant's
// request that has to wait for a connection waits and is answered; it is never
// refused. Slow work belongs on the pools further down (reports and exports,
// Delphi result reads, the agent exchange), which keep their own bounds and
// degrade themselves first. main-pool-timeouts.test.ts holds this placement.
export const MAIN_POOL_MAX = poolSize;

// const PoolConstructor = pgnative?.Pool ?? Pool;
// Cast to unknown first to avoid type errors with port being string vs number
const readWritePool: Pool = withRole(
  new Pool(pgConnection as unknown as PoolConfig),
  "read-write"
);
const readPool: Pool = withRole(
  new Pool(readsPgConnection as unknown as PoolConfig),
  "read"
);

// A read-write pool and the read pool that goes with it: what every query
// helper below issues its statement on.
type PoolPair = { readonly readWrite: Pool; readonly read: Pool };
const sharedPools: PoolPair = { readWrite: readWritePool, read: readPool };

// The participation pools. Votes, comments, the next statement and
// participationInit run here and nothing else does, so no other work can hold
// the connections a vote needs. Same databases as the pair above: the primary,
// and the read replica when READ_ONLY_DATABASE_URL names one (otherwise the
// primary again). Sized like that pair unless PARTICIPATION_POOL_MAX and
// PARTICIPATION_READ_POOL_MAX say otherwise.
//
// A participation query waits for a connection; it is never refused under
// load. Only participation work holds these connections, each for
// milliseconds, so a wait as long as PARTICIPATION_ACQUIRE_TIMEOUT_MS (60 s by
// default, six times the participation client's 10 s request timeout) means
// the database has stopped answering: the bound is there to surface that as an
// error instead of an ever-growing queue, never to shed votes. There is no
// statement timeout on these pools; the transactions that need one set their
// own with SET LOCAL (withTransaction below, the participant insert's
// lock_timeout in participant.ts).
export const PARTICIPATION_POOL_MAX = Config.participationPoolMax ?? poolSize;
export const PARTICIPATION_READ_POOL_MAX =
  Config.participationReadPoolMax ?? poolSize;
export const PARTICIPATION_ACQUIRE_TIMEOUT_MS =
  Config.participationAcquireTimeoutMs;
let participationPools: PoolPair | undefined;
function participationPoolsInstance(): PoolPair {
  if (!participationPools) {
    const readWrite = withRole(
      new Pool({
        ...pgConnection,
        max: PARTICIPATION_POOL_MAX,
        connectionTimeoutMillis: PARTICIPATION_ACQUIRE_TIMEOUT_MS,
      } as unknown as PoolConfig),
      "participation"
    );
    const read = withRole(
      new Pool({
        ...readsPgConnection,
        max: PARTICIPATION_READ_POOL_MAX,
        connectionTimeoutMillis: PARTICIPATION_ACQUIRE_TIMEOUT_MS,
      } as unknown as PoolConfig),
      "participation-read"
    );
    readWrite.on("error", (error) =>
      logger.error("pg_participation_pool", error)
    );
    read.on("error", (error) =>
      logger.error("pg_participation_read_pool", error)
    );
    participationPools = { readWrite, read };
  }
  return participationPools;
}

// The pair a query uses: the participation pools for work that came through a
// participation route (db/participation-scope.ts), the pair above for
// everything else. Nothing outside that scope can reach the participation
// pools, and nothing inside it is given another pair.
function pools(): PoolPair {
  return onParticipationPath() ? participationPoolsInstance() : sharedPools;
}

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
        // A failed or timed-out acquire (e.g. the report/export pool rejecting
        // when it is full) calls back with no client and no release function, so
        // only release a real client — passing the error so the pool discards
        // it. Calling an undefined release here used to throw a TypeError that
        // masked the real connection error.
        if (typeof release === "function") release(err);
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
  return queryImpl(pools().readWrite, queryString, ...args);
}

function query_readOnly(queryString: string, ...args: any[]) {
  return queryImpl(pools().read, queryString, ...args);
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
  return queryP_impl<T>(pools().readWrite, queryString, ...args);
}

function queryP_readOnly<T>(queryString: string, ...args: any[]) {
  return queryP_impl<T>(pools().read, queryString, ...args);
}

function queryP_readOnly_wRetryIfEmpty<T>(queryString: string, ...args: any[]) {
  function retryIfEmpty(rows: T[]) {
    if (!rows.length) {
      return queryP<T>(queryString, ...args);
    }
    return Promise.resolve(rows);
  }

  return queryP_impl<T>(pools().read, queryString, ...args).then(
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

  pools().read.connect((err, client, done) => {
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
  return pools().readWrite.connect();
}

// A raw client from the read pool (the replica when READ_ONLY_DATABASE_URL is
// set, otherwise a second pool on the primary). The caller must release it.
// Used by the ops pages (src/ops/guardedRead.ts), which run one bounded
// READ ONLY transaction per checkout.
function connectReadOnly() {
  return pools().read.connect();
}

// Delphi result reads take one short read-only snapshot per DynamoDB-shaped
// call (utils/delphiResultSnapshot.ts) and return it when that call ends, so a
// connection is held for milliseconds, never across a request's model calls.
// A separate pool keeps result reads and the primary pool from starving each
// other. On the participation path (nextComment's topical routing, one read per
// selected topic) the snapshot is taken on the participation read-write pool
// instead, the same primary, so no result read elsewhere can make it wait.
export const RESULT_SNAPSHOT_POOL_MAX = Config.isDevMode ? 4 : 8;
let resultSnapshotPool: Pool | undefined;
function connectResultSnapshot() {
  if (onParticipationPath()) return participationPoolsInstance().readWrite.connect();
  if (!resultSnapshotPool) {
    resultSnapshotPool = withRole(new Pool({
      ...pgConnection, max: RESULT_SNAPSHOT_POOL_MAX, connectionTimeoutMillis: 30000,
    } as unknown as PoolConfig), "result-snapshot");
    resultSnapshotPool.on("error", error => logger.error("pg_result_snapshot_pool", error));
  }
  return resultSnapshotPool.connect();
}

// Reports, data exports and heavy admin reads run on their own small pool so
// they can never take the connections the rest of the server needs (the
// participation path has pools of its own, above). The pool is
// intentionally small and bounded two ways: when it is full a new report/export
// is rejected after REPORT_EXPORT_ACQUIRE_TIMEOUT_MS (connectionTimeoutMillis)
// instead of waiting on, or spilling into, a participation connection, and every
// statement is capped at REPORT_EXPORT_STATEMENT_TIMEOUT_MS. It targets the same
// database as the read pool (the replica when one is configured, otherwise the
// primary); the isolation is the connection count per process, not the host.
// Participation reads never use this pool.
export const REPORT_EXPORT_POOL_MAX = Config.reportExportPoolMax;
const REPORT_EXPORT_ACQUIRE_TIMEOUT_MS = Config.reportExportAcquireTimeoutMs;
const REPORT_EXPORT_STATEMENT_TIMEOUT_MS = Config.reportExportStatementTimeoutMs;
let reportExportPool: Pool | undefined;
function reportExportPoolInstance(): Pool {
  if (!reportExportPool) {
    const pool = withRole(new Pool({
      ...readsPgConnection,
      max: REPORT_EXPORT_POOL_MAX,
      connectionTimeoutMillis: REPORT_EXPORT_ACQUIRE_TIMEOUT_MS,
    } as unknown as PoolConfig), "report-export");
    // statement_timeout is a session setting, so it is applied once as each
    // physical connection is created. A streamed export reads its cursor in
    // small batches, each its own command, so this caps a single runaway
    // statement rather than a long legitimate stream.
    pool.on("connect", client => {
      client
        .query(`SET statement_timeout = ${REPORT_EXPORT_STATEMENT_TIMEOUT_MS}`)
        .catch(error =>
          logger.error("pg_report_export_statement_timeout", error)
        );
    });
    pool.on("error", error => logger.error("pg_report_export_pool", error));
    reportExportPool = pool;
  }
  return reportExportPool;
}

// A pooled read on the report/export pool. Same shape as queryP_readOnly; the
// only difference is the pool, so nothing that votes/comments/nextComment use is
// touched.
function queryP_reportExport<T>(queryString: string, ...args: any[]) {
  return queryP_impl<T>(reportExportPoolInstance(), queryString, ...args);
}

// True for the error pg-pool gives when no connection came free within the
// pool's acquire timeout (connectionTimeoutMillis): the pool is full, not
// broken, and the same request can succeed once the work holding it finishes.
function isPoolAcquireTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === "timeout exceeded when trying to connect"
  );
}

// A streamed read on the report/export pool (the whole-conversation vote
// matrices). Mirrors stream_queryP_readOnly but on the bounded export pool.
//
// When the HTTP client disconnects mid-stream, the cursor is closed and the
// connection released promptly, so a stalled or aborted export cannot hold one
// of the few report/export connections until the whole conversation has been
// read. Pass `res` (the HTTP response) to arm this; the success-path output is
// byte-for-byte unchanged whether or not it is passed.
function stream_queryP_reportExport(
  queryString: string,
  params: any[],
  onRow: (row: any) => void,
  onEnd: () => void,
  onError: (error: Error) => void,
  res?: {
    on?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
  }
) {
  const query = new QueryStream(queryString, params);

  reportExportPoolInstance().connect((err, client, done) => {
    if (err) {
      onError(err);
      return;
    }

    // Release the pooled connection at most once, whichever of normal end,
    // error or client-disconnect happens first.
    let released = false;
    const release = (error?: Error) => {
      if (released) return;
      released = true;
      done(error);
    };

    const stream = client.query(query);

    // If the HTTP client disconnects, stop fetching and close the cursor. The
    // connection is released on the stream's "close" event below, once the
    // cursor has actually closed, so the pooled client is clean for reuse.
    let clientDisconnected = false;
    let onClientClose: (() => void) | undefined;
    const disarmClientClose = () => {
      if (onClientClose && res && typeof res.removeListener === "function") {
        res.removeListener("close", onClientClose);
      }
    };
    if (res && typeof res.on === "function") {
      onClientClose = () => {
        if (released || clientDisconnected) return;
        clientDisconnected = true;
        stream.destroy();
      };
      res.on("close", onClientClose);
    }

    stream.on("data", (row: QueryResult) => {
      onRow(row);
    });

    stream.on("end", () => {
      disarmClientClose();
      release();
      onEnd();
    });

    stream.on("error", (error: Error) => {
      disarmClientClose();
      release(error);
      // A disconnect-triggered destroy can surface here as an error; the client
      // is already gone, so there is nothing to report back to it.
      if (!clientDisconnected) {
        onError(error);
      }
    });

    // Fires after the cursor has closed following a client-disconnect destroy.
    // On normal end/error the connection is already released above, so the
    // guard makes this a no-op then.
    stream.on("close", () => {
      if (clientDisconnected) {
        release();
      }
    });
  });
}

// The collective-statement agent path (an owner exporting a topic's inputs and
// importing a statement written outside the server) runs on its own small
// primary pool, so it can never take a connection the rest of the server needs
// (the participation path has pools of its own, above). When both connections
// are busy a new request is refused after AGENT_EXCHANGE_ACQUIRE_TIMEOUT_MS
// instead of waiting on, or spilling into, another pool, and every statement is
// capped at AGENT_EXCHANGE_STATEMENT_TIMEOUT_MS. It is the primary, not the
// replica: an import re-derives the inputs its export saw, checks ownership
// and publishes in one transaction. Result-family reads still go through the
// per-call result snapshots of utils/delphiResultSnapshot.ts.
export const AGENT_EXCHANGE_POOL_MAX = 2;
const AGENT_EXCHANGE_ACQUIRE_TIMEOUT_MS = 5000;
const AGENT_EXCHANGE_STATEMENT_TIMEOUT_MS = 60000;
let agentExchangePool: Pool | undefined;
function agentExchangePoolInstance(): Pool {
  if (!agentExchangePool) {
    const pool = withRole(new Pool({
      ...pgConnection,
      max: AGENT_EXCHANGE_POOL_MAX,
      connectionTimeoutMillis: AGENT_EXCHANGE_ACQUIRE_TIMEOUT_MS,
    } as unknown as PoolConfig), "agent-exchange");
    pool.on("connect", client => {
      client
        .query(`SET statement_timeout = ${AGENT_EXCHANGE_STATEMENT_TIMEOUT_MS}`)
        .catch(error => logger.error("pg_agent_exchange_statement_timeout", error));
    });
    pool.on("error", error => logger.error("pg_agent_exchange_pool", error));
    agentExchangePool = pool;
  }
  return agentExchangePool;
}
function queryP_agentExchange<T>(queryString: string, ...args: any[]) {
  return queryP_impl<T>(agentExchangePoolInstance(), queryString, ...args);
}
// A raw client from the agent-exchange pool. The caller must release it.
function connectAgentExchange(): Promise<PoolClient> {
  return agentExchangePoolInstance().connect();
}

// Session policy applied immediately after BEGIN, taken from the queue
// substrate's design. These are declared initial
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
 * Run `callback` inside one transaction on one pinned read-write client (the
 * participation pool's on the participation path).
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
  queryP_reportExport,
  queryP_agentExchange,
  isPoolAcquireTimeout,
  stream_queryP_readOnly,
  stream_queryP_reportExport,
  connect,
  connectReadOnly,
  connectResultSnapshot,
  connectAgentExchange,
  withTransaction,
};
