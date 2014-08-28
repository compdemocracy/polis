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
  return 10;
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
function are_cookies_enabled()
{
    var cookieEnabled = (navigator.cookieEnabled) ? true : false;

    if (typeof navigator.cookieEnabled == "undefined" && !cookieEnabled)
    { 
        document.cookie="testcookie";
        cookieEnabled = (document.cookie.indexOf("testcookie") != -1) ? true : false;
    }
    return (cookieEnabled);
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
  cookiesEnabled: are_cookies_enabled
};
