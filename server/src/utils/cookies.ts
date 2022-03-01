import _ from "underscore";

import User from "../user";
import Session from "../session";

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

let POLIS_ROOT = process.env.POLIS_ROOT
var config = require(POLIS_ROOT + 'config/config.js');

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
  PLAN_NUMBER: "plan", // not set if trial user
};

const COOKIES_TO_CLEAR = {
  e: true,
  token2: true,
  uid2: true,
  uc: true,
  plan: true,
  referrer: true,
  parent_url: true,
};

let oneYear = 1000 * 60 * 60 * 24 * 365;

function setCookie(
  req: any,
  res: { cookie: (arg0: any, arg1: any, arg2: any) => void },
  setOnPolisDomain: any,
  name: string,
  value: number,
  options: Options
) {
  let o: Options = _.clone(options || {});
  o.path = _.isUndefined(o.path) ? "/" : o.path;
  o.maxAge = _.isUndefined(o.maxAge) ? oneYear : o.maxAge;
  if (setOnPolisDomain) {
    o.secure = _.isUndefined(o.secure) ? true : o.secure;
    o.domain = _.isUndefined(o.domain) ? ".pol.is" : o.domain;
    // if (/pol.is/.test(req.headers.host)) {
    //   o.domain = '.pol.is';
    // }
  }
  res.cookie(name, value, o);
}

function setParentReferrerCookie(
  req: any,
  res: any,
  setOnPolisDomain: any,
  referrer: any
) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_REFERRER, referrer, {
    httpOnly: true,
  });
}

function setParentUrlCookie(
  req: any,
  res: any,
  setOnPolisDomain: any,
  parent_url: any
) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_URL, parent_url, {
    httpOnly: true,
  });
}

function setPlanCookie(
  req: any,
  res: any,
  setOnPolisDomain: boolean,
  planNumber: number
) {
  if (planNumber > 0) {
    setCookie(req, res, setOnPolisDomain, COOKIES.PLAN_NUMBER, planNumber, {
      // not httpOnly - needed by JS
    });
  }
  // else falsy
}

function setHasEmailCookie(
  req: any,
  res: any,
  setOnPolisDomain: boolean,
  email: any
) {
  if (email) {
    setCookie(req, res, setOnPolisDomain, COOKIES.HAS_EMAIL, 1, {
      // not httpOnly - needed by JS
    });
  }
  // else falsy
}

function setUserCreatedTimestampCookie(
  req: any,
  res: any,
  setOnPolisDomain: boolean,
  timestamp: any
) {
  setCookie(
    req,
    res,
    setOnPolisDomain,
    COOKIES.USER_CREATED_TIMESTAMP,
    timestamp,
    {
      // not httpOnly - needed by JS
    }
  );
}

function setTokenCookie(
  req: any,
  res: any,
  setOnPolisDomain: boolean,
  token: any
) {
  setCookie(req, res, setOnPolisDomain, COOKIES.TOKEN, token, {
    httpOnly: true,
  });
}

function setUidCookie(req: any, res: any, setOnPolisDomain: boolean, uid: any) {
  setCookie(req, res, setOnPolisDomain, COOKIES.UID, uid, {
    // not httpOnly - needed by JS
  });
}

function setPermanentCookie(
  req: any,
  res: any,
  setOnPolisDomain: boolean,
  token: any
) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PERMANENT_COOKIE, token, {
    httpOnly: true,
  });
}

function setCookieTestCookie(req: any, res: any, setOnPolisDomain: any) {
  setCookie(req, res, setOnPolisDomain, COOKIES.COOKIE_TEST, 1, {
    // not httpOnly - needed by JS
  });
}

function shouldSetCookieOnPolisDomain(req: Req) {
  // FIXME domainOverride
  let setOnPolisDomain = !(config.get('domain_override') || null);
  let origin = req?.headers?.origin || "";
  if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
    setOnPolisDomain = false;
  }
  return setOnPolisDomain;
}

function addCookies(
  req: { cookies: { [x: string]: any } },
  res: { header: (arg0: string, arg1: any) => void },
  token: any,
  uid: any
) {
  return User.getUserInfoForUid2(uid).then(function (o: {
    email: any;
    created: any;
    plan: any;
  }) {
    let email = o.email;
    let created = o.created;
    let plan = o.plan;

    let setOnPolisDomain = shouldSetCookieOnPolisDomain(req);

    setTokenCookie(req, res, setOnPolisDomain, token);
    setUidCookie(req, res, setOnPolisDomain, uid);
    setPlanCookie(req, res, setOnPolisDomain, plan);
    setHasEmailCookie(req, res, setOnPolisDomain, email);
    setUserCreatedTimestampCookie(req, res, setOnPolisDomain, created);
    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      setPermanentCookie(
        req,
        res,
        setOnPolisDomain,
        Session.makeSessionToken()
      );
    }
    res.header("x-polis", token);
  });
}

function getPermanentCookieAndEnsureItIsSet(
  req: { cookies: { [x: string]: any } },
  res: any
) {
  let setOnPolisDomain = shouldSetCookieOnPolisDomain(req);
  if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
    let token = Session.makeSessionToken();
    setPermanentCookie(req, res, setOnPolisDomain, token);
    return token;
  } else {
    return req.cookies[COOKIES.PERMANENT_COOKIE];
  }
}

export {
  COOKIES,
  COOKIES_TO_CLEAR,
  setCookie,
  setParentReferrerCookie,
  setParentUrlCookie,
  setPlanCookie,
  setPermanentCookie,
  setCookieTestCookie,
  shouldSetCookieOnPolisDomain,
  addCookies,
  getPermanentCookieAndEnsureItIsSet,
};

export default {
  COOKIES,
  COOKIES_TO_CLEAR,
  setCookie,
  setParentReferrerCookie,
  setParentUrlCookie,
  setPlanCookie,
  setPermanentCookie,
  setCookieTestCookie,
  shouldSetCookieOnPolisDomain,
  addCookies,
  getPermanentCookieAndEnsureItIsSet,
};
