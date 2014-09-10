var PolisStorage = require("./polisStorage");
var Url = require("./url");
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

// // http://stackoverflow.com/questions/8112634/jquery-detecting-cookies-enabled
// function are_cookies_enabled()
// {
//   if ((""+document.cookie).length > 0) {
//     console.log("cookieEnabled true " + document.cookie);
//     return true;
//   }
//     // var cookieEnabled = (navigator.cookieEnabled) ? true : false;

//     // if (typeof navigator.cookieEnabled == "undefined" && !cookieEnabled)
//     // { 

//     // create a temporary cookie 
//     var soon = new Date(Date.now() + 1000).toUTCString();
//     var teststring = "_polistest_cookiesenabled";
//     document.cookie = teststring + "=1; expires=" + soon;
//     // see if it worked
//     var cookieEnabled = document.cookie.indexOf(teststring) != -1;
//     console.log("cookieEnabled  " + cookieEnabled + " "+ document.cookie);

//     // clear the cookie
//     document.cookie = teststring + "=; expires=" + (new Date(0)).toUTCString();

//     // }
//     return cookieEnabled;
// }

function areServerSetCookiesEnabled() {
  console.log(Url.urlPrefix);
  return $.get(Url.urlPrefix + "api/v3/tryCookie").then(function() {
    return document.cookie.indexOf("tryCookie") >= 0;
  });
}

// Return the {x: {min: #, max: #}, y: {min: #, max: #}}
module.exports = {
  mapObj: mapObj,
  computeXySpans: function(points) {
    var spans = {
      x: { min: Infinity, max: -Infinity },
      y: { min: Infinity, max: -Infinity }
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
    return !PolisStorage.plan();
  },
  isIndividualUser: function() {
    return PolisStorage.plan() === 1;
  },
  isStudentUser: function() {
    return PolisStorage.plan() === 2;
  },
  isPpUser: function() {
    return PolisStorage.plan() === 3;
  },
  numberOfDaysInTrial: numberOfDaysInTrial,
  trialDaysRemaining: trialDaysRemaining,
  cookiesEnabled: areServerSetCookiesEnabled
};
