define(function() {
	return function(x) {
    return function(min, max) {
        if (max == null) {
            max = min;
            min = 0;
        }
        return min + Math.floor(
            (x = Number('0.'+Math.sin(x).toString().substr(6))) // dave-scotese http://stackoverflow.com/questions/521295/javascript-random-seeds
             * (max - min + 1));
    };
  };
});