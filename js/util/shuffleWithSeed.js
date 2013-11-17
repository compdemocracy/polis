define([
  "util/randomWithSeed"
], function (RandomWithSeed) {

return function(array, seed) {
    var seq = RandomWithSeed(seed);
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

});
