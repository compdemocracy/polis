// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { isFunction, isString, isUndefined } from "underscore";
import { native as pgnative, Pool, PoolConfig } from "pg";
import {
  ConnectionOptions,
  parse as parsePgConnectionString,
} from "pg-connection-string";
import QueryStream from "pg-query-stream";
import Config from "../config";
import logger from "../utils/logger";
import { MPromise } from "../utils/metered";

type SQLParam = string | number | boolean | Date | null;
type QueryCallback<T> = (err: Error | null, results: { rows: T[] }) => void;

const usingReplica = Config.databaseURL !== Config.readOnlyDatabaseURL;
const poolSize = Config.isDevMode ? 2 : usingReplica ? 3 : 12;

const pgConnection: ConnectionOptions = Object.assign(
  parsePgConnectionString(Config.databaseURL),
  {
    max: poolSize,
    isReadOnly: false,
    poolLog: function (str: string, level: string) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        logger.info("pool.primary." + level + " " + str);
      }
    },
  }
);

const readsPgConnection: ConnectionOptions = Object.assign(
  parsePgConnectionString(Config.readOnlyDatabaseURL),
  {
    max: poolSize,
    isReadOnly: true,
    poolLog: function (str: string, level: string) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        logger.info("pool.readonly." + level + " " + str);
      }
    },
  }
);

const PoolConstructor = pgnative?.Pool ?? Pool;
const readWritePool: Pool = new PoolConstructor(pgConnection as PoolConfig);
const readPool: Pool = new PoolConstructor(readsPgConnection as PoolConfig);

function queryImpl<T>(
  pool: Pool,
  queryString: string,
  ...args: [(SQLParam[] | QueryCallback<T>)?, QueryCallback<T>?]
): Promise<T[]> {
  let params: SQLParam[];
  let callback: QueryCallback<T>;
  if (isFunction(args[1])) {
    params = args[0] as SQLParam[];
    callback = args[1];
  } else if (isFunction(args[0])) {
    params = [];
    callback = args[0];
  } else {
    throw "unexpected db query syntax";
  }

  return new Promise((resolve, reject) => {
    pool.connect((err, client, release) => {
      if (err) {
        if (callback) callback(err, { rows: [] });
        release(err);
        logger.error("pg_connect_pool_fail", err);
        return reject(err);
      }

      client.query(queryString, params, function (err, results) {
        if (err) {
          release(err);
          if (callback) callback(err, results);
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

const pgPoolLevelRanks = ["info", "verbose"];
const pgPoolLoggingLevel = -1;

function query<T>(
  queryString: string,
  ...args: [(SQLParam[] | QueryCallback<T>)?, QueryCallback<T>?]
): Promise<T[]> {
  return queryImpl(readWritePool, queryString, ...args);
}

function query_readOnly<T>(
  queryString: string,
  ...args: [(SQLParam[] | QueryCallback<T>)?, QueryCallback<T>?]
): Promise<T[]> {
  return queryImpl(readPool, queryString, ...args);
}

function queryP_impl<T>(
  pool: Pool,
  queryString: string,
  params: SQLParam[]
): Promise<T[]> {
  if (!isString(queryString)) {
    return Promise.reject("query_was_not_string");
  }
  return new Promise(function (resolve, reject) {
    queryImpl(
      pool,
      queryString,
      params,
      function (err: Error | null, result?: { rows: T[] }) {
        if (err) {
          return reject(err);
        }
        if (!result || !result.rows) {
          return resolve([]);
        }
        resolve(result.rows);
      }
    );
  });
}

function queryP<T>(queryString: string, params: SQLParam[]): Promise<T[]> {
  return queryP_impl(readWritePool, queryString, params);
}

function queryP_readOnly<T>(
  queryString: string,
  params: SQLParam[]
): Promise<T[]> {
  return queryP_impl(readPool, queryString, params);
}

function queryP_readOnly_wRetryIfEmpty<T>(
  queryString: string,
  params: SQLParam[]
): Promise<T[]> {
  function retryIfEmpty(rows: T[]): Promise<T[]> {
    if (!rows.length) {
      return queryP<T>(queryString, params);
    }
    return Promise.resolve(rows);
  }

  return queryP_impl<T>(readPool, queryString, params).then(retryIfEmpty);
}

function queryP_metered_impl(
  isReadOnly: boolean,
  name: string,
  queryString: string,
  params: SQLParam[]
) {
  const queryFunction = isReadOnly ? queryP_readOnly : queryP;
  if (isUndefined(name) || isUndefined(queryString) || isUndefined(params)) {
    throw new Error("polis_err_queryP_metered_impl missing params");
  }

  // @ts-ignore
  // 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.
  return new MPromise(name, function (resolve, reject) {
    queryFunction(queryString, params).then(resolve, reject);
  });
}

function queryP_metered(name: string, queryString: string, params: SQLParam[]) {
  return queryP_metered_impl(false, name, queryString, params);
}

function queryP_metered_readOnly(
  name: string,
  queryString: string,
  params: SQLParam[]
) {
  return queryP_metered_impl(true, name, queryString, params);
}

function stream_queryP_readOnly(
  queryString: string,
  params: SQLParam[],
  onRow: (row: Record<string, unknown>) => void,
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
    stream.on("data", (row) => {
      onRow(row);
    });
    stream.on("end", () => {
      done();
      onEnd();
    });
    stream.on("error", (error) => {
      done(error);
      onError(error);
    });
  });
}

export {
  query,
  query_readOnly,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty,
  stream_queryP_readOnly,
};
export default {
  query,
  query_readOnly,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty,
  stream_queryP_readOnly,
};
