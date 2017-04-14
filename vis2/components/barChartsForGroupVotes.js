import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import BarChart from "./barChart";

const BarChartsForGroupVotes = ({selectedComment, allComments, groups}) => {

  const translations = ["translate(-40,0)", "translate(-40, 650)", "translate(500,10)", "translate(500,650)"]

  const drawBarChartsForGroupVotesOnSelectedComment = () => {
    let arr = []
    _.each(groups, (group, i) => {
      arr.push(
        <BarChart
          key={i}
          selectedComment={selectedComment}
          groupVotes={group /* hardcode first group for debug */}
          translate={translations[i]}
          ptptCount={"ptptCount doesn't matter and isn't used because this barchart is for a group, not global"}/>
      )
    })
    return arr;
  }

  return (
    <g transform="translate(0,10)">
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
