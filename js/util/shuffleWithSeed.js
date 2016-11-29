// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
