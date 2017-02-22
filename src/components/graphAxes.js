import React from "react";
import * as globals from "./globals";

const GraphAxes = ({yCenter, xCenter, selectedComment}) => {
  return (
    <g>
      <line
        strokeDasharray={"3, 3"}
        x1={50 /* magic number is axis padding */}
        y1={yCenter}
        x2={globals.side - 50}
        y2={yCenter}
        style={{
          stroke: "rgb(130,130,130)",
          strokeWidth: 1
        }}/>
      <line
        strokeDasharray={"3, 3"}
        x1={xCenter}
        y1={50 }
        x2={xCenter}
        y2={globals.side - 50 /* magic number is axis padding */}
        style={{
          stroke: "rgb(130,130,130)",
          strokeWidth: 1
        }}/>
      {/* Comment https://bl.ocks.org/mbostock/7555321 */}
      <g transform={`translate(${globals.side / 2}, ${15})`}>
        <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14,
            fontStyle: "italic"
          }}
          textAnchor="middle">
          {selectedComment ? "#" + selectedComment.tid + ". " + selectedComment.txt : null}
        </text>
      </g>
      {/* Bottom axis */}
      <g transform={`translate(${globals.side / 2}, ${globals.side - 20})`}>
        <text
          textAnchor="middle">
          {globals.axisLabels.spacer}
        </text>
        <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="end"
          x={-35}
          y={-1}>
          {globals.axisLabels.leftArrow}
          {" "}
          {globals.axisLabels.xLeft}
        </text>
        <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="start"
          x={35}
          y={-1}>
          {globals.axisLabels.xRight}
          {" "}
          {globals.axisLabels.rightArrow}
        </text>
      </g>

      {/* Left axis */}
      <g transform={`translate(${30}, ${globals.side / 2}) rotate(270)`}>
        <text
          textAnchor="middle">
          {globals.axisLabels.spacer}
        </text>
        <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="end"
          x={-35}
          y={-1}>
          {globals.axisLabels.leftArrow}
          {" "}
          {globals.axisLabels.yLeft}
        </text>
        <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="start"
          x={35}
          y={-1}>
          {globals.axisLabels.yRight}
          {" "}
          {globals.axisLabels.rightArrow}
        </text>
      </g>
    </g>
  );
};

export default GraphAxes;
