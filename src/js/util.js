var utils = function() {
    function isNumber(x) {
        return !isNaN(parseFloat(x)) && isFinite(x);
    }
    return {
        isNumber: isNumber
    };
}();


var PolisStorage = function() {
    var cache = {
    };
    function saveAndCache(k, v) {
        if (cache[k] !== v) {
            window.localStorage.setItem(k, v);
            cache[k] = v;
        }
    }
    function retrieveWithCache(k) {
        var cached = cache[v];
        if (cached) {
            return cached;
        } else {
            var v = window.localStorage.getItem(k);
            cache[k] = v;
            return v;
        }
    }
    function clear(k) {
        delete cache[k];
        window.localStorage.clear(k);
    }

    function makeAccessor(k) {
        return {
            clear: function() {
                return clear(k);
            },
            set: function(v) {
                return saveAndCache(k, v);
            },
            get: function() {
                return retrieveWithCache(k);
            }
        };
    }
                

    return {
        token: makeAccessor('p_authToken'),
        username: makeAccessor('p_username')
    };
}();

