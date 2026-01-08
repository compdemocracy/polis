import { isFunction, isString, isUndefined } from "underscore";
import { Pool, PoolConfig, QueryResult } from "pg";
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
  return new Promise((resolve, reject) => {
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
};
