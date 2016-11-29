// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

var _ = require("underscore");

var store = (function() {
  // Using cookies because IE can have crazy security settings that make localStorage off-limits.
  // We may want

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

  // function setCookie(sName,sValue)
  // {
  //     if (sValue === void 0) {
  //         return;
  //     }
  //     var oDate = new Date();
  //     oDate.setYear(oDate.getFullYear()+1);
  //     var sCookie = encodeURIComponent(sName) + "=" + encodeURIComponent(sValue) + ";expires=" + oDate.toGMTString() + ";path=/";
  //     document.cookie = sCookie;
  // }

  // function clearCookie(sName)
  // {
  //     setCookie(sName,null);
  // }
  // We might want to use localStorage for browsers that don't throw exceptions when you try to use their localStorage implementation.
  // return {
  //     set: localStorage.setItem,
  //     get: localStorage.getItem,
  //     clear: localStorage.clear
  // };
  return {
    // clear: clearCookie,
    // set: setCookie,
    get: function(key) {
      var cookieVal = getCookie(key);
      if (cookieVal === null) {
        // Beta Migration
        // Should be OK to remove this block (and simply call getCookie) sometime early 2014
        try {
          // Initially we used localStorage, but switched to cookies because of IE10 localStorage exceptions for certain security configurations.
          // This is here for now so existing user sessions will keep working.
          // previously, localStorage keys were prefixed with "p_", removing now to minimize extra cookie traffic.
          var lsVal = localStorage.getItem("p_" + key);
          if (lsVal !== null) {
            setCookie(key, lsVal);
          }
          return lsVal;
        } catch (e) {
          // probably IE with localStorage disabled, nothing to migrate here anyway.
        }
      }
      return cookieVal;
    }

  };
}());

// function clear(k) {
//     store.clear(k);
// }

function makeAccessor(k) {
  return {
    // clear: function() {
    //     return clear(k);
    // },
    // set: function(v, temporary) {
    //     return store.set(k, v);
    // },
    get: function() {
      return store.get(k);
    }
  };
}

function toNumberWithFalsyAsZero(val) {
  if (_.isUndefined(val)) {
    return 0;
  } else {
    return Number(val);
  }
}


function getUidFromUserObject() {
  return window.preload && window.preload.firstUser && window.preload.firstUser.uid;
}

function getPlanCodeFromUserObject() {
  return window.preload && window.preload.firstUser && window.preload.firstUser.planCode || 0;
}

function userCreated() {
  return toNumberWithFalsyAsZero(window.preload && window.preload.firstUser && window.preload.firstUser.created) || Date.now();
}

module.exports = {
  hasEmail: makeAccessor("e").get,
  uidFromCookie: makeAccessor("uid2").get,
  uid: getUidFromUserObject,
  planCode: getPlanCodeFromUserObject,
  userCreated: userCreated
};
