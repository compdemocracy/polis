import React from "react";

const BarChart = ({comment, conversation}) => {

  const rectStartX = 70;
  const barHeight = 12;
  const leftTextOffset = 63;

  const arr = [
    {
      label: "voted",
      percent: comment.count / conversation.participant_count * 100,
      fill: "rgb(180,180,180)"
    },
    {
      label: "agreed",
      percent: comment.agree_count / comment.count * 100,
      fill: "rgb(46, 204, 113)"
    },
    {
      label: "disagreed",
      percent: comment.disagree_count / comment.count * 100,
      fill: "rgb(231, 76, 60)"
    },
    {
      label: "passed",
      percent: comment.pass_count / comment.count * 100,
      fill: "rgb(230,230,230)"
    }
  ];

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
            <text x={leftTextOffset + d.percent + 10} y={(i+1) * 15} fontFamily="Helvetica" fontSize="10" textAnchor={"start"}>
              {Math.floor(d.percent) + "%"}
            </text>
          </g>
        )
      })}
    </g>
  )
};

export default BarChart;
