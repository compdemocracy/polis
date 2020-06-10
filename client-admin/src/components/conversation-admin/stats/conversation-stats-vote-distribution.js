// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { VictoryChart } from "victory-chart";
import { VictoryBar } from "victory-bar";
import { VictoryAxis } from "victory-axis";

class VotesDistribution extends React.Component {
  render() {
    return (
      <VictoryChart width={this.props.chartWidth} height={this.props.chartHeight}>
        <VictoryAxis
          tickCount={7}
          label="Vote count"
          style={{
            data: {
              axis: {
                stroke: "black",
                strokeWidth: 1,
              },
              ticks: {
                stroke: "transparent",
              },
              tickLabels: {
                fill: "black",
              },
            },
          }}
        />
        <VictoryAxis
          label="Participant count"
          orientation={"left"}
          dependentAxis
          style={{
            data: {
              axis: {
                stroke: "black",
                strokeWidth: 1,
              },
              ticks: {
                stroke: "transparent",
              },
              tickLabels: {
                fill: "black",
              },
            },
          }}
        />
        <VictoryBar
          style={{
            data: {
              fill: "cornflowerblue",
              width: 1,
            },
          }}
          data={this.props.data.votesHistogram.map((d) => {
            return {
              x: d.n_votes,
              y: d.n_ptpts,
            };
          })}
        />
      </VictoryChart>
    );
  }
}

export default VotesDistribution;
