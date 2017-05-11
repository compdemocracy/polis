import React from "react";
import _ from "lodash";
import * as globals from "./globals";

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
      <rect x={0} width={100.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
      <rect x={.5} width={agree} y={.5} height={9} fill={globals.colors.agree} />
      <rect x={.5 + agree} width={disagree} y={.5} height={9} fill={globals.colors.disagree} />
      <rect x={.5 + agree + disagree} width={pass} y={.5} height={9} fill={globals.colors.pass} />
    </g>
  )
};

export default BarChartCompact;
