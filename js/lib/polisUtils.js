
function isPersonId(x) {
    return _.isString(x);
}

var bad = (function(errorLogger){ 
    return function bad(obj, key, optionalChecker) {
        var ok = obj && obj[key];
        if (optionalChecker) {
            ok &= optionalChecker(obj[key]);
        }
        if (!ok) {
            errorLogger("missing or invalid: " + key);
        }
        return ok;
    };
}());


function isPersonNode(d) {
    return !(d && d.children && d.children.length);
}
