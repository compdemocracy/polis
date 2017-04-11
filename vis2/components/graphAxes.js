import React from "react";
import * as globals from "./globals";

const GraphAxes = ({yCenter, xCenter, report}) => {
  return (
    <g>
      <line
        x1={50 /* magic number is axis padding */}
        y1={yCenter}
        x2={globals.side - 50}
        y2={yCenter}
        style={{
          stroke: "rgb(130,130,130)",
          strokeWidth: 1
        }}/>
      <line
        x1={xCenter}
        y1={50 }
        x2={xCenter}
        y2={globals.side - 50 /* magic number is axis padding */}
        style={{
          stroke: "rgb(130,130,130)",
          strokeWidth: 1
        }}/>
      {/* Bottom axis */}
      <g transform={`translate(${globals.side / 2}, ${globals.side - 20})`}>
        {report.label_x_neg ? <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="start"
          x={-globals.side/2 + globals.labelPadding}
          y={-1}>
          {globals.axisLabels.leftArrow}
          {" "}
          {report.label_x_neg}
        </text> : ""}
        {report.label_x_pos ? <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="end"
          x={globals.side/2 - globals.labelPadding}
          y={-1}>
          {report.label_x_pos}
          {" "}
          {globals.axisLabels.rightArrow}
        </text> : ""}
      </g>

      {/* Left axis */}
      <g transform={`translate(${30}, ${globals.side / 2}) rotate(270)`}>
        {report.label_y_neg ? <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="start"
          x={-globals.side/2 + globals.labelPadding}
          y={-1}>
          {globals.axisLabels.leftArrow}
          {" "}
          {report.label_y_neg}
        </text> : ""}
        {report.label_y_pos ? <text
          style={{
            fontFamily: "Georgia",
            fontSize: 14
          }}
          textAnchor="end"
          x={globals.side/2 - globals.labelPadding}
          y={-1}>
          {report.label_y_pos}
          {" "}
          {globals.axisLabels.rightArrow}
        </text> : ""}
      </g>
    </g>
  );
};

export default GraphAxes;
