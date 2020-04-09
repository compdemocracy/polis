// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("underscore");
var anonPicBase64 = require("../images/anon_profile");
var PolisStorage = require("./polisStorage");

var millisPerDay = 1000 * 60 * 60 * 24;

function millisSinceJoin() {
  return Date.now() - PolisStorage.userCreated();
}

function daysSinceJoin() {
  console.log('daysSinceJoin', millisSinceJoin(), millisPerDay);
  return (millisSinceJoin() / millisPerDay) >> 0;
}

function numberOfDaysInTrial() {
  return (window.userObject && window.userObject.daysInTrial) || 10;
}

function trialDaysRemaining() {
  console.log('trial', numberOfDaysInTrial(), daysSinceJoin());

  return Math.max(0, numberOfDaysInTrial() - daysSinceJoin());
}

function mapObj(o, f) {
  var out = {};

  var ff = _.isFunction(f) ? function(val, key) {
    out[key] = f(val, key);
  } : function(val, key) {
    out[key] = o[key];
  };
  _.each(o, ff);
  return out;
}

// http://stackoverflow.com/questions/8112634/jquery-detecting-cookies-enabled
function are_cookies_enabled() {
  if (("" + document.cookie).length > 0) {
    return true;
  }
  // var cookieEnabled = (navigator.cookieEnabled) ? true : false;

  // if (typeof navigator.cookieEnabled == "undefined" && !cookieEnabled)
  // {

  // create a temporary cookie
  var soon = new Date(Date.now() + 1000).toUTCString();
  var teststring = "_polistest_cookiesenabled";
  document.cookie = teststring + "=1; expires=" + soon;
  // see if it worked
  var cookieEnabled = document.cookie.indexOf(teststring) !== -1;
  console.log("cookieEnabled  " + cookieEnabled + " " + document.cookie);

  // clear the cookie
  document.cookie = teststring + "=; expires=" + (new Date(0)).toUTCString();

  // }
  return cookieEnabled;
}

//http://stackoverflow.com/questions/19189785/is-there-a-good-cookie-library-for-javascript
function getCookie(sName) {
  sName = sName.toLowerCase();
  var oCrumbles = document.cookie.split(";");
  for (var i = 0; i < oCrumbles.length; i++) {
    var oPair = oCrumbles[i].split("=");
    var sKey = oPair[0].trim().toLowerCase();
    var sValue = oPair.length > 1 ? oPair[1] : "";
    if (sKey === sName) {
      var val = decodeURIComponent(sValue);
      if (val === "null") {
        val = null;
      }
      return val;
    }
  }
  return null;
}


function strToHex(str) {
  var hex, i;
  var result = "";
  for (i = 0; i < str.length; i++) {
    hex = str.charCodeAt(i).toString(16);
    result += ("000" + hex).slice(-4);
  }
  return result;
}

function hexToStr(hexString) {
  var j;
  var hexes = hexString.match(/.{1,4}/g) || [];
  var str = "";
  for (j = 0; j < hexes.length; j++) {
    str += String.fromCharCode(parseInt(hexes[j], 16));
  }
  return str;
}

function decodeParams(encodedStringifiedJson) {
  if (!encodedStringifiedJson.match(/^\/?ep1_/)) {
    throw new Error("wrong encoded params prefix");
  }
  if (encodedStringifiedJson[0] === "/") {
    encodedStringifiedJson = encodedStringifiedJson.slice(5);
  } else {
    encodedStringifiedJson = encodedStringifiedJson.slice(4);
  }
  var stringifiedJson = hexToStr(encodedStringifiedJson);
  var o = JSON.parse(stringifiedJson);
  return o;
}

function encodeParams(o) {
  if (!o || !_.keys(o).length) {
    return "";
  }
  var stringifiedJson = JSON.stringify(o);
  var encoded = "ep1_" + strToHex(stringifiedJson);
  return encoded;
}

function isInIframe() {
  /*eslint-disable */
  /* jshint ignore:start */
  return window.top != window;
  /* jshint ignore:end */
  /*eslint-enable */
}

// http://www.html5rocks.com/en/tutorials/pagevisibility/intro/
function getHiddenProp() {
  var prefixes = ['webkit', 'moz', 'ms', 'o'];

  // if 'hidden' is natively supported just return it
  if ('hidden' in document) {
    return 'hidden';
  }

  // otherwise loop over all the known prefixes until we find one
  for (var i = 0; i < prefixes.length; i++) {
    if ((prefixes[i] + 'Hidden') in document) {
      return prefixes[i] + 'Hidden';
    }
  }

  // otherwise it's not supported
  return null;
}

function isHidden() {
  var prop = getHiddenProp();
  if (!prop) {
    return false;
  }

  return document[prop];
}

function shouldFocusOnTextareaWhenWritePaneShown() {
  // Not when we're embedded in an iframe.
  //  it ends up stealing focus and causing the parent to scroll to our iframe.
  //  (this happens where there are no comments to vote on, and we show the write tab first)
  // return !isInIframe();
  return false;
}

