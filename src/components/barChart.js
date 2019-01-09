// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";

const BarChart = ({comment, conversation, groupVotes, ptptCount}) => {

  const rectStartX = 70;
  const barHeight = 15;
  const leftTextOffset = 63;
  const arr = [
    {
      label: "voted",
      percent: ptptCount ? (comment.count / ptptCount * 100) : 0,
      ratio: " (" + comment.count + "/" + ptptCount + ")",
      fill: "rgb(230,230,230)"
    },
    {
      label: "agreed",
      percent: comment.count ? (comment.agree_count / comment.count * 100) : 0,
      ratio: " (" + comment.agree_count + "/" + comment.count + ")",
      fill: "rgb(46, 204, 113)"
    },
    {
      label: "disagreed",
      percent: comment.count ? (comment.disagree_count / comment.count * 100) : 0,
      ratio: " (" + comment.disagree_count + "/" + comment.count + ")",
      fill: "rgba(231, 76, 60)"
    },
    {
      label: "passed",
      percent: comment.count ? (comment.pass_count / comment.count * 100) : 0,
      ratio: " (" + comment.pass_count + "/" + comment.count + ")",
      fill: "rgb(230,230,230)"
    }
  ];
  let votesForTid = groupVotes && groupVotes.votes[comment.tid];
  if (groupVotes && !votesForTid) {
    console.warn('probably bad');
  }
  if (groupVotes && votesForTid) {
    let groupVotesForThisComment = groupVotes.votes[comment.tid];
    let agrees = groupVotesForThisComment.A;
    let disagrees = groupVotesForThisComment.D;
    let sawTheComment = groupVotesForThisComment.S;
    let passes = sawTheComment - (agrees + disagrees);
    let totalVotes = agrees + disagrees + passes;
    let nMembers = groupVotes["n-members"];
    arr[0].percent = totalVotes / nMembers * 100;
    arr[1].percent = agrees / totalVotes * 100;
    arr[2].percent = disagrees / totalVotes * 100;
    arr[3].percent = passes / totalVotes * 100;

    arr[0].ratio = " (" + totalVotes + "/" + nMembers + ")";
    arr[1].ratio = " (" + agrees     + "/" + totalVotes + ")";
    arr[2].ratio = " (" + disagrees  + "/" + totalVotes + ")";
    arr[3].ratio = " (" + passes     + "/" + totalVotes + ")";
  }

  return (
    <g>
      {arr.map((d, i) => {
        return (
          <g key={i}>
            <text x={leftTextOffset} y={(i+1) * 15} fontFamily="Helvetica" fontSize="10" textAnchor={"end"}>
              {d.label}
            </text>
            <rect
              width={d.percent}
              height={barHeight}
              x={rectStartX}
              y={((i+1) * 15) - 9}
              fill={d.fill}/>
            <text x={leftTextOffset + d.percent + 10} y={(i+1) * 15 + 2} fontFamily="Helvetica" fontSize="10" textAnchor={"start"}>
              {Math.floor(d.percent) + "%"}
              {d.ratio}
            </text>
          </g>
        )
      })}
    </g>
  )
};

export default BarChart;
