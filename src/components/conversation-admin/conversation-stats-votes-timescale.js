import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";
import {d3} from "d3";

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
    // scale={{
    //   x: d3.time.scale(this.props.data.voteTimes),
    //   y: d3.scale.linear()
    // }}
    return (
      <VictoryChart
        width={this.props.chartWidth}
        height={this.props.chartHeight}
>
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
