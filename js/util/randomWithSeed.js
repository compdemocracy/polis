module.exports = function(x) {
  return function(min, max) {
    if (max === null || max === void 0) {
      max = min;
      min = 0;
    }
    return min + Math.floor(
      // dave-scotese http://stackoverflow.com/questions/521295/javascript-random-seeds
      (x = Number("0." + Math.sin(x).toString().substr(6))) * (max - min + 1));
  };
};
