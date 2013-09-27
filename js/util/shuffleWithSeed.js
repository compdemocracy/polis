define([
  'util/randomWithSeed'
], function (RandomWithSeed) {

return function(array, seed) {
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
};

});
