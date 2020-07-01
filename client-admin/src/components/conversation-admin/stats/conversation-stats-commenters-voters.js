// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { VictoryChart } from 'victory-chart'
import { VictoryLine } from 'victory-line'
import { VictoryAxis } from 'victory-axis'
import * as d3 from 'd3'

class CommentersVoters extends React.Component {
  render() {
    return (
      <VictoryChart
        width={this.props.chartWidth}
        height={this.props.chartHeight}
        scale={{
          x: d3.scaleTime(this.props.data.firstVoteTimes),
          y: d3.scaleLinear()
        }}>
        <VictoryLine
          style={{
            data: {
              strokeWidth: 2,
              stroke: 'tomato'
            }
          }}
          data={this.props.data.firstCommentTimes.map((timestamp, i) => {
            return { x: timestamp, y: i }
          })}
        />
        <VictoryLine
          style={{
            data: {
              strokeWidth: 2,
              stroke: 'gold'
            }
          }}
          data={this.props.data.firstVoteTimes.map((timestamp, i) => {
            return { x: timestamp, y: i }
          })}
        />
        <VictoryAxis orientation="bottom" />
        <VictoryAxis
          dependentAxis
          label={'Participants'}
          style={{
            label: {
              fontSize: '8px'
            }
          }}
          orientation={'left'}
        />
      </VictoryChart>
    )
  }
}

export default CommentersVoters
