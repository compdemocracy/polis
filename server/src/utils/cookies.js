const _ = require('underscore');
const User = require('../user');
const Session = require('../session');


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
  TRY_COOKIE: 'tryCookie',
  PLAN_NUMBER: 'plan', // not set if trial user
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

function setCookie(req, res, setOnPolisDomain, name, value, options) {
  let o = _.clone(options || {});
  o.path = _.isUndefined(o.path) ? '/' : o.path;
  o.maxAge = _.isUndefined(o.maxAge) ? oneYear : o.maxAge;
  if (setOnPolisDomain) {
    o.secure = _.isUndefined(o.secure) ? true : o.secure;
    o.domain = _.isUndefined(o.domain) ? '.pol.is' : o.domain;
    // if (/pol.is/.test(req.headers.host)) {
    //   o.domain = '.pol.is';
    // }
  }
  res.cookie(name, value, o);
}

function setParentReferrerCookie(req, res, setOnPolisDomain, referrer) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_REFERRER, referrer, {
    httpOnly: true,
  });
}

function setParentUrlCookie(req, res, setOnPolisDomain, parent_url) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PARENT_URL, parent_url, {
    httpOnly: true,
  });
}

function setPlanCookie(req, res, setOnPolisDomain, planNumber) {
  if (planNumber > 0) {
    setCookie(req, res, setOnPolisDomain, COOKIES.PLAN_NUMBER, planNumber, {
      // not httpOnly - needed by JS
    });
  }
  // else falsy

}

function setHasEmailCookie(req, res, setOnPolisDomain, email) {
  if (email) {
    setCookie(req, res, setOnPolisDomain, COOKIES.HAS_EMAIL, 1, {
      // not httpOnly - needed by JS
    });
  }
  // else falsy
}

function setUserCreatedTimestampCookie(req, res, setOnPolisDomain, timestamp) {
  setCookie(req, res, setOnPolisDomain, COOKIES.USER_CREATED_TIMESTAMP, timestamp, {
    // not httpOnly - needed by JS
  });
}

function setTokenCookie(req, res, setOnPolisDomain, token) {
  setCookie(req, res, setOnPolisDomain, COOKIES.TOKEN, token, {
    httpOnly: true,
  });
}

function setUidCookie(req, res, setOnPolisDomain, uid) {
  setCookie(req, res, setOnPolisDomain, COOKIES.UID, uid, {
    // not httpOnly - needed by JS
  });
}

function setPermanentCookie(req, res, setOnPolisDomain, token) {
  setCookie(req, res, setOnPolisDomain, COOKIES.PERMANENT_COOKIE, token, {
    httpOnly: true,
  });
}

function setCookieTestCookie(req, res, setOnPolisDomain) {
  setCookie(req, res, setOnPolisDomain, COOKIES.COOKIE_TEST, 1, {
    // not httpOnly - needed by JS
  });
}

function shouldSetCookieOnPolisDomain(req) {
  // FIXME domainOverride
  let setOnPolisDomain = !(process.env.DOMAIN_OVERRIDE || null);
  let origin = req.headers.origin || "";
  if (setOnPolisDomain && origin.match(/^http:\/\/localhost:[0-9]{4}/)) {
    setOnPolisDomain = false;
  }
  return setOnPolisDomain;
}

function addCookies(req, res, token, uid) {
  return User.getUserInfoForUid2(uid).then(function(o) {
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
      setPermanentCookie(req, res, setOnPolisDomain, Session.makeSessionToken());
    }
    res.header("x-polis", token);
  });
}

function getPermanentCookieAndEnsureItIsSet(req, res) {
  let setOnPolisDomain = shouldSetCookieOnPolisDomain(req);
  if (!req.cookies[COOKIES.PERMANENT_COOKIE]) {
    let token = Session.makeSessionToken();
    setPermanentCookie(req, res, setOnPolisDomain, token);
    return token;
  } else {
    return req.cookies[COOKIES.PERMANENT_COOKIE];
  }
}

module.exports = {
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
  getPermanentCookieAndEnsureItIsSet
};
