import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import BarChart from "./barChart";

const BarChartsForGroupVotes = ({selectedComment, allComments, groupVotes}) => {

  // console.log('four bar charts', selectedComment, allComments, groupVotes)

  //   return (
  //     <g>
        // {/**/}
  //     </g>
  //   )

  const drawBarChartsForGroupVotesOnSelectedComment = () => {
    let barCharts = [];
    _.each(groupVotes, (group, i) => {
      if (i === 0) {
        barCharts.push(
          <BarChart
            comment={selectedComment}
            groupVotes={group}
            ptptCount={100}/>
        )
      }
    })
    return barCharts;
  }

  return (
    <g transform="translate(200,200)">
      <circle r={10}/>
      {selectedComment ? drawBarChartsForGroupVotesOnSelectedComment() : null}
    </g>
  )

}

export default BarChartsForGroupVotes;


// const allCommentsKeyed = _.keyBy(allComments, "tid");
// return groupComments.map((c, i) => {
//   if (!allCommentsKeyed[c.tid]) {
//     console.log('modded out?', c.tid);
//     return "";
//   }
//   // const groupVotes = math["group-votes"][gid].votes[comment.tid];
//   // const isBestAgree = comment["best-agree"] && (groupVotes && groupVotes.A > 0);
//   // const agree = isBestAgree || comment["repful-for"] === "agree";
//   // const percent = agree ?
//   // Math.floor(groupVotes.A / groupVotes.S * 100) :
//   // Math.floor(groupVotes.D / groupVotes.S * 100);

// })
