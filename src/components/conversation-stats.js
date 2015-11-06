import React from "react";
import {connect} from "react-redux";
import Radium from "radium";
import {VictoryChart} from "victory-chart";
import {VictoryLine} from "victory-line";
import {VictoryBar} from "victory-bar";
import {VictoryAxis} from "victory-axis";
import _ from "lodash";

const style = {
  parent: {
    width: 500,
    height: 500,
    margin: 50
  }
};

@Radium
class ConversationStats extends React.Component {
  static defaultProps = {
    totalParticipantsAtPresent: 3000, // function of dataset
    totalCommentsAtPresent: 95, // function of dataset
    totalVotesAtPresent: 11750,
    timeSeriesOfTotalParticipants: [
      {x: new Date(2015, 0, 1), y: 0},
      {x: new Date(2015, 1, 1), y: 300},
      {x: new Date(2015, 2, 1), y: 400},
      {x: new Date(2015, 3, 1), y: 475},
      {x: new Date(2015, 4, 1), y: 1450},
      {x: new Date(2015, 5, 1), y: 1500},
      {x: new Date(2015, 6, 1), y: 2200},
      {x: new Date(2015, 7, 1), y: 2400},
      {x: new Date(2015, 8, 1), y: 3000}
    ],
    timeSeriesOfVotingParticipants: [
      {x: new Date(2015, 0, 1), y: 0},
      {x: new Date(2015, 1, 1), y: 100},
      {x: new Date(2015, 2, 1), y: 200},
      {x: new Date(2015, 3, 1), y: 275},
      {x: new Date(2015, 4, 1), y: 950},
      {x: new Date(2015, 5, 1), y: 1100},
      {x: new Date(2015, 6, 1), y: 1300},
      {x: new Date(2015, 7, 1), y: 1700},
      {x: new Date(2015, 8, 1), y: 1900}
    ],
    timeSeriesOfCommentingParticipants: [
      {x: new Date(2015, 0, 1), y: 0},
      {x: new Date(2015, 1, 1), y: 10},
      {x: new Date(2015, 2, 1), y: 20},
      {x: new Date(2015, 3, 1), y: 30},
      {x: new Date(2015, 4, 1), y: 50},
      {x: new Date(2015, 5, 1), y: 50},
      {x: new Date(2015, 6, 1), y: 60},
      {x: new Date(2015, 7, 1), y: 70},
      {x: new Date(2015, 8, 1), y: 80}
    ],
    timeSeriesOfTotalComments: [
      {x: new Date(2015, 0, 1), y: 0},
      {x: new Date(2015, 1, 1), y: 15},
      {x: new Date(2015, 2, 1), y: 30},
      {x: new Date(2015, 3, 1), y: 45},
      {x: new Date(2015, 4, 1), y: 60},
      {x: new Date(2015, 5, 1), y: 65},
      {x: new Date(2015, 6, 1), y: 70},
      {x: new Date(2015, 7, 1), y: 90},
      {x: new Date(2015, 8, 1), y: 95}
    ],
    timeSeriesOfTotalVotes: [
      {x: new Date(2015, 0, 1), y: 0},
      {x: new Date(2015, 1, 1), y: 850},
      {x: new Date(2015, 2, 1), y: 2100},
      {x: new Date(2015, 3, 1), y: 3900},
      {x: new Date(2015, 4, 1), y: 6400},
      {x: new Date(2015, 5, 1), y: 8200},
      {x: new Date(2015, 6, 1), y: 9400},
      {x: new Date(2015, 7, 1), y: 10500},
      {x: new Date(2015, 8, 1), y: 11750}
    ]
  }
  render() {
    console.log(this.props)
    return (
      <div>
        <div className="=======UNIQES-VOTERS-COMMENTERS=======">
          <h3 style={{marginBottom: 0, marginLeft: 50}}>
            <span style={{color: "cornflowerblue"}}>Uniques </span>
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
              data={this.props.timeSeriesOfCommentingParticipants}/>
            <VictoryLine
              style={{
                data: {
                  strokeWidth: 1,
                  stroke: "gold"
                }
              }}
              data={this.props.timeSeriesOfVotingParticipants}/>
            <VictoryLine
              style={{
                data: {
                  strokeWidth: 1,
                  stroke: "cornflowerblue"
                }
              }}
              data={this.props.timeSeriesOfTotalParticipants}/>
            <VictoryAxis
              orientation="bottom"
              domain={[new Date(2015,1,1), new Date(2015, 8, 1)]}
              tickFormat={d3.time.format("%b %Y")}/>
            <VictoryAxis
              dependentAxis
              label={"Participants"}
              style={{
                label: {
                  fontSize: "8px"
                }
              }}
              domain={this.props.arrayContainingNumberOfParticipantsCommaZero}
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
                  strokeWidth: 1,
                  stroke: "tomato"
                }
              }}
              data={this.props.timeSeriesOfTotalComments}/>
            <VictoryAxis
              orientation="bottom"
              domain={[new Date(2015,1,1), new Date(2015, 8, 1)]}
              tickFormat={d3.time.format("%b %Y")}/>
            <VictoryAxis
              dependentAxis
              label={"Comments"}
              domain={[this.props.totalCommentsAtPresent,0]}
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
              data={this.props.timeSeriesOfTotalVotes}/>
            <VictoryAxis
              orientation="bottom"
              domain={[new Date(2015,1,1), new Date(2015, 8, 1)]}
              tickFormat={d3.time.format("%b %Y")}/>
            <VictoryAxis
              dependentAxis
              label={"Votes"}
              domain={[this.props.totalVotesAtPresent,0]}
              orientation={"left"}/>
          </VictoryChart>
        </div>
        <div className="=======VOTES-PER-PARTICIPANT=======">

        </div>
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






// <VictoryChart domainPadding={{x: 30, y: 30}}>
//             <VictoryAxis
//               tickValues={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]}
//               tickFormat={(x) => x}
//               style={{data: {
//                 axis: {stroke: "black", strokeWidth: 1},
//                 ticks: {stroke: "transparent"},
//                 tickLabels: {fill: "black"}
//               }}}/>
//             <VictoryAxis
//               label="Participants voted x times"
//               orientation={"left"}
//               dependentAxis/>
//             <VictoryBar style={{data: { fill: "grey"}}}
//               data={_.map(_.range(20), (i) => {
//                   if (i===0) {return null}
//                   return {
//                     x: i,
//                     y: Math.random()
//                   };
//                 })
//               }/>
//           </VictoryChart>