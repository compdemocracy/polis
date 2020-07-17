const _ = require('underscore');
const pg = require('../db/pg-query');
const MPromise = require('./metered').MPromise;
const Log = require('../log');
const Conversation = require('../conversation');
const User = require('../user');
const isValidUrl = require('valid-url');
const LruCache = require("lru-cache");

// Consolidate query/body items in one place so other middleware has one place to look.
function moveToBody(req, res, next) {
  if (req.query) {
    req.body = req.body || {};
    Object.assign(req.body, req.query);
  }
  if (req.params) {
    req.body = req.body || {};
    Object.assign(req.body, req.params);
  }
  // inti req.p if not there already
  req.p = req.p || {};
  next();
}

function need(name, parserWhichReturnsPromise, assigner) {
  return buildCallback({
    name: name,
    extractor: extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
  });
}

function want(name, parserWhichReturnsPromise, assigner, defaultVal) {
  return buildCallback({
    name: name,
    extractor: extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function needCookie(name, parserWhichReturnsPromise, assigner) {
  return buildCallback({
    name: name,
    extractor: extractFromCookie,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
  });
}

function wantCookie(name, parserWhichReturnsPromise, assigner, defaultVal) {
  return buildCallback({
    name: name,
    extractor: extractFromCookie,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function needHeader(name, parserWhichReturnsPromise, assigner, defaultVal) {
  return buildCallback({
    name: name,
    extractor: extractFromHeader,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
    defaultVal: defaultVal,
  });
}

function wantHeader(name, parserWhichReturnsPromise, assigner, defaultVal) {
  return buildCallback({
    name: name,
    extractor: extractFromHeader,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function extractFromBody(req, name) {
  if (!req.body) {
    return void 0;
  }
  return req.body[name];
}

function extractFromCookie(req, name) {
  if (!req.cookies) {
    return void 0;
  }
  return req.cookies[name];
}

function extractFromHeader(req, name) {
  if (!req.headers) {
    return void 0;
  }
  return req.headers[name.toLowerCase()];
}

function buildCallback(config) {
  let name = config.name;
  let parserWhichReturnsPromise = config.parserWhichReturnsPromise;
  let assigner = config.assigner;
  let required = config.required;
  let defaultVal = config.defaultVal;
  let extractor = config.extractor;

  if (typeof assigner !== "function") {
    throw "bad arg for assigner";
  }
  if (typeof parserWhichReturnsPromise !== "function") {
    throw "bad arg for parserWhichReturnsPromise";
  }

  return function(req, res, next) {
    let val = extractor(req, name);
    if (!_.isUndefined(val) && !_.isNull(val)) {
      parserWhichReturnsPromise(val).then(function(parsed) {
        assigner(req, name, parsed);
        next();
      }, function(e) {
        let s = "polis_err_param_parse_failed_" + name;
        console.error(s);
        console.error(e);
        Log.yell(s);
        res.status(400);
        next(s);
        return;
      }).catch(function(err) {
        Log.fail(res, "polis_err_misc", err);
        return;
      });
    } else if (!required) {
      if (typeof defaultVal !== "undefined") {
        assigner(req, name, defaultVal);
      }
      next();
    } else {
      // winston.log("info",req);
      let s = "polis_err_param_missing_" + name;
      console.error(s);
      Log.yell(s);
      res.status(400);
      next(s);
    }
  };
}

function isEmail(s) {
  return typeof s === "string" && s.length < 999 && s.indexOf("@") > 0;
}

function getEmail(s) {
  return new Promise(function(resolve, reject) {
    if (!isEmail(s)) {
      return reject("polis_fail_parse_email");
    }
    resolve(s);
  });
}

function getPassword(s) {
  return new Promise(function(resolve, reject) {
    if (typeof s !== "string" || s.length > 999 || s.length === 0) {
      return reject("polis_fail_parse_password");
    }
    resolve(s);
  });
}

function getPasswordWithCreatePasswordRules(s) {
  return getPassword(s).then(function(s) {
    if (typeof s !== "string" || s.length < 6) {
      throw new Error("polis_err_password_too_short");
    }
    return s;
  });
}

function getOptionalStringLimitLength(limit) {
  return function(s) {
    return new Promise(function(resolve, reject) {
      if (s.length && s.length > limit) {
        return reject("polis_fail_parse_string_too_long");
      }
      // strip leading/trailing spaces
      s = s.replace(/^ */, "").replace(/ *$/, "");
      resolve(s);
    });
  };
}

function getStringLimitLength(min, max) {
  if (_.isUndefined(max)) {
    max = min;
    min = 1;
  }
  return function(s) {
    return new Promise(function(resolve, reject) {
      if (typeof s !== "string") {
        return reject("polis_fail_parse_string_missing");
      }
      if (s.length && s.length > max) {
        return reject("polis_fail_parse_string_too_long");
      }
      if (s.length && s.length < min) {
        return reject("polis_fail_parse_string_too_short");
      }
      // strip leading/trailing spaces
      s = s.replace(/^ */, "").replace(/ *$/, "");
      resolve(s);
    });
  };
}

function getUrlLimitLength(limit) {
  return function(s) {
    getStringLimitLength(limit)(s).then(function(s) {
      return new Promise(function(resolve, reject) {
        if (isValidUrl(s)) {
          return resolve(s);
        } else {
          return reject("polis_fail_parse_url_invalid");
        }
      });
    });
  };
}

function getInt(s) {
  return new Promise(function(resolve, reject) {
    if (_.isNumber(s) && s >> 0 === s) {
      return resolve(s);
    }
    let x = parseInt(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_int " + s);
    }
    resolve(x);
  });
}

function getBool(s) {
  return new Promise(function(resolve, reject) {
    let type = typeof s;
    if ("boolean" === type) {
      return resolve(s);
    }
    if ("number" === type) {
      if (s === 0) {
        return resolve(false);
      }
      return resolve(true);
    }
    s = s.toLowerCase();
    if (s === 't' || s === 'true' || s === 'on' || s === '1') {
      return resolve(true);
    } else if (s === 'f' || s === 'false' || s === 'off' || s === '0') {
      return resolve(false);
    }
    reject("polis_fail_parse_boolean");
  });
}

function getIntInRange(min, max) {
  return function(s) {
    return getInt(s).then(function(x) {
      if (x < min || max < x) {
        throw "polis_fail_parse_int_out_of_range";
      }
      return x;
    });
  };
}

const reportIdToRidCache = new LruCache({
  max: 1000,
});

const getZidFromConversationId = Conversation.getZidFromConversationId;

function getRidFromReportId(report_id) {
  return new MPromise("getRidFromReportId", function(resolve, reject) {
    let cachedRid = reportIdToRidCache.get(report_id);
    if (cachedRid) {
      resolve(cachedRid);
      return;
    }
    pg.query_readOnly("select rid from reports where report_id = ($1);", [report_id], function(err, results) {
      if (err) {
        return reject(err);
      } else if (!results || !results.rows || !results.rows.length) {
        console.error("polis_err_fetching_rid_for_report_id " + report_id);
        return reject("polis_err_fetching_rid_for_report_id");
      } else {
        let rid = results.rows[0].rid;
        reportIdToRidCache.set(report_id, rid);
        return resolve(rid);
      }
    });
  });
}

// conversation_id is the client/ public API facing string ID
const parseConversationId = getStringLimitLength(1, 100);

function getConversationIdFetchZid(s) {
  return parseConversationId(s).then(function(conversation_id) {
    return getZidFromConversationId(conversation_id).then(function(zid) {
      return Number(zid);
    });
  });
}

const parseReportId = getStringLimitLength(1, 100);

function getReportIdFetchRid(s) {
  return parseReportId(s).then(function(report_id) {
    console.log(report_id);
    return getRidFromReportId(report_id).then(function(rid) {
      console.log(rid);
      return Number(rid);
    });
  });
}

function getNumber(s) {
  return new Promise(function(resolve, reject) {
    if (_.isNumber(s)) {
      return resolve(s);
    }
    let x = parseFloat(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_number");
    }
    resolve(x);
  });
}

function getNumberInRange(min, max) {
  return function(s) {
    return getNumber(s).then(function(x) {
      if (x < min || max < x) {
        throw "polis_fail_parse_number_out_of_range";
      }
      return x;
    });
  };
}

function getArrayOfString(a, maxStrings, maxLength) {
  return new Promise(function(resolve, reject) {
    if (_.isString(a)) {
      a = a.split(',');
    }
    if (!_.isArray(a)) {
      return reject("polis_fail_parse_int_array");
    }
    resolve(a);
  });
}

function getArrayOfStringNonEmpty(a, maxStrings, maxLength) {
  if (!a || !a.length) {
    return Promise.reject("polis_fail_parse_string_array_empty");
  }
  return getArrayOfString(a);
}

function getArrayOfStringLimitLength(maxStrings, maxLength) {
  return function(a) {
    return getArrayOfString(a, maxStrings||999999999, maxLength);
  };
}

function getArrayOfStringNonEmptyLimitLength(maxStrings, maxLength) {
  return function(a) {
    return getArrayOfStringNonEmpty(a, maxStrings||999999999, maxLength);
  };
}

function getArrayOfInt(a) {
  if (_.isString(a)) {
    a = a.split(',');
  }
  if (!_.isArray(a)) {
    return Promise.reject("polis_fail_parse_int_array");
  }

  function integer(i) {
    return Number(i) >> 0;
  }
  return Promise.resolve(a.map(integer));
}

function assignToP(req, name, x) {
  req.p = req.p || {};
  if (!_.isUndefined(req.p[name])) {
    let s = "clobbering " + name;
    console.error(s);
    Log.yell(s);
  }
  req.p[name] = x;
}

function assignToPCustom(name) {
  return function(req, ignoredName, x) {
    assignToP(req, name, x);
  };
}

function resolve_pidThing(pidThingStringName, assigner, loggingString) {
  if (_.isUndefined(loggingString)) {
    loggingString = "";
  }
  return function(req, res, next) {
    if (!req.p) {
      Log.fail(res, 500, "polis_err_this_middleware_should_be_after_auth_and_zid");
      next("polis_err_this_middleware_should_be_after_auth_and_zid");
    }
    console.dir(req.p);

    let existingValue = extractFromBody(req, pidThingStringName) || extractFromCookie(req, pidThingStringName);

    if (existingValue === "mypid" && req.p.zid && req.p.uid) {
      User.getPidPromise(req.p.zid, req.p.uid).then(function(pid) {
        if (pid >= 0) {
          assigner(req, pidThingStringName, pid);
        }
        next();
      }).catch(function(err) {
        Log.fail(res, 500, "polis_err_mypid_resolve_error", err);
        next(err);
      });
    } else if (existingValue === "mypid") {
      // don't assign anything, since we have no uid to look it up.
      next();
    } else if (!_.isUndefined(existingValue)) {
      getInt(existingValue).then(function(pidNumber) {
        assigner(req, pidThingStringName, pidNumber);
        next();
      }).catch(function(err) {
        Log.fail(res, 500, "polis_err_pid_error", err);
        next(err);
      });
    } else {
      next();
    }
  };
}

module.exports = {
  assignToP,
  assignToPCustom,
  getArrayOfInt,
  getArrayOfStringNonEmpty,
  getArrayOfStringNonEmptyLimitLength,
  getBool,
  getConversationIdFetchZid,
  getEmail,
  getInt,
  getIntInRange,
  getNumberInRange,
  getOptionalStringLimitLength,
  getPassword,
  getPasswordWithCreatePasswordRules,
  getReportIdFetchRid,
  getStringLimitLength,
  getUrlLimitLength,
  moveToBody,
  need,
  needCookie,
  needHeader,
  resolve_pidThing,
  want,
  wantCookie,
  wantHeader,
};
