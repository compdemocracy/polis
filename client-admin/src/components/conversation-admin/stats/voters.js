// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

/** @jsx jsx */

import React from "react";
import * as d3 from "d3";
import { jsx, Box, Heading } from "theme-ui";
import { VictoryChart, VictoryArea } from "victory";
import victoryTheme from "./victoryTheme";

// x: d3.scaleTime(this.props.data.firstVoteTimes),
// y: d3.scaleLinear(),

// data={this.props.data.firstCommentTimes.map((timestamp, i) => {
//   return { x: timestamp, y: i };
// })}

// data={this.props.data.firstVoteTimes.map((timestamp, i) => {
//   return { x: timestamp, y: i };
// })}

class Voters extends React.Component {
  render() {
    const { size, firstVoteTimes } = this.props;
    return (
      <Box sx={{ mt: [5] }}>
        <Heading
          as="h6"
          sx={{
            fontSize: [2, null, 3],
            lineHeight: "body",
            my: [2],
          }}
        >
          Voters over time, by time of first vote
        </Heading>
        <VictoryChart
          theme={victoryTheme}
          height={size}
          width={size}
          domainPadding={{ x: 0, y: [0, 20] }}
          scale={{ x: "time" }}
        >
          <VictoryArea
            style={{ data: { fill: "#03a9f4" } }}
            data={firstVoteTimes.map((d, i) => {
              return { x: new Date(d), y: i };
            })}
          />
        </VictoryChart>
      </Box>
    );
  }
}

export default Voters;

{
  /* <svg
ref="votersSVG"
width={size + margin.left + margin.right}
height={size + margin.top + margin.bottom}
></svg> */
}

// drawChart(data, size, margin) {
//   const svg = d3.select(this.refs.votersSVG);
//   const width = size - margin.left - margin.right;
//   const height = size - margin.top - margin.bottom;
//   // parse the date / time
//   // const parseTime = d3.timeParse("%d-%b-%y");

//   // set the ranges
//   const x = d3
//     .scaleTime()
//     .range([0, width])
//     .domain(d3.extent(data, (d) => d));
//   const y = d3
//     .scaleLinear()
//     .range([height, 0])
//     .domain([0, data.length /*that's the number of voters*/]);

//   // /* Remove everything */
//   svg.selectAll("*").remove();

//   // Add the valueline path.
//   svg
//     .append("path")
//     .datum(data)
//     .style("fill", "none")
//     .style("stroke", "black")
//     .style("strokeWidth", 2)
//     .attr(
//       "d",
//       d3
//         .line()
//         .x((d) => {
//           return x(d);
//         })
//         .y((d, i) => {
//           return y(i);
//         })
//     );

//   // Add the x Axis
//   svg
//     .append("g")
//     .attr("transform", "translate(0," + height + ")")
//     .call(d3.axisBottom(x));

//   // Add the y Axis
//   svg.append("g").call(d3.axisLeft(y));
// }
// componentDidUpdate() {
//   const { firstVoteTimes: data, size, margin } = this.props;
//   this.drawChart(data, size, margin);
// }
// componentDidMount() {
//   const { firstVoteTimes: data, size, margin } = this.props;
//   this.drawChart(data, size, margin);
// }
