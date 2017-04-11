import React from "react";
import _ from "lodash";

const BarChart = ({selectedComment, groupVotes, groups, translate}) => {
  console.log("Barchart: ", selectedComment, groupVotes, groups, translate)

  if (!selectedComment) return null;

  let ptptCount;
  let commentCount;
  let commentAgreeCount;
  let commentDisagreeCount;
  let commentPassCount;

  if (groups) {
    // it's the global barchart, so add everything up
    ptptCount = _.reduce(groups, (accumulator, group, key) => {
      return accumulator += group["n-members"]
    }, 0);

    commentCount = _.reduce(groups, (accumulator, group, key) => {
      return accumulator += group.votes[selectedComment.tid].S
    }, 0);

    commentAgreeCount = _.reduce(groups, (accumulator, group, key) => {
      return accumulator += group.votes[selectedComment.tid].A
    }, 0);

    commentDisagreeCount = _.reduce(groups, (accumulator, group, key) => {
      return accumulator += group.votes[selectedComment.tid].D
    }, 0);

    commentPassCount = _.reduce(groups, (accumulator, group, key) => {
      return accumulator += (group.votes[selectedComment.tid].S - (group.votes[selectedComment.tid].A + group.votes[selectedComment.tid].D))
    }, 0);
  }

  const rectStartX = 70;
  const barHeight = 15;
  const leftTextOffset = 63;

  const arr = [
    {
      label: "voted",
      percent: commentCount / ptptCount * 100,
      ratio: " (" + commentCount + "/" + ptptCount + ")",
      fill: "rgb(230,230,230)"
    },
    {
      label: "agreed",
      percent: commentAgreeCount / commentCount * 100,
      ratio: " (" + commentAgreeCount + "/" + commentCount + ")",
      fill: "rgb(46, 204, 113)"
    },
    {
      label: "disagreed",
      percent: commentDisagreeCount / commentCount * 100,
      ratio: " (" + commentDisagreeCount + "/" + commentCount + ")",
      fill: "rgb(231, 76, 60)"
    },
    {
      label: "passed",
      percent: commentPassCount / commentCount * 100,
      ratio: " (" + commentPassCount + "/" + commentCount + ")",
      fill: "rgb(230,230,230)"
    }
  ];


  let votesForTid = groupVotes && groupVotes.votes[selectedComment.tid];
  if (groupVotes && !votesForTid) {
    console.warn('in barchart and we have a probably bad value');
  }

  if (groupVotes && votesForTid) {
    let groupVotesForThisComment = groupVotes.votes[selectedComment.tid];
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
    <g transform={translate ? translate : "translate(0,0)"}>
      {arr.map((d, i) => {
        return (
          <g key={i}>
            <text
              x={leftTextOffset}
              y={(i+1) * 15}
              fontFamily="Helvetica"
              fontSize="10"
              textAnchor={"end"}>
              {d.label}
            </text>
            <rect
              width={d.percent}
              height={barHeight}
              x={rectStartX}
              y={((i+1) * 15) - 9}
              fill={d.fill}/>
            <text
              x={leftTextOffset + d.percent + 10}
              y={(i+1) * 15 + 2}
              fontFamily="Helvetica"
              fontSize="10"
              textAnchor={"start"}>
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
