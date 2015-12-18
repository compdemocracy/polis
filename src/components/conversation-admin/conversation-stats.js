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

const style = {
  parent: {
    width: 500,
    height: 500,
    margin: 50
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
    },1000);
  }
  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly);
  }
  createCharts (data) {
    return (
      <div>
      <h1>Conversation Stats</h1>
      <h3>At a glance:</h3>
        <p> {data.firstVoteTimes.length + " participants have voted."} </p>
        <p> {data.voteTimes.length + " votes have been cast."} </p>
        <p> {
          "This is an average of " +
          Math.floor(data.voteTimes.length / data.firstVoteTimes.length) +
          " votes per voter."
        } </p>
        <p> {data.firstCommentTimes.length + " participants have commented."} </p>
        <p> {data.commentTimes.length + " comments have been submitted."} </p>

      <h3>Charts</h3>
        <div className="=======UNIQUES-VOTERS-COMMENTERS=======">
          <h3 style={{marginBottom: 0, marginLeft: 50}}>
            <span style={{color: "gold"}}>Voters </span>
            <span style={{color: "tomato"}}>Commenters</span>
          </h3>
          <VictoryChart style={style.parent}
            scale={{
              x: d3.time.scale(),
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
              orientation="bottom"
              tickFormat={d3.time.format("%a %_I%p")}/>
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
        <div className="=======COMMENTS=======">
          <h3 style={{marginBottom: 0, marginLeft: 50}}>
            <span style={{color: "tomato"}}>Comments</span>
          </h3>
          <VictoryChart style={style.parent}
            scale={{
              x: d3.time.scale(),
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
              orientation="bottom"
              tickFormat={d3.time.format("%a %_I%p")}/>
            <VictoryAxis
              dependentAxis
              label={"Comments"}
              orientation={"left"}/>
          </VictoryChart>
        </div>
        <div className="=======VOTES=======">
          <h3 style={{marginBottom: 0, marginLeft: 50}}>
            <span style={{color: "gold"}}>Votes</span>
          </h3>
          <VictoryChart style={style.parent}
            scale={{
              x: d3.time.scale(),
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
              orientation="bottom"
              tickFormat={d3.time.format("%a %_I%p")}/>
            <VictoryAxis
              dependentAxis
              label={"Votes"}
              orientation={"left"}/>
          </VictoryChart>
        </div>
        <div className="=======VOTES-PER-PARTICIPANT=======">
          <h3 style={{marginBottom: 0, marginLeft: 50}}>
            <span>Voting / engagement distribution: __ participants voted __ times.</span>
          </h3>
          <VictoryChart domainPadding={{x: 30, y: 30}}>
            <VictoryAxis
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
                  fill: "grey",
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
