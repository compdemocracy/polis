import _ from "underscore";
import { isUri } from "valid-url";
import LruCache from "lru-cache";

import { failJson } from "./fail";
import { getPidPromise } from "../user";
import { getZidFromConversationId } from "../conversation";
import { MPromise } from "./metered";
import logger from "./logger";
import pg from "../db/pg-query";

type Req = {
  query?: any;
  body?: { [x: string]: any };
  params?: any;
  p?: { zid?: number; uid?: number };
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
  return _buildCallback({
    name: name,
    extractor: _extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: true,
  });
}

function want(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal?: any
) {
  return _buildCallback({
    name: name,
    extractor: _extractFromBody,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function wantHeader(
  name: any,
  parserWhichReturnsPromise: any,
  assigner: any,
  defaultVal?: any
) {
  return _buildCallback({
    name: name,
    extractor: _extractFromHeader,
    parserWhichReturnsPromise: parserWhichReturnsPromise,
    assigner: assigner,
    required: false,
    defaultVal: defaultVal,
  });
}

function _extractFromBody(req: Req, name: string | number) {
  if (!req.body) {
    return void 0;
  }
  return req.body[name];
}

function _extractFromHeader(
  req: { headers: { [x: string]: any } },
  name: string
) {
  if (!req.headers) {
    return void 0;
  }
  return req.headers[name.toLowerCase()];
}

function _buildCallback(config: {
  name: any;
  extractor: any;
  parserWhichReturnsPromise: any;
  assigner: any;
  required: any;
  defaultVal?: any;
}) {
  const name = config.name;
  const parserWhichReturnsPromise = config.parserWhichReturnsPromise;
  const assigner = config.assigner;
  const required = config.required;
  const defaultVal = config.defaultVal;
  const extractor = config.extractor;

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
    const val = extractor(req, name);
    if (!_.isUndefined(val) && !_.isNull(val)) {
      parserWhichReturnsPromise(val)
        .then(
          function (parsed: any) {
            assigner(req, name, parsed);
            next();
          },
          function (err: any) {
            const s = `polis_err_param_parse_failed_${name} (val='${val}', error=${err})`;
            logger.error(s, err);
            res.status(400);
            next(s);
            return;
          }
        )
        .catch(function (err: any) {
          failJson(res, 400, "polis_err_misc", err);
          return;
        });
    } else if (!required) {
      if (typeof defaultVal !== "undefined") {
        assigner(req, name, defaultVal);
      }
      next();
    } else {
      const s = "polis_err_param_missing_" + name;
      logger.error(s);
      res.status(400);
      next(s);
    }
  };
}

function _isEmail(s: string | string[]) {
  return typeof s === "string" && s.length < 999 && s.indexOf("@") > 0;
}

function getEmail(s: string) {
  return new Promise(function (resolve, reject) {
    if (!_isEmail(s)) {
      return reject("polis_fail_parse_email");
    }
    resolve(s);
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

function _integerOrUndefined(rawValue: any): number | undefined {
  if (typeof rawValue === "string") {
    if (rawValue.trim() !== "") {
      const parsed = parseInt(rawValue, 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
  } else if (typeof rawValue === "number" && Number.isInteger(rawValue)) {
    return rawValue;
  }
  return undefined;
}

function getInt(s: string): Promise<number> {
  return new Promise(function (resolve, reject) {
    const parsed = _integerOrUndefined(s);
    if (parsed === undefined) {
      return reject("polis_fail_parse_int " + s);
    }
    resolve(parsed);
  });
}

function getBool(s: string | number) {
  return new Promise(function (resolve, reject) {
    const type = typeof s;
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

const _reportIdToRidCache = new LruCache({
  max: 1000,
});

function _getRidFromReportId(report_id: string) {
  return MPromise("_getRidFromReportId", function (resolve: any, reject: any) {
    const cachedRid = _reportIdToRidCache.get(report_id);
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
          const rid = results.rows[0].rid;
          _reportIdToRidCache.set(report_id, rid);
          return resolve(rid);
        }
      }
    );
  });
}

/**
 * Get the zid (conversation ID) from a report ID
 * @param report_id - The report ID string
 * @returns Promise that resolves to the numeric zid
 */
function getZidFromReport(report_id: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    pg.query_readOnly(
      "SELECT zid FROM reports WHERE report_id = ($1);",
      [report_id],
      (err: any, results: { rows: any[] }) => {
        if (err) {
          logger.error(
            "polis_err_fetching_zid_for_report_id " + report_id,
            err
          );
          return reject(err);
        } else if (!results || !results.rows || !results.rows.length) {
          logger.warn("No zid found for report_id: " + report_id);
          return resolve(null);
        } else {
          const zid = results.rows[0].zid;
          return resolve(Number(zid));
        }
      }
    );
  });
}

// conversation_id is the client/ public API facing string ID
const _parseConversationId = getStringLimitLength(1, 100);
const _parseReportId = getStringLimitLength(1, 100);

function getConversationIdFetchZid(s: any) {
  return _parseConversationId(s).then(function (conversation_id) {
    return getZidFromConversationId(conversation_id).then(function (
      zid: number
    ) {
      return Number(zid);
    });
  });
}

function getReportIdFetchRid(s: any) {
  return _parseReportId(s).then(function (report_id) {
    return _getRidFromReportId(report_id).then(function (rid: any) {
      return Number(rid);
    });
  });
}

function _getNumber(s: string): Promise<number> {
  return new Promise(function (resolve, reject) {
    if (_.isNumber(s)) {
      return resolve(s);
    }
    const x: number = parseFloat(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_number");
    }
    resolve(x);
  });
}

function getNumberInRange(min: number, max: number) {
  return function (s: string) {
    return _getNumber(s).then(function (x: number) {
      if (x < min || max < x) {
        throw new Error("polis_fail_parse_number_out_of_range");
      }
      return x;
    });
  };
}

function _getArrayOfString(a: string | string[]): Promise<string[]> {
  return new Promise(function (resolve, reject) {
    let result;
    if (_.isArray(a)) {
      // Already an array (from JSON POST body)
      result = a;
    } else if (_.isString(a)) {
      // Comma-separated string (from query string or form data)
      result = a.split(",").map((s) => s.trim());
    } else {
      return reject("polis_fail_parse_string_array");
    }
    if (!_.isArray(result)) {
      return reject("polis_fail_parse_string_array");
    }
    resolve(result);
  });
}

function getArrayOfStringNonEmpty(a: string | string[]) {
  if (
    !a ||
    (_.isArray(a) && a.length === 0) ||
    (_.isString(a) && a.length === 0)
  ) {
    return Promise.reject("polis_fail_parse_string_array_empty");
  }
  return _getArrayOfString(a);
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
  return function (req: Req, res: any, next: (arg0?: string) => void) {
    if (!req.p) {
      failJson(
        res,
        500,
        "polis_err_this_middleware_should_be_after_auth_and_zid"
      );
      next("polis_err_this_middleware_should_be_after_auth_and_zid");
    }

    // Check if we already have a valid PID from JWT authentication BEFORE extracting URL params
    const jwtProvidedValue = req.p[pidThingStringName];
    const hasValidJwtPid = jwtProvidedValue && jwtProvidedValue >= 0;
    const rawValue = _extractFromBody(req, pidThingStringName);
    const pidNumber = _integerOrUndefined(rawValue);

    // If we already have a valid PID from JWT, preserve it regardless of URL params
    if (hasValidJwtPid) {
      next();
      return;
    }

    logger.info("resolve_pidThing " + loggingString, {
      pidNumber,
      hasValidJwtPid,
      jwtProvidedValue,
      reqPZid: req.p.zid,
      reqPUid: req.p.uid,
    });

    if (pidNumber === -1 && req?.p?.zid && req.p.uid) {
      getPidPromise(req.p.zid, req.p.uid)
        .then(function (pid: number) {
          if (pid >= 0) {
            assigner(req, pidThingStringName, pid);
          }
          next();
        })
        .catch(function (err: any) {
          failJson(res, 500, "polis_err_mypid_resolve_error", err);
          next(err);
        });
    } else if (pidNumber === -1) {
      // don't assign anything, since we have no uid to look it up.
      next();
    } else if (!_.isUndefined(pidNumber)) {
      assigner(req, pidThingStringName, pidNumber);
      next();
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
  getBool,
  getConversationIdFetchZid,
  getEmail,
  getInt,
  getIntInRange,
  getNumberInRange,
  getOptionalStringLimitLength,
  getReportIdFetchRid,
  getStringLimitLength,
  getUrlLimitLength,
  getZidFromReport,
  moveToBody,
  need,
  resolve_pidThing,
  want,
  wantHeader,
};
