import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
import * as globals from "./globals";
import {VictoryAxis} from "victory";
import Participants from "./graphParticipants";

@Radium
class Graph extends React.Component {

  render() {

    const side = 1000;
    return (
      <div>
        <p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
        <p style={{width: globals.paragraphWidth}}>
          All people and comments visualized
        </p>
        <svg width={side} height={side} style={{border: "1px solid rgb(210,210,210)"}}>
          <VictoryAxis
            standalone={false}
            height={side}
            width={side}
            tickValues={["5", "4", "3", "2", "1", "0", "1", "2", "3", "4", "5"]}
            label="Anti Renzi & Anti Centralization vs Pro Renzi & Centralization"
            style={{
              axis: {},
              axisLabel: {},
              grid: {},
              ticks: {},
              tickLabels: {}
            }}
            />
          <VictoryAxis
            standalone={false}
            height={side}
            width={side}
            tickValues={["5", "4", "3", "2", "1", "0", "1", "2", "3", "4", "5"]}
            label="Government is Responsibility vs People are Responsibility"
            dependentAxis/>
          {<Participants math={this.props.math}/>}
          {/* this.props.math["group-clusters"].map((cluster, i) => {
            return (<text x={300} y={300}> Renzi Supporters </text>)
          }) : null */}
        </svg>
      </div>
    );
  }
}

export default Graph;

// grid
// <line
//   x1={side / 2}
//   y1="0"
//   x2={side / 2}
//   y2={side}
//   strokeWidth="2"
//   stroke="rgb(210,210,210)"/>
// <line
//   x1={0}
//   y1={side / 2}
//   x2={side}
//   y2={side / 2}
//   strokeWidth="2"
//   stroke="rgb(210,210,210)"/>
// <text x={side / 2 + 10} y={side / 2 - 10} fontSize="12">
//   0
// </text>