function parseQueryParams(s) {
  if (!_.isString(s)) {
    return {};
  }
  if (s.charAt(0) === "?") {
    s = s.slice(1);
  }
  var pairStrings = s.split("&");
  var pairArrays = _.map(pairStrings, function(pairString) {
    return pairString.split("=");
  });
  return _.object(pairArrays);
}

function toQueryParamString(o) {
  var pairs = _.pairs(o);
  pairs = _.map(pairs, function(pair) {
    return pair[0] + '=' + encodeURIComponent(pair[1]);
  });
  return pairs.join("&");
}

function toUnitVector(x, y) {
  var magnitude = Math.sqrt(x * x + y * y);
  if (magnitude === 0) {
    return [0, 0];
  }
  return [x / magnitude, y / magnitude];
}


function argMin(items, f) {
  var lowestVal = Infinity;
  var lowestItem = null;
  if (!items) {
    return lowestItem;
  }
  for (var i = 0; i < items.length; i++) {
    var candidate = items[i];
    var candidateVal = f(candidate);
    if (candidateVal < lowestVal) {
      lowestVal = candidateVal;
      lowestItem = candidate;
    }
  }
  return lowestItem;
}

function argMax(items, f) {
  var highestVal = -Infinity;
  var highestItem = null;
  if (!items) {
    return highestItem;
  }
  for (var i = 0; i < items.length; i++) {
    var candidate = items[i];
    var candidateVal = f(candidate);
    if (candidateVal > highestVal) {
      highestVal = candidateVal;
      highestItem = candidate;
    }
  }
  return highestItem;
}

function evenlySample(items, maxSample) {
  if (!items || items.length < maxSample) {
    return items;
  }
  var len = items.length;
  var step = Math.floor(len / maxSample);
  var newItems = [];
  var gotLast = false;
  for (var i = 0; i < items.length; i += step) {
    newItems.push(items[i]);
    if (i === len - 1) {
      gotLast = true;
    }
  }
  if (!gotLast) {
    newItems.push(items[len - 1]);
  }
  return newItems;
}

function getBestTranslation(translations, lang) {
  var firstTwoOfLang = lang.substr(0,2);
  var matchingLang = _.filter(translations, function(t) {
    return t.lang.indexOf(firstTwoOfLang) === 0;
  });
  matchingLang.sort(function(a, b) {
    if (a.lang !== b.lang) {
      // prefer exact language match
      if (a.lang === lang) {
        return -1;
      } else if (b.lang === lang) {
        return 1;
      }
    }
    // prefer human translations
    if (a.src > 0) {
      return -1;
    }
    if (b.src > 0) {
      return 1;
    }
    return 0;
  });
  return matchingLang;
}


function uiLanguage() {
  var params = parseQueryParams(window.location.search);
  var lang = params.ui_lang;
  if (_.isUndefined(lang)) {
    return window.preload.acceptLanguage && window.preload.acceptLanguage.substr(0,2) || null;
    // return null;
  }
  return lang;
}

function matchesUiLang(lang) {
  var firstTwoOfLang = lang.substr(0,2);
  var firstTwoOfUiLang = uiLanguage().substr(0,2);
  return firstTwoOfLang === firstTwoOfUiLang;
}

function userCanVote() {
  var params = parseQueryParams(window.location.search);
  var ucv = params.ucv;
  ucv = (ucv === "true" || ucv === "1" || _.isUndefined(ucv));
  return ucv;
}

function userCanWrite() {
  var params = parseQueryParams(window.location.search);
  var ucw = params.ucw;
  ucw = (ucw === "true" || ucw === "1" || _.isUndefined(ucw));
  return ucw;
}

function userCanSeeTopic() {
  var params = parseQueryParams(window.location.search);
  var ucst = params.ucst;
  ucst = (ucst === "true" || ucst === "1" || _.isUndefined(ucst));
  return ucst;
}

function userCanSeeDescription() {
  var params = parseQueryParams(window.location.search);
  var ucsd = params.ucsd;
  ucsd = (ucsd === "true" || ucsd === "1" || _.isUndefined(ucsd));
  return ucsd;
}

function userCanSeeVis() {
  var params = parseQueryParams(window.location.search);
  var ucsv = params.ucsv;
  ucsv = (ucsv === "true" || ucsv === "1" || _.isUndefined(ucsv));
  return ucsv;
}

function userCanSeeFooter() {
  var params = parseQueryParams(window.location.search);
  var ucsf = params.ucsf;
  ucsf = (ucsf === "true" || ucsf === "1" || _.isUndefined(ucsf));
  if (!ucsf && !ownerCanDisableBranding()) {
    ucsf = true;
  }
  return ucsf;
}

function userCanSeeHelp() {
  var params = parseQueryParams(window.location.search);
  var ucsh = params.ucsh;
  ucsh = (ucsh === "true" || ucsh === "1" || _.isUndefined(ucsh));
  return ucsh;
}

