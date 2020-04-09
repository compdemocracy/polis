// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";


function getVoteTotals(math_main) {
  var x = {};
  var gv = math_main["group-votes"];
  _.each(gv, function(data, gid) {
    _.each(data.votes, function(counts, tid) {
      var z = x[tid] = x[tid] || {agreed:0, disagreed:0, saw:0};
      z.agreed += counts.A;
      z.disagreed += counts.D;
      z.saw += counts.S;
    });
  });
  _.each(x, function(z) {
    z.pctAgreed = z.agreed / z.saw;
    z.pctDisagreed = z.disagreed / z.saw;
    z.pctVoted = (z.saw - z.disagreed - z.agreed) / z.saw;
  });
  return x;
}

const dataUtils = {
  getVoteTotals: getVoteTotals,
};
export default dataUtils;

