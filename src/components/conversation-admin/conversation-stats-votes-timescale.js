import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";

// @connect(state => state.stats)
@Radium
class VotesTimescale extends React.Component {
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
          x: d3.time.scale(this.props.data.voteTimes),
          y: d3.scale.linear()
        }}>
        <VictoryLine
          style={{
            data: {
              strokeWidth: 2,
              stroke: "gold"
            }
          }}
          data={this.props.data.voteTimes.map((timestamp, i) => {
            return {x: timestamp, y: i}
          })}/>
        <VictoryAxis
          orientation="bottom"/>
        <VictoryAxis
          dependentAxis
          label={"Votes"}
          orientation={"left"}/>
      </VictoryChart>
    )
  }
}

export default VotesTimescale;
