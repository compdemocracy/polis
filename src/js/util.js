var utils = function() {
    function isNumber(x) {
        return !isNaN(parseFloat(x)) && isFinite(x);
    }
    return {
        isNumber: isNumber
    };
}();

function assemble() {
    var obj = {};
    for (var i = 0; i < arguments.length; i++) {
        var candidateKvPairs = arguments[i];
        for( var k in candidateKvPairs) {
            if (candidateKvPairs.hasOwnProperty(k)) {
                if (candidateKvPairs[k] !== undefined) {
                    obj[k] = candidateKvPairs[k];
                }
            }
        }
    }
    return obj;
}


var PolisStorage = function() {
    var cache = {
    };
    function saveAndCache(k, v, temporary) {
        if (cache[k] !== v) {
            if (!temporary) {
                window.localStorage.setItem(k, v);
            }
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
            set: function(v, temporary) {
                return saveAndCache(k, v, temporary);
            },
            get: function() {
                return retrieveWithCache(k);
            }
        };
    }
                

    return {
        comments: makeAccessor('p_comments'), // TODO use a real db
        reactionsByMe: makeAccessor('p_reactions_by_me'), // TODO use a real db
        email: makeAccessor('p_email'),
        username: makeAccessor('p_username'),
        token: makeAccessor('p_authToken')
    };
}();

