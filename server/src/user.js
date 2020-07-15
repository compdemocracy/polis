const pg = require('./db/pg-query');
const _ = require('underscore');
const MPromise = require('./utils/metered').MPromise;
const LruCache = require("lru-cache");

let pidCache = new LruCache({
  max: 9000,
});

// returns a pid of -1 if it's missing
function getPidPromise(zid, uid, usePrimary) {
  let cacheKey = zid + "_" + uid;
  let cachedPid = pidCache.get(cacheKey);
  return new MPromise("getPidPromise", function(resolve, reject) {
    if (!_.isUndefined(cachedPid)) {
      resolve(cachedPid);
      return;
    }
    const f = usePrimary ? pg.pgQuery : pg.pgQuery_readOnly;
    f("SELECT pid FROM participants WHERE zid = ($1) AND uid = ($2);", [zid, uid], function(err, results) {
      if (err) {
        return reject(err);
      }
      if (!results || !results.rows || !results.rows.length) {
        resolve(-1);
        return;
      }
      let pid = results.rows[0].pid;
      pidCache.set(cacheKey, pid);
      resolve(pid);
    });
  });
}

module.exports = {
  pidCache,
  getPidPromise,
};
