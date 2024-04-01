import _ from 'underscore';
import pg from 'pg';
const pgnative = pg.native;
import pgConnectionString from 'pg-connection-string';
const parsePgConnectionString = pgConnectionString.parse;
import Config from '../config.js';
console.log({ Config });
import logger from '../utils/logger.js';
import { MPromise } from '../utils/metered.js';
const usingReplica = Config.databaseURL !== Config.readOnlyDatabaseURL;
const poolSize = Config.isDevMode ? 2 : usingReplica ? 3 : 12;
const pgConnection = Object.assign(parsePgConnectionString(Config.databaseURL), {
  max: poolSize,
  isReadOnly: false,
  poolLog: function (str, level) {
    if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
      logger.info('pool.primary.' + level + ' ' + str);
    }
  }
});
const readsPgConnection = Object.assign(parsePgConnectionString(Config.readOnlyDatabaseURL), {
  max: poolSize,
  isReadOnly: true,
  poolLog: function (str, level) {
    if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
      logger.info('pool.readonly.' + level + ' ' + str);
    }
  }
});
const readWritePool = new pgnative.Pool(pgConnection);
const readPool = new pgnative.Pool(readsPgConnection);
function queryImpl(pool, queryString, ...args) {
  let params;
  let callback;
  if (_.isFunction(args[1])) {
    params = args[0];
    callback = args[1];
  } else if (_.isFunction(args[0])) {
    params = [];
    callback = args[0];
  } else {
    throw 'unexpected db query syntax';
  }
  pool.connect((err, client, release) => {
    if (err) {
      if (callback) callback(err);
      release(err);
      logger.error('pg_connect_pool_fail', err);
      return;
    }
    client.query(queryString, params, function (err, results) {
      if (err) {
        release(err);
      } else {
        release();
      }
      if (callback) callback(err, results);
    });
  });
}
const pgPoolLevelRanks = ['info', 'verbose'];
const pgPoolLoggingLevel = -1;
function query(...args) {
  return queryImpl(readWritePool, ...args);
}
function query_readOnly(...args) {
  return queryImpl(readPool, ...args);
}
function queryP_impl(config, queryString, params) {
  if (!_.isString(queryString)) {
    return Promise.reject('query_was_not_string');
  }
  let f = config.isReadOnly ? query_readOnly : query;
  return new Promise(function (resolve, reject) {
    f(queryString, params, function (err, result) {
      if (err) {
        return reject(err);
      }
      if (!result || !result.rows) {
        return resolve([]);
      }
      resolve(result.rows);
    });
  });
}
function queryP(...args) {
  return queryP_impl(readWritePool, ...args);
}
function queryP_readOnly(...args) {
  return queryP_impl(readPool, ...args);
}
function queryP_readOnly_wRetryIfEmpty(...args) {
  return queryP_impl(readPool, ...args).then(function (rows) {
    if (!rows.length) {
      return queryP(...args);
    }
    return rows;
  });
}
function queryP_metered_impl(isReadOnly, name, queryString, params) {
  let f = isReadOnly ? queryP_readOnly : queryP;
  if (_.isUndefined(name) || _.isUndefined(queryString) || _.isUndefined(params)) {
    throw new Error('polis_err_queryP_metered_impl missing params');
  }
  return new MPromise(name, function (resolve, reject) {
    f(queryString, params).then(resolve, reject);
  });
}
function queryP_metered(name, queryString, params) {
  return queryP_metered_impl(false, ...arguments);
}
function queryP_metered_readOnly(name, queryString, params) {
  return queryP_metered_impl(true, ...arguments);
}
export {
  query,
  query_readOnly,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty
};
export default {
  query,
  query_readOnly,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty
};
