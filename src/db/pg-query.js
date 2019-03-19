const _ = require('underscore');
const config = require('../config');
const yell = require('../log').yell;
const MPromise = require('../utils/metered').MPromise;

// # DB Connections
//
// heroku pg standard plan has 120 connections
// plus a dev poller connection and a direct db connection
// 3 devs * (2 + 1 + 1) = 12 for devs
// plus the prod and preprod pollers = 14
// round up to 20
// so we can have 25 connections per server, of of which is the preprod server
// so we can have 1 preprod/3 prod servers, or 2 preprod / 2 prod.
//
// Note we use native
const pgnative = require('pg').native; //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
const parsePgConnectionString = require('pg-connection-string').parse;

const usingReplica = process.env.DATABASE_URL !== process.env[process.env.DATABASE_FOR_READS_NAME];
const poolSize = config.isDevMode() ? 2 : (usingReplica ? 3 : 12);

// not sure how many of these config options we really need anymore
const pgConnection = Object.assign(parsePgConnectionString(process.env.DATABASE_URL),
  {max: poolSize,
    isReadOnly: false,
    poolLog: function(str, level) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        console.log("pool.primary." + level + " " + str);
      }
    }});
const readsPgConnection = Object.assign(parsePgConnectionString(process.env[process.env.DATABASE_FOR_READS_NAME]),
  {max: poolSize,
    isReadOnly: true,
    poolLog: function(str, level) {
      if (pgPoolLevelRanks.indexOf(level) <= pgPoolLoggingLevel) {
        console.log("pool.replica." + level + " " + str);
      }
    }});

// split requests into centralized read/write transactor pool vs read pool for scalability concerns in keeping
// pressure down on the transactor (read+write) server
const readWritePool = new pgnative.Pool(pgConnection);
const readPool = new pgnative.Pool(readsPgConnection);

// Same syntax as pg.client.query, but uses connection pool
// Also takes care of calling 'done'.
function queryImpl(pool, queryString, ...args) {
  // variable arity depending on whether or not query has params (default to [])
  let params, callback;
  if (_.isFunction(args[1])) {
    params = args[0];
    callback = args[1];
  } else if (_.isFunction(args[0])) {
    params = [];
    callback = args[0];
  } else {
    throw "unexpected db query syntax";
  }

  // Not sure whether we have to be this careful in calling release for these query results. There may or may
  // not have been a good reason why Mike did this. If just using pool.query works and doesn't exhibit scale
  // under load, might be worth stripping
  pool.connect((err, client, release) => {
    if (err) {
      callback(err);
      // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the done() callback
      release(err);
      yell("pg_connect_pool_fail");
      return;
    }
    // Anyway, here's the actual query call
    client.query(queryString, params, function(err, results) {
      if (err) {
        // force the pool to destroy and remove a client by passing an instance of Error (or anything truthy, actually) to the release() callback
        release(err);
      } else {
        release();
      }
      callback(err, results)
    });
  });
}


const pgPoolLevelRanks = ["info", "verbose"]; // TODO investigate
const pgPoolLoggingLevel = -1; // -1 to get anything more important than info and verbose. // pgPoolLevelRanks.indexOf("info");

function query(...args) {
  return queryImpl(readWritePool, ...args);
}

function query_readOnly(...args) {
  return queryImpl(readPool, ...args);
}

function queryP_impl(config, queryString, params) {
  if (!_.isString(queryString)) {
    return Promise.reject("query_was_not_string");
  }
  let f = config.isReadOnly ? query_readOnly : query;
  return new Promise(function(resolve, reject) {
    f(queryString, params, function(err, result) {
      if (err) {
        return reject(err);
      }
      if (!result || !result.rows) {
        // caller is responsible for testing if there are results
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
  return queryP_impl(readPool, ...args).then(function(rows) {
    if (!rows.length) {
      // the replica DB didn't have it (yet?) so try the master.
      return queryP(...args);
    }
    return rows;
  }); // NOTE: this does not retry in case of errors. Not sure what's best in that case.
}



function queryP_metered_impl(isReadOnly, name, queryString, params) {
  let f = isReadOnly ? queryP_readOnly : queryP;
  if (_.isUndefined(name) || _.isUndefined(queryString) || _.isUndefined(params)) {
    throw new Error("polis_err_pgQueryP_metered_impl missing params");
  }
  return new MPromise(name, function(resolve, reject) {
    f(queryString, params).then(resolve, reject);
  });
}

function queryP_metered(name, queryString, params) {
  return queryP_metered_impl(false, ...arguments);
}

function queryP_metered_readOnly(name, queryString, params) {
  return queryP_metered_impl(true, ...arguments);
}

module.exports = {
  query,
  queryP,
  queryP_metered,
  queryP_metered_readOnly,
  queryP_readOnly,
  queryP_readOnly_wRetryIfEmpty,
};