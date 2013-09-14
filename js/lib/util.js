function RandomWithSeed(x) {
    return function(min, max) {
        if (max == null) {
            max = min;
            min = 0;
        }
        return min + Math.floor(
            (x = Number('0.'+Math.sin(x).toString().substr(6))) // dave-scotese http://stackoverflow.com/questions/521295/javascript-random-seeds
             * (max - min + 1));
    };
}

function shuffleWithSeed(array, seed) {
    var seq = RandomWithSeed(seed);
    if (seed == null) {
        seq = Math.random;
    }
    var rand;
    var index = 0;
    var shuffled = [];
    _.each(array, function(value) {
      rand = seq(index++);
      shuffled[index - 1] = shuffled[rand];
      shuffled[rand] = value;
    });
    return shuffled;
}


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



window.PolisStorage = function() {
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
                
    function makeMapAccessor(accessor) {
        var oldGet = accessor.get;
        accessor.get = function(key) {
            return (JSON.parse(oldGet()) || {})[key];
        };
        var oldSet = accessor.set;
        accessor.set = function(key, val, temporary) {
            var o = JSON.parse(oldGet()) || {};
            o[key] = val;
            oldSet(JSON.stringify(o), temporary);
        };
        return accessor;
    }

    function castToNumber(accessor) {
        var oldGet = accessor.get;
        accessor.get = function(key) {
            return Number(oldGet());
        };
        return accessor;
    }

    function clearAll() {
        for (var key in x) {
            if (x[key].clear) {
                x[key].clear();
            }
        }
    }

    var x = {
        clearAll: clearAll,
        comments: makeAccessor('p_comments'), // TODO use a real db
        reactionsByMe: makeAccessor('p_reactions_by_me'), // TODO use a real db
        email: makeAccessor('p_email'),
        username: makeAccessor('p_username'),
        uid: makeAccessor('p_uid'),
        pids: makeMapAccessor(makeAccessor('p_pids')),
        token: makeAccessor('p_authToken')
    };
    return x;
}();