function getSubscribeType() {
  var subscribe_type = window.preload.firstConv.subscribe_type;

  var params = parseQueryParams(window.location.search);
  var x = params.subscribe_type;
  if (!_.isUndefined(x)) {
    subscribe_type = x;
  }
  return subscribe_type;
}

function userCanSeeSubscribePrompt() {
  var x = getSubscribeType();
  // 1 is for email, there are no other options yet.
  x = (x === 1 || x === "1" || x === "true");
  return x;
}

function ownerCanDisableBranding() {
  return window.preload.firstConv.plan >= 99;
}

function getXid() {
  var params = parseQueryParams(window.location.search);
  return params.xid;
}

function getGroupAware() {
  var params = parseQueryParams(window.location.search);
  return params.groupAware;
}


// Return the {x: {min: #, max: #}, y: {min: #, max: #}}
module.exports = {
  uiLanguage: uiLanguage,
  matchesUiLang: matchesUiLang,
  userCanVote: userCanVote,
  userCanWrite: userCanWrite,
  userCanSeeTopic: userCanSeeTopic,
  userCanSeeDescription: userCanSeeDescription,
  userCanSeeVis: userCanSeeVis,
  userCanSeeFooter: userCanSeeFooter,
  userCanSeeHelp: userCanSeeHelp,
  userCanSeeSubscribePrompt: userCanSeeSubscribePrompt,
  argMax: argMax,
  argMin: argMin,
  mapObj: mapObj,
  computeXySpans: function(points) {
    var spans = {
      x: {
        min: Infinity,
        max: -Infinity
      },
      y: {
        min: Infinity,
        max: -Infinity
      }
    };
    for (var i = 0; i < points.length; i++) {
      if (points[i].proj) {
        spans.x.min = Math.min(spans.x.min, points[i].proj.x);
        spans.x.max = Math.max(spans.x.max, points[i].proj.x);
        spans.y.min = Math.min(spans.y.min, points[i].proj.y);
        spans.y.max = Math.max(spans.y.max, points[i].proj.y);
      }
    }
    return spans;
  },
  evenlySample: evenlySample,
  toUnitVector: toUnitVector,
  toQueryParamString: toQueryParamString,
  parseQueryParams: parseQueryParams,

  supportsSVG: function() {
    return !!document.createElementNS && !!document.createElementNS('http://www.w3.org/2000/svg', 'svg').createSVGRect;
  },
  isIE8: function() {
    return navigator.userAgent.match(/MSIE [89]/);
  },
  isIphone: function() {
    return navigator.userAgent.match(/iPhone/);
  },
  isIpad: function() {
    return navigator.userAgent.match(/iPad/);
  },
  isIos: function() {
    return this.isIpad() || this.isIphone();
  },
  isAndroid: function() {
    return navigator.userAgent.match(/Android/);
  },
  isOldAndroid: function() {
    return navigator.userAgent.match(/Android [012]\.[0-3]/);
  },
  isMobile: function() {
    return this.isIphone() || this.isIpad() || this.isAndroid();
  },
  isShortConversationId: function(conversation_id) {
    return conversation_id.length <= 6;
  },
  supportsVis: function() {
    return this.supportsSVG() && !this.isIE8();
  },
  isTrialUser: function() {
    return !PolisStorage.planCode();
  },
  isIndividualUser: function() {
    return PolisStorage.planCode() === 1;
  },
  isStudentUser: function() {
    return PolisStorage.planCode() === 2;
  },
  isPpUser: function() {
    return PolisStorage.planCode() === 3;
  },
  isEnterpriseUser: function() {
    return PolisStorage.planCode() === 1000;
  },
  getAnonPicUrl: function() {
    return anonPicBase64;
  },
  getBestTranslation: getBestTranslation,
  getCookie: getCookie,
  getGroupAware: getGroupAware,
  getGroupNameForGid: function(gid) {
    if (gid < 0) {
      return gid;
    } else if (!_.isNumber(gid)) {
      console.error("undexpected gid: " + gid);
    }
    return gid + 1;
  },
  getXid: getXid,
  isDemoMode: function() {
    return document.location.pathname.indexOf('/demo') === 0;
  },
  // toPercent: function(ratio) {
  //   return ((ratio * 100) >> 0) + "%";
  // },
  isInIframe: isInIframe,
  isHidden: isHidden,
  shouldFocusOnTextareaWhenWritePaneShown: shouldFocusOnTextareaWhenWritePaneShown,
  projectComments: false,
  debugCommentProjection: false,
  projectRepfulTids: true,
  hexToStr: hexToStr,
  strToHex: strToHex,
  decodeParams: decodeParams,
  encodeParams: encodeParams,
  numberOfDaysInTrial: numberOfDaysInTrial,
  trialDaysRemaining: trialDaysRemaining,
  cookiesEnabled: are_cookies_enabled
};
