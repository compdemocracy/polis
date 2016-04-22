var RandomWithSeed = require("../util/randomWithSeed");

module.exports = function(array, seed) {
  var seq = new RandomWithSeed(seed);
  if (seed === null) {
    seq = Math.random;
  }
  var rand;
  var shuffled = array.slice();
  _.each(array, function(value, index) {
    rand = seq(index);
    shuffled[index] = shuffled[rand];
    shuffled[rand] = value;
  });
  return shuffled;
};
