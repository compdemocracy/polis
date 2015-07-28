"use strict";

var SimpleCache = require("simple-lru-cache");


function SimpleCacheWithTTL(config) {
  var ttlInMillis = config.ttlInMillis;

  var cache = new SimpleCache({
    maxSize: config.maxSize,
  });

  function get(key) {
    var o = cache.get(key);
    var now = Date.now();
    if (o && now < o.expires) {
      return o.val;
    }
    return void 0;
  }

  function set(key, value) {
    var o = {
      val: value,
      expires: Date.now() + ttlInMillis,
    };
    cache.set(key, o);
  }

  return {
    get: get,
    set: set,
  };
}


module.exports = SimpleCacheWithTTL;
