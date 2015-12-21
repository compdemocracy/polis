import React from "react";
import {connect} from "react-redux";
import Radium from "radium";
import {populateConversationStatsStore} from "../../actions";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";
import _ from "lodash";
import Spinner from "../framework/spinner";
import Awesome from "react-fontawesome";
import Flex from "../framework/flex";
import NumberCards from "./conversation-stats-number-cards";

const style = {
  container: {
    backgroundColor: "rgb(240,240,247)"
  },
  chartCard: {
    backgroundColor: "rgb(253,253,253)",
    marginRight: 14,
    marginBottom: 14,
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  chartContainer: {
    padding: 20,
  }
};

@connect(state => state.stats)
@Radium
class ConversationStats extends React.Component {
  loadStats() {
    this.props.dispatch(
      populateConversationStatsStore(this.props.params.conversation)
    )
  }
  componentWillMount () {
    this.getStatsRepeatedly = setInterval(()=>{
      this.loadStats()
    },10000);
  }
  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly);
  }
  createCharts (data) {
    return (
      <div style={style.container}>
        <NumberCards data={data}/>
          <div style={style.chartContainer}>
        <Flex justifyContent="flex-start">
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Voters </span>
                <span style={{color: "tomato"}}>Commenters</span>
              </h3>
              <VictoryChart
                height={300}
                width={450}
                scale={{
                  x: d3.time.scale(data.firstVoteTimes),
                  y: d3.scale.linear()
                }}>
                <VictoryLine
                  style={{
                    data: {
                      strokeWidth: 2,
                      stroke: "tomato"
                    }
                  }}
                  data={data.firstCommentTimes.map((timestamp, i) => {
                    return {x: timestamp, y: i};
                  })}/>
                <VictoryLine
                  style={{
                    data: {
                      strokeWidth: 2,
                      stroke: "gold"
                    }
                  }}
                  data={data.firstVoteTimes.map((timestamp, i) => {
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
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "tomato"}}>Comments</span>
              </h3>
              <VictoryChart
                scale={{
                  x: d3.time.scale(data.commentTimes),
                  y: d3.scale.linear()
                }}>
                <VictoryLine
                  style={{
                    data: {
                      strokeWidth: 2,
                      stroke: "tomato"
                    }
                  }}
                  data={data.commentTimes.map((timestamp, i) => {
                    return {x: timestamp, y: i}
                  })}/>
                <VictoryAxis
                  orientation="bottom"/>
                <VictoryAxis
                  dependentAxis
                  label={"Comments"}
                  orientation={"left"}/>
              </VictoryChart>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span style={{color: "gold"}}>Votes</span>
              </h3>
              <VictoryChart
                scale={{
                  x: d3.time.scale(data.voteTimes),
                  y: d3.scale.linear()
                }}>
                <VictoryLine
                  style={{
                    data: {
                      strokeWidth: 2,
                      stroke: "gold"
                    }
                  }}
                  data={data.voteTimes.map((timestamp, i) => {
                    return {x: timestamp, y: i}
                  })}/>            <VictoryAxis
                  orientation="bottom"/>
                <VictoryAxis
                  dependentAxis
                  label={"Votes"}
                  orientation={"left"}/>
              </VictoryChart>
            </div>
            <div style={style.chartCard}>
              <h3 style={{marginBottom: 0, marginLeft: 50}}>
                <span>Votes per participant distribution</span>
              </h3>
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
                  data={data.votesHistogram.map((d, i) => {
                    return {
                      x: d.n_ptpts,
                      y: d.n_votes
                    }
                  })}
                  />
              </VictoryChart>
            </div>
        </Flex>
          </div>
      </div>
    )
  }
  render() {
    const data = this.props.conversation_stats; /* swap out for real data later */
    return (
      <div>
        {data.voteTimes ? this.createCharts(data) : <Spinner/>}
      </div>
    );
  }
}

export default ConversationStats;

// var styles = (i) => {
//   return {
//     backgroundColor: `rgb(${i * 50}, 50, 50)`
//   };
// };
