// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";

@Radium
class CommentersVoters extends React.Component {
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    data: React.PropTypes.object,
    chartWidth: React.PropTypes.number,
    chartHeight: React.PropTypes.number
  }
  render() {
    return (
      <VictoryChart
        width={this.props.chartWidth}
        height={this.props.chartHeight}
        scale={{
          x: d3.time.scale(this.props.data.firstVoteTimes),
          y: d3.scale.linear()
          }}>
        <VictoryLine
          style={{
            data: {
              strokeWidth: 2,
              stroke: "tomato"
            }
          }}
          data={this.props.data.firstCommentTimes.map((timestamp, i) => {
            return {x: timestamp, y: i};
          })}/>
        <VictoryLine
          style={{
            data: {
              strokeWidth: 2,
              stroke: "gold"
            }
          }}
          data={this.props.data.firstVoteTimes.map((timestamp, i) => {
            return {x: timestamp, y: i}
          })}/>
        <VictoryAxis
          orientation="bottom"/>
        <VictoryAxis
          dependentAxis
          label={"Participants"}
          style={{
            label: {
              fontSize: "8px"
            }
          }}
          orientation={"left"}/>
      </VictoryChart>
    )
  }
}

export default CommentersVoters;
