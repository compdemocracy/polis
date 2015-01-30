var _ = require("underscore");

var store = (function() {
    // Using cookies because IE can have crazy security settings that make localStorage off-limits.
    // We may want

    //http://stackoverflow.com/questions/19189785/is-there-a-good-cookie-library-for-javascript
    function getCookie(sName)
    {
        sName = sName.toLowerCase();
        var oCrumbles = document.cookie.split(";");
        for(var i=0; i<oCrumbles.length;i++)
        {
            var oPair= oCrumbles[i].split("=");
            var sKey = oPair[0].trim().toLowerCase();
            var sValue = oPair.length>1?oPair[1]:"";
            if(sKey === sName) {
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
                } catch(e) {
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

    function makeCookieValueGetterForKeyWithSuffix(suffix) {
        return function(key) {
            key += suffix;
            return store.get(key);
        };
    }
    function asNumber(getter) {
        return function(key) {
            return Number(getter(key));
        };
    }
    function toNumberWithFalsyAsZero(val) {
        if (_.isUndefined(val)) {
            return 0;
        } else {
            return Number(val);
        }
    }
    function asNumberWithFalsyAsZero(getter) {
        return function(key) {
            var val = getter(key);
            return toNumberWithFalsyAsZero(val);
        };
    }

    // function makeMapAccessor(accessor) {
    //     var oldGet = accessor.get;
    //     accessor.get = function(key) {
    //         return ( oldGet() && JSON.parse(oldGet()) || {})[key];
    //     };
    //     var oldSet = accessor.set;
    //     accessor.set = function(key, val, temporary) {
    //         var o = oldGet() && JSON.parse(oldGet()) || {};
    //         o[key] = val;
    //         oldSet(JSON.stringify(o), temporary);
    //     };
    //     return accessor;
    // }

    // function castToNumber(accessor) {
    //     var oldGet = accessor.get;
    //     accessor.get = function(key) {
    //         return Number(oldGet());
    //     };
    //     return accessor;
    // }

    // function clearAll() {
    //     for (var key in x) {
    //         if (x[key].clear) {
    //             x[key].clear();
    //         }
    //     }
    // }


    // stored in RAM only
    // var pid = -1;
    // function setPid(newPid) {
    //     pid = newPid;
    // }
    // function getPid() {
    //     return pid;
    // }
    // var pidRamStore = {
    //     set: setPid,
    //     get: getPid
    // };

function getUidFromUserObject() {
    return window.userObject && window.userObject.uid;
}
function getPlanFromUserObject() {
    return window.userObject && window.userObject.plan || 0;
}
function userCreated() {
    return toNumberWithFalsyAsZero(window.userObject && window.userObject.created) || Date.now();
}
module.exports = {
        // pids: asNumber(makeCookieValueGetterForKeyWithSuffix("p")) // p for pid, expecting keys like 314p=2; 451p=12
        // pid: pidRamStore,
        // clearAll: clearAll,
        //comments: makeAccessor("p_comments"), // TODO use a real db
        //reactionsByMe: makeAccessor("p_reactions_by_me"), // TODO use a real db
        hasEmail: makeAccessor("e").get,
        // email: makeAccessor("email").get,
        //username: makeAccessor("p_username"),
        uidFromCookie: makeAccessor("uid2").get,
        uid: getUidFromUserObject,
        plan: getPlanFromUserObject,
        userCreated: userCreated

        //token: makeAccessor("p_authToken")
    };
