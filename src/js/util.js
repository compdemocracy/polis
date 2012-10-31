var utils = function() {
    function isNumber(x) {
        return !isNaN(parseFloat(x)) && isFinite(x);
    }
    return {
        isNumber: isNumber
    };
}();
