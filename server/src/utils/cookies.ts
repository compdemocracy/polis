import _ from "underscore";
import url from "url";

import Config from "../config";
import User from "../user";
import Session from "../session";
import logger from "../utils/logger";

type Options = {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: any;
  domain?: any;
};

type Req = {
  headers?: { origin: string };
  cookies: { [x: string]: any };
};

const COOKIES = {
  COOKIE_TEST: "ct",
  HAS_EMAIL: "e",
  TOKEN: "token2",
  UID: "uid2",
  REFERRER: "ref",
  PARENT_REFERRER: "referrer",
  PARENT_URL: "parent_url",
  USER_CREATED_TIMESTAMP: "uc",
  PERMANENT_COOKIE: "pc",
  TRY_COOKIE: "tryCookie",
};

const getUserInfoForSessionToken = Session.getUserInfoForSessionToken;

const COOKIES_TO_CLEAR = {
  e: true,
  token2: true,
  uid2: true,
  uc: true,
  referrer: true,
  parent_url: true,
};

let oneYear = 1000 * 60 * 60 * 24 * 365;

function cookieDomain(req: any) {
  const origin = req?.headers?.origin || "";
  const parsedOrigin = url.parse(origin);
  if (parsedOrigin.hostname === "localhost") {
    return "localhost";
  }

  if (Config.domainOverride) {
    return `.${Config.domainOverride}`;
  }

  return `.${Config.getServerHostname()}`;
}

function setCookie(
  req: any,
  res: { cookie: (arg0: any, arg1: any, arg2: any) => void },
  name: string,
  value: number,
  options: Options
) {
  const opts: Options = _.clone(options || {});
  opts.path = _.isUndefined(opts.path) ? "/" : opts.path;
  opts.maxAge = _.isUndefined(opts.maxAge) ? oneYear : opts.maxAge;

  const origin = req?.headers?.origin || "";
  const parsedOrigin = url.parse(origin);

  opts.secure = parsedOrigin.protocol === "https:";
  opts.domain = cookieDomain(req);

  res.cookie(name, value, opts);
}

function setParentReferrerCookie(req: any, res: any, referrer: any) {
  setCookie(req, res, COOKIES.PARENT_REFERRER, referrer, {
    httpOnly: true,
  });
}

function setParentUrlCookie(req: any, res: any, parent_url: any) {
  setCookie(req, res, COOKIES.PARENT_URL, parent_url, {
    httpOnly: true,
  });
}

function setHasEmailCookie(req: any, res: any, email: any) {
  if (email) {
    setCookie(req, res, COOKIES.HAS_EMAIL, 1, {
      // not httpOnly - needed by JS
    });
  }
  // else falsy
}

function setUserCreatedTimestampCookie(req: any, res: any, timestamp: any) {
  setCookie(req, res, COOKIES.USER_CREATED_TIMESTAMP, timestamp, {
    // not httpOnly - needed by JS
  });
}

function setTokenCookie(req: any, res: any, token: any) {
  setCookie(req, res, COOKIES.TOKEN, token, {
    httpOnly: true,
  });
}

function setUidCookie(req: any, res: any, uid: any) {
  setCookie(req, res, COOKIES.UID, uid, {
    // not httpOnly - needed by JS
  });
}

function setPermanentCookie(req: any, res: any, token: any) {
  setCookie(req, res, COOKIES.PERMANENT_COOKIE, token, {
    httpOnly: true,
  });
}

function setCookieTestCookie(req: any, res: any) {
  setCookie(req, res, COOKIES.COOKIE_TEST, 1, {
    // not httpOnly - needed by JS
  });
}

function addCookies(
  req: { cookies: { [x: string]: any } },
  res: { header: (arg0: string, arg1: any) => void },
  token: any,
  uid: any
) {
  return User.getUserInfoForUid2(uid).then(function (opts: {
    email: any;
    created: any;
  }) {
    let email = opts.email;
    let created = opts.created;

    setTokenCookie(req, res, token);
    setUidCookie(req, res, uid);
    setHasEmailCookie(req, res, email);
    setUserCreatedTimestampCookie(req, res, created);

    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      setPermanentCookie(req, res, Session.makeSessionToken());
    }
    res.header("x-polis", token);
  });
}

function getPermanentCookieAndEnsureItIsSet(
  req: { cookies: { [x: string]: any } },
  res: any
) {
  if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
    let token = Session.makeSessionToken();
    setPermanentCookie(req, res, token);
    return token;
  } else {
    return req.cookies[COOKIES.PERMANENT_COOKIE];
  }
}

function clearCookies(
  req: { headers?: Headers; cookies?: any; p?: any },
  res: {
    clearCookie?: (
      arg0: string,
      arg1: { path: string; domain?: string }
    ) => void;
    status?: (arg0: number) => void;
    _headers?: { [x: string]: any };
    redirect?: (arg0: string) => void;
    set?: (arg0: { "Content-Type": string }) => void;
  }
) {
  let cookieName;
  for (cookieName in req.cookies) {
    // Element implicitly has an 'any' type because expression of type 'string' can't be used to index type '{ e: boolean; token2: boolean; uid2: boolean; uc: boolean; plan: boolean; referrer: boolean; parent_url: boolean; }'.
    // No index signature with a parameter of type 'string' was found on type '{ e: boolean; token2: boolean; uid2: boolean; uc: boolean; plan: boolean; referrer: boolean; parent_url: boolean; }'.ts(7053)
    // @ts-ignore
    if (COOKIES_TO_CLEAR[cookieName]) {
      res?.clearCookie?.(cookieName, {
        path: "/",
        domain: cookieDomain(req),
      });
    }
  }
  logger.info(
    "after clear res set-cookie: " +
      JSON.stringify(res?._headers?.["set-cookie"])
  );
}

function clearCookie(
  req: { [key: string]: any; headers?: { origin: string } },
  res: {
    [key: string]: any;
    clearCookie?: (arg0: any, arg1: { path: string; domain?: string }) => void;
  },
  cookieName: any
) {
  res?.clearCookie?.(cookieName, {
    path: "/",
    domain: cookieDomain(req),
  });
}

function doCookieAuth(
  assigner: (arg0: any, arg1: string, arg2: number) => void,
  isOptional: any,
  req: { cookies: { [x: string]: any }; body: { uid?: any } },
  res: { status: (arg0: number) => void },
  next: { (err: any): void; (arg0?: string): void }
) {
  let token = req.cookies[COOKIES.TOKEN];

  //if (req.body.uid) { next(401); return; } // shouldn't be in the post - TODO - see if we can do the auth in parallel for non-destructive operations
  getUserInfoForSessionToken(token, res, function (err: any, uid?: any) {
    if (err) {
      clearCookies(req, res); // TODO_MULTI_DATACENTER_CONSIDERATION
      if (isOptional) {
        next();
      } else {
        res.status(403);
        next("polis_err_auth_no_such_token");
      }
      return;
    }
    if (req.body.uid && req.body.uid !== uid) {
      res.status(401);
      next("polis_err_auth_mismatch_uid");
      return;
    }
    assigner(req, "uid", Number(uid));
    next();
  });
}

export default {
  COOKIES,
  COOKIES_TO_CLEAR,
  cookieDomain,
  setCookie,
  setParentReferrerCookie,
  setParentUrlCookie,
  setPermanentCookie,
  setCookieTestCookie,
  addCookies,
  getPermanentCookieAndEnsureItIsSet,
  clearCookies,
  clearCookie,
  doCookieAuth,
};
