import _ from "underscore";
import url from "url";

import Config from "../config";
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
};
