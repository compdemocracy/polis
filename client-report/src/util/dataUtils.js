// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const getVoteTotals = (math_main) => {
  const x = {};
  const gv = math_main["group-votes"];

  if (gv) {
    for (const gid in gv) {
      if (gv.hasOwnProperty(gid)) { // Important: check own properties
        const data = gv[gid];
        if (data && data.votes) {
          for (const tid in data.votes) {
            if (data.votes.hasOwnProperty(tid)) { // Important: check own properties
              const counts = data.votes[tid];
              x[tid] = x[tid] || { agreed: 0, disagreed: 0, saw: 0 };
              x[tid].agreed += counts?.A || 0;
              x[tid].disagreed += counts?.D || 0;
              x[tid].saw += counts?.S || 0;
            }
          }
        }
      }
    }
  }

  for (const tid in x) {
    if (x.hasOwnProperty(tid)) { // Important: check own properties
      const z = x[tid];
      z.pctAgreed = z.saw > 0 ? z.agreed / z.saw : 0;
      z.pctDisagreed = z.saw > 0 ? z.disagreed / z.saw : 0;
      z.pctVoted = z.saw > 0 ? (z.saw - z.disagreed - z.agreed) / z.saw : 0;
    }
  }
  return x;
};

const dataUtils = {
  getVoteTotals,
};

export default dataUtils;

