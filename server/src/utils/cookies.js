import _ from 'underscore';
import url from 'url';
import Config from '../config.js';
import User from '../user.js';
import Session from '../session.js';
const COOKIES = {
  COOKIE_TEST: 'ct',
  HAS_EMAIL: 'e',
  TOKEN: 'token2',
  UID: 'uid2',
  REFERRER: 'ref',
  PARENT_REFERRER: 'referrer',
  PARENT_URL: 'parent_url',
  USER_CREATED_TIMESTAMP: 'uc',
  PERMANENT_COOKIE: 'pc',
  TRY_COOKIE: 'tryCookie'
};
const COOKIES_TO_CLEAR = {
  e: true,
  token2: true,
  uid2: true,
  uc: true,
  referrer: true,
  parent_url: true
};
let oneYear = 1000 * 60 * 60 * 24 * 365;
function cookieDomain(req) {
  const origin = req?.headers?.origin || '';
  const parsedOrigin = url.parse(origin);
  if (parsedOrigin.hostname === 'localhost') {
    return 'localhost';
  }
  if (Config.domainOverride) {
    return `.${Config.domainOverride}`;
  }
  return `.${Config.getServerHostname()}`;
}
function setCookie(req, res, name, value, options) {
  const opts = _.clone(options || {});
  opts.path = _.isUndefined(opts.path) ? '/' : opts.path;
  opts.maxAge = _.isUndefined(opts.maxAge) ? oneYear : opts.maxAge;
  const origin = req?.headers?.origin || '';
  const parsedOrigin = url.parse(origin);
  opts.secure = parsedOrigin.protocol === 'https:';
  opts.domain = cookieDomain(req);
  res.cookie(name, value, opts);
}
function setParentReferrerCookie(req, res, referrer) {
  setCookie(req, res, COOKIES.PARENT_REFERRER, referrer, {
    httpOnly: true
  });
}
function setParentUrlCookie(req, res, parent_url) {
  setCookie(req, res, COOKIES.PARENT_URL, parent_url, {
    httpOnly: true
  });
}
function setHasEmailCookie(req, res, email) {
  if (email) {
    setCookie(req, res, COOKIES.HAS_EMAIL, 1, {});
  }
}
function setUserCreatedTimestampCookie(req, res, timestamp) {
  setCookie(req, res, COOKIES.USER_CREATED_TIMESTAMP, timestamp, {});
}
function setTokenCookie(req, res, token) {
  setCookie(req, res, COOKIES.TOKEN, token, {
    httpOnly: true
  });
}
function setUidCookie(req, res, uid) {
  setCookie(req, res, COOKIES.UID, uid, {});
}
function setPermanentCookie(req, res, token) {
  setCookie(req, res, COOKIES.PERMANENT_COOKIE, token, {
    httpOnly: true
  });
}
function setCookieTestCookie(req, res) {
  setCookie(req, res, COOKIES.COOKIE_TEST, 1, {});
}
function addCookies(req, res, token, uid) {
  return User.getUserInfoForUid2(uid).then(function (opts) {
    let email = opts.email;
    let created = opts.created;
    setTokenCookie(req, res, token);
    setUidCookie(req, res, uid);
    setHasEmailCookie(req, res, email);
    setUserCreatedTimestampCookie(req, res, created);
    if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
      setPermanentCookie(req, res, Session.makeSessionToken());
    }
    res.header('x-polis', token);
  });
}
function getPermanentCookieAndEnsureItIsSet(req, res) {
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
  getPermanentCookieAndEnsureItIsSet
};
