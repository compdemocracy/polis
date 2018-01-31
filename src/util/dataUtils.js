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

