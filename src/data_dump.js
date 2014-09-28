
var mongo = require('mongodb'),
    sql = require('sql'),
    _ = require('underscore');


// schema:
//   participant_id, <email/username/name/whatever-applies>,
//     joined, group_id, n_votes, n_aggres, n_disagrees, n_passes, n_not_seen, n_comments,
//     <comments>


function getDataDump(zid) {
  var mathData = getPca(zid, 0);
  var rawVotes = 
}



