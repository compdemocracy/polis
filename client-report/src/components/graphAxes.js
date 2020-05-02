// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "./globals";

const GraphAxes = ({yCenter, xCenter, report}) => {
  return (
    <g>
      <line
        x1={0 /* magic number is axis padding */}
        y1={yCenter}
        x2={globals.side /* - 50 */}
        y2={yCenter}
        style={{
          stroke: "rgb(230,230,230)",
          strokeWidth: 1
        }}/>
      <line
        x1={xCenter}
        y1={0 }
        x2={xCenter}
        y2={globals.side /* - 50 */ /* magic number is axis padding */}
        style={{
          stroke: "rgb(230,230,230)",
          strokeWidth: 1
        }}/>
    </g>
  );
};

export default GraphAxes;
//
// {/* Bottom axis */}
// <g transform={`translate(${globals.side / 2}, ${globals.side - 20})`}>
//   {report.label_x_neg ? <text
//     style={{
//       fontFamily: "Georgia",
//       fontSize: 14
//     }}
//     textAnchor="start"
//     x={-globals.side/2 + globals.labelPadding}
//     y={-1}>
//     {globals.axisLabels.leftArrow}
//     {" "}
//     {report.label_x_neg}
//   </text> : ""}
//   {report.label_x_pos ? <text
//     style={{
//       fontFamily: "Georgia",
//       fontSize: 14
//     }}
//     textAnchor="end"
//     x={globals.side/2 - globals.labelPadding}
//     y={-1}>
//     {report.label_x_pos}
//     {" "}
//     {globals.axisLabels.rightArrow}
//   </text> : ""}
// </g>
//
// {/* Left axis */}
// <g transform={`translate(${30}, ${globals.side / 2}) rotate(270)`}>
//   {report.label_y_neg ? <text
//     style={{
//       fontFamily: "Georgia",
//       fontSize: 14
//     }}
//     textAnchor="start"
//     x={-globals.side/2 + globals.labelPadding}
//     y={-1}>
//     {globals.axisLabels.leftArrow}
//     {" "}
//     {report.label_y_neg}
//   </text> : ""}
//   {report.label_y_pos ? <text
//     style={{
//       fontFamily: "Georgia",
//       fontSize: 14
//     }}
//     textAnchor="end"
//     x={globals.side/2 - globals.labelPadding}
//     y={-1}>
//     {report.label_y_pos}
//     {" "}
//     {globals.axisLabels.rightArrow}
//   </text> : ""}
// </g>
