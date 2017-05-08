import React from "react";
import _ from "lodash";

const BarChartCompact = ({selectedComment, groupVotes, translate}) => {

  if (!selectedComment) return null;

  let groupVotesForThisComment = groupVotes.votes[selectedComment.tid];
  let agrees = groupVotesForThisComment.A;
  let disagrees = groupVotesForThisComment.D;
  let sawTheComment = groupVotesForThisComment.S;
  let passes = sawTheComment - (agrees + disagrees);
  let totalVotes = agrees + disagrees + passes;
  let nMembers = groupVotes["n-members"];

  const agree = agrees / nMembers * 100;
  const disagree = disagrees / nMembers * 100;
  const pass = passes / nMembers * 100;
  const blank = nMembers - sawTheComment / nMembers * 100;

  return (
    <g transform={translate ? translate : "translate(100, 100)"}>
      <rect x={0} width={agree} height={10} fill={"rgb(46, 204, 113)"} />
      <rect x={agree} width={disagree} height={10} fill={"rgb(231, 76, 60)"} />
      <rect x={agree + disagree} width={pass} height={10} fill={"rgb(230,230,230)"} />
      <rect x={agree + disagree + pass} y={2} width={blank} height={8} fill={"white"} stroke={"rgb(130,130,130)"} />
    </g>
  )
};

export default BarChartCompact;
