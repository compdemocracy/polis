// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
