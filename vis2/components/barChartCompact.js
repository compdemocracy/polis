import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const BarChartCompact = ({selectedComment, groupVotes, translate}) => {

  if (!selectedComment) return null;

  let w = 100;

  if (translate[0] < 10) {
    translate[0] = 10;
  } else if (translate[0] > (globals.side - (w+10))) {
    translate[0] = globals.side - (w + 10);
  }

  let groupVotesForThisComment = groupVotes.votes[selectedComment.tid];
  let agrees = groupVotesForThisComment.A;
  let disagrees = groupVotesForThisComment.D;
  let sawTheComment = groupVotesForThisComment.S;
  let passes = sawTheComment - (agrees + disagrees);
  let totalVotes = agrees + disagrees + passes;
  let nMembers = groupVotes["n-members"];

  const agree = agrees / nMembers * w;
  const disagree = disagrees / nMembers * w;
  const pass = passes / nMembers * w;
  const blank = nMembers - sawTheComment / nMembers * w;

  return (
    <g transform={translate ? ("translate(" + translate[0] + "," + translate[1] + ")") : "translate(100, 100)"}>
      <rect x={0} width={w + 0.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
      <rect x={.5} width={agree} y={.5} height={9} fill={globals.colors.agree} />
      <rect x={.5 + agree} width={disagree} y={.5} height={9} fill={globals.colors.disagree} />
      <rect x={.5 + agree + disagree} width={pass} y={.5} height={9} fill={globals.colors.pass} />
    </g>
  )
};

export default BarChartCompact;
