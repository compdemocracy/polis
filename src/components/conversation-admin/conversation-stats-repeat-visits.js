import React from "react";
import { connect } from "react-redux";
// import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";

// @connect(state => state.stats)
@Radium
class RepeatVisits extends React.Component {
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
        domainPadding={{x: 40, y: 40}}>
        <VictoryAxis
          label="Visits"
          tickCount={this.props.data.burstHistogram.length}
          style={{
              axis: {
                stroke: "rgba(240,240,240,1)",
                strokeWidth: 1
              },
              ticks: {
                stroke: "transparent"
              },
              tickLabels: {
                fill: "rgba(130,130,130,1)"
              }
          }}/>
        <VictoryAxis
          label="Participant count"
          orientation={"left"}
          tickCount={20}
          dependentAxis
          style={{
              axis: {
                stroke: "transparent",
                strokeWidth: 1
              },
              grid: {
                stroke: "rgba(240,240,240,1)",
                strokeWidth: 1
              },
              ticks: {
                stroke: "transparent"
              },
              tickLabels: {
                fill: "rgba(130,130,130,1)"
              }
          }}/>
        <VictoryBar
          style={{
            data: {
              fill: "red",
              width: 6,
            }
          }}
          data={this.props.data.burstHistogram.map((d,i) => {
            if (i !== 0) {
            return {
              x: d.n_bursts,
              y: d.n_ptpts
            };
          } else { return {x: 1, y: 0} }
          })
          }
          />
      </VictoryChart>
    )
  }
}

export default RepeatVisits;
