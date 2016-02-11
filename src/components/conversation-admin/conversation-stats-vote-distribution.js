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
class VotesDistribution extends React.Component {
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    data: React.PropTypes.object,
  }
  render() {
    return (
      <VictoryChart
        height={600}
        width={900}
        domainPadding={{x: 30, y: 30}}>
        <VictoryAxis
          tickCount={20}
          label="Vote count"
          style={{
            data: {
              axis: {
                stroke: "black",
                strokeWidth: 1
              },
              ticks: {
                stroke: "transparent"
              },
              tickLabels: {
                fill: "black"
              }
            }
          }}/>
        <VictoryAxis
          label="Participant count"
          orientation={"left"}
          dependentAxis
          style={{
            data: {
              axis: {
                stroke: "black",
                strokeWidth: 1
              },
              ticks: {
                stroke: "transparent"
              },
              tickLabels: {
                fill: "black"
              }
            }
          }}/>
        <VictoryBar
          style={{
            data: {
              fill: "cornflowerblue",
              width: 1
            }
          }}
          data={this.props.data.votesHistogram.map((d) => {
            return {
              x: d.n_ptpts,
              y: d.n_votes
            };
          })}
          />
      </VictoryChart>
    )
  }
}

export default VotesDistribution;
