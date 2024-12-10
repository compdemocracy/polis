import _ from "underscore";
import { isUri } from "valid-url";
import LruCache from "lru-cache";

import pg from "../db/pg-query";
import fail from "./fail";
import logger from "./logger";
import Conversation from "../conversation";
import User from "../user";

import { MPromise } from "./metered";

type Req = {
  query?: any;
  body?: { [x: string]: any };
  params?: any;
  p?: { zid?: any; uid?: any };
  cookies: { [x: string]: any };
};

// Consolidate query/body items in one place so other middleware has one place to look.
function moveToBody(req: Req, res: any, next: () => void) {
  if (req.query) {
    req.body = req.body || {};
    Object.assign(req.body, req.query);
  }
  if (req.params) {
    req.body = req.body || {};
    Object.assign(req.body, req.params);
  }
  // init req.p if not there already
  req.p = req.p || {};
  next();
}

function need(name: any, parserWhichReturnsPromise: any, assigner: any) {
  return buildCallback({
    name: name,
    extractor: extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
  });
}

function want(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal: any
) {
  return buildCallback({
    name: name,
    extractor: extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function needCookie(name: any, parserWhichReturnsPromise: any, assigner: any) {
  return buildCallback({
    name: name,
    extractor: extractFromCookie,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
  });
}

function wantCookie(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal: any
) {
  return buildCallback({
    name: name,
    extractor: extractFromCookie,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function needHeader(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal: any
) {
  return buildCallback({
    name: name,
    extractor: extractFromHeader,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
    defaultVal: defaultVal,
  });
}

function wantHeader(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal: any
) {
  return buildCallback({
    name: name,
    extractor: extractFromHeader,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function extractFromBody(req: Req, name: string | number) {
  if (!req.body) {
    return void 0;
  }
  return req.body[name];
}

function extractFromCookie(
  req: { cookies: { [x: string]: any } },
  name: string | number
) {
  if (!req.cookies) {
    return void 0;
  }
  return req.cookies[name];
}

function extractFromHeader(
  req: { headers: { [x: string]: any } },
  name: string
) {
  if (!req.headers) {
    return void 0;
  }
  return req.headers[name.toLowerCase()];
}

function buildCallback(config: {
  name: any;
  extractor: any;
  parserWhichReturnsPromise: any;
  assigner: any;
  required: any;
  defaultVal?: any;
}) {
  let name = config.name;
  let parserWhichReturnsPromise = config.parserWhichReturnsPromise;
  let assigner = config.assigner;
  let required = config.required;
  let defaultVal = config.defaultVal;
  let extractor = config.extractor;

  if (typeof assigner !== "function") {
    throw new Error("bad arg for assigner");
  }
  if (typeof parserWhichReturnsPromise !== "function") {
    throw new Error("bad arg for parserWhichReturnsPromise");
  }

  return function (
    req: any,
    res: { status: (arg0: number) => void },
    next: (arg0?: string) => void
  ) {
    let val = extractor(req, name);
    if (!_.isUndefined(val) && !_.isNull(val)) {
      parserWhichReturnsPromise(val)
        .then(
          function (parsed: any) {
            assigner(req, name, parsed);
            next();
          },
          function (err: any) {
            let s = `polis_err_param_parse_failed_${name} (val='${val}', error=${err})`;
            logger.error(s, err);
            res.status(400);
            next(s);
            return;
          }
        )
        .catch(function (err: any) {
          fail(res, 400, "polis_err_misc", err);
          return;
        });
    } else if (!required) {
      if (typeof defaultVal !== "undefined") {
        assigner(req, name, defaultVal);
      }
      next();
    } else {
      let s = "polis_err_param_missing_" + name;
      logger.error(s);
      res.status(400);
      next(s);
    }
  };
}

function isEmail(s: string | string[]) {
  return typeof s === "string" && s.length < 999 && s.indexOf("@") > 0;
}

function getEmail(s: string) {
  return new Promise(function (resolve, reject) {
    if (!isEmail(s)) {
      return reject("polis_fail_parse_email");
    }
    resolve(s);
  });
}

function getPassword(s: string) {
  return new Promise(function (resolve, reject) {
    if (typeof s !== "string" || s.length > 999 || s.length === 0) {
      return reject("polis_fail_parse_password");
    }
    resolve(s);
  });
}

function getPasswordWithCreatePasswordRules(s: any) {
  return getPassword(s).then(function (s) {
    if (typeof s !== "string" || s.length < 6) {
      throw new Error("polis_err_password_too_short");
    }
    return s;
  });
}

function getOptionalStringLimitLength(limit: number) {
  return function (s: string) {
    return new Promise(function (resolve, reject) {
      if (s.length && s.length > limit) {
        return reject("polis_fail_parse_string_too_long");
      }
      // strip leading/trailing spaces
      s = s.replace(/^ */, "").replace(/ *$/, "");
      resolve(s);
    });
  };
}

function getStringLimitLength(min: number, max?: number) {
  if (_.isUndefined(max)) {
    max = min;
    min = 1;
  }
  return function (s: string): Promise<string> {
    return new Promise(function (resolve, reject) {
      if (typeof s !== "string") {
        return reject("polis_fail_parse_string_missing");
      }
      if (s.length && s.length > (max as number)) {
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

function getUrlLimitLength(limit: any) {
  return function (s: any) {
    getStringLimitLength(limit)(s).then(function (s) {
      return new Promise(function (resolve, reject) {
        if (isUri(s)) {
          return resolve(s);
        } else {
          return reject("polis_fail_parse_url_invalid");
        }
      });
    });
  };
}

function getInt(s: string): Promise<number> {
  return new Promise(function (resolve, reject) {
    if (_.isNumber(s) && s >> 0 === s) {
      return resolve(s);
    }
    let x: number = parseInt(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_int " + s);
    }
    resolve(x);
  });
}

function getBool(s: string | number) {
  return new Promise(function (resolve, reject) {
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
    s = (s as string).toLowerCase();
    if (s === "t" || s === "true" || s === "on" || s === "1") {
      return resolve(true);
    } else if (s === "f" || s === "false" || s === "off" || s === "0") {
      return resolve(false);
    }
    reject("polis_fail_parse_boolean");
  });
}

function getIntInRange(min: number, max: number) {
  return function (s: string): Promise<number> {
    return getInt(s).then(function (x: number) {
      if (x < min || max < x) {
        throw new Error("polis_fail_parse_int_out_of_range");
      }
      return x;
    });
  };
}

const reportIdToRidCache = new LruCache({
  max: 1000,
});

const getZidFromConversationId = Conversation.getZidFromConversationId;

function getRidFromReportId(report_id: string) {
  //   TS7009: 'new' expression, whose target lacks a construct signature, implicitly has an 'any' type.
  // 344   return new MPromise(
  //              ~~~~~~~~~~~~~
  // 345     "getRidFromReportId",
  //     ~~~~~~~~~~~~~~~~~~~~~~~~~
  // ...
  // 368     }
  //     ~~~~~
  // 369   );
  // ~~~
  // @ts-ignore
  return new MPromise(
    "getRidFromReportId",
    function (resolve: any, reject: any) {
      let cachedRid = reportIdToRidCache.get(report_id);
      if (cachedRid) {
        resolve(cachedRid);
        return;
      }
      pg.query_readOnly(
        "select rid from reports where report_id = ($1);",
        [report_id],
        function (err: any, results: { rows: string | any[] }) {
          if (err) {
            logger.error(
              "polis_err_fetching_rid_for_report_id " + report_id,
              err
            );
            return reject(err);
          } else if (!results || !results.rows || !results.rows.length) {
            return reject("polis_err_fetching_rid_for_report_id");
          } else {
            let rid = results.rows[0].rid;
            reportIdToRidCache.set(report_id, rid);
            return resolve(rid);
          }
        }
      );
    }
  );
}

// conversation_id is the client/ public API facing string ID
const parseConversationId = getStringLimitLength(1, 100);

function getConversationIdFetchZid(s: any) {
  return parseConversationId(s).then(function (conversation_id) {
    return getZidFromConversationId(conversation_id).then(function (zid: any) {
      return Number(zid);
    });
  });
}

const parseReportId = getStringLimitLength(1, 100);

function getReportIdFetchRid(s: any) {
  return parseReportId(s).then(function (report_id) {
    return getRidFromReportId(report_id).then(function (rid: any) {
      return Number(rid);
    });
  });
}

function getNumber(s: string): Promise<number> {
  return new Promise(function (resolve, reject) {
    if (_.isNumber(s)) {
      return resolve(s);
    }
    let x: number = parseFloat(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_number");
    }
    resolve(x);
  });
}

function getNumberInRange(min: number, max: number) {
  return function (s: string) {
    return getNumber(s).then(function (x: number) {
      if (x < min || max < x) {
        throw new Error("polis_fail_parse_number_out_of_range");
      }
      return x;
    });
  };
}

function getArrayOfString(
  a: string,
  maxStrings?: undefined,
  maxLength?: undefined
): Promise<string[]> {
  return new Promise(function (resolve, reject) {
    let result;
    if (_.isString(a)) {
      result = a.split(",");
    }
    if (!_.isArray(result)) {
      return reject("polis_fail_parse_int_array");
    }
    resolve(result);
  });
}

function getArrayOfStringNonEmpty(a: string, maxStrings: any, maxLength: any) {
  if (!a || !a.length) {
    return Promise.reject("polis_fail_parse_string_array_empty");
  }
  return getArrayOfString(a);
}

function getArrayOfStringLimitLength(maxStrings: any, maxLength: any) {
  return function (a: any) {
    return getArrayOfString(a, maxStrings || 999999999, maxLength);
  };
}

function getArrayOfStringNonEmptyLimitLength(maxStrings: any, maxLength: any) {
  return function (a: any) {
    return getArrayOfStringNonEmpty(a, maxStrings || 999999999, maxLength);
  };
}

function getArrayOfInt(a: string[]) {
  if (_.isString(a)) {
    a = a.split(",");
  }
  if (!_.isArray(a)) {
    return Promise.reject("polis_fail_parse_int_array");
  }

  function integer(i: any) {
    return Number(i) >> 0;
  }
  return Promise.resolve(a.map(integer));
}

function assignToP(req: { p: { [x: string]: any } }, name: string, x: any) {
  req.p = req.p || {};
  if (!_.isUndefined(req.p[name])) {
    logger.error("polis_err_clobbering " + name);
  }
  req.p[name] = x;
}

function assignToPCustom(name: any) {
  return function (req: any, ignoredName: any, x: any) {
    assignToP(req, name, x);
  };
}

function resolve_pidThing(
  pidThingStringName: any,
  assigner: (arg0: any, arg1: any, arg2: number) => void,
  loggingString: string
) {
  if (_.isUndefined(loggingString)) {
    loggingString = "";
  }
  logger.debug("resolve_pidThing " + loggingString);
  return function (req: Req, res: any, next: (arg0?: string) => void) {
    if (!req.p) {
      fail(res, 500, "polis_err_this_middleware_should_be_after_auth_and_zid");
      next("polis_err_this_middleware_should_be_after_auth_and_zid");
    }

    let existingValue =
      extractFromBody(req, pidThingStringName) ||
      extractFromCookie(req, pidThingStringName);

    if (existingValue === "mypid" && req?.p?.zid && req.p.uid) {
      User.getPidPromise(req.p.zid, req.p.uid)
        .then(function (pid: number) {
          if (pid >= 0) {
            assigner(req, pidThingStringName, pid);
          }
          next();
        })
        .catch(function (err: any) {
          fail(res, 500, "polis_err_mypid_resolve_error", err);
          next(err);
        });
    } else if (existingValue === "mypid") {
      // don't assign anything, since we have no uid to look it up.
      next();
    } else if (!_.isUndefined(existingValue)) {
      getInt(existingValue)
        .then(function (pidNumber: number) {
          assigner(req, pidThingStringName, pidNumber);
          next();
        })
        .catch(function (err) {
          fail(res, 500, "polis_err_pid_error", err);
          next(err);
        });
    } else {
      next();
    }
  };
}

export {
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

export default {
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
