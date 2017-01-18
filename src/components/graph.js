import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
import * as globals from "./globals";
import {VictoryAxis} from "victory";
import Comments from "./graphComments";
import Participants from "./graphParticipants";

@Radium
class Graph extends React.Component {

  render() {

    if (!this.props.math) {
      return null;
    }

    const allXs = [];
    const allYs = [];


    // comments
    const commentsPoints = [];
    const compsX = this.props.math.pca.comps[0];
    const compsY = this.props.math.pca.comps[1];
    for (let i = 0; i < compsX.length; i++) {
      let x = compsX[i];
      let y = compsY[i];
      if (i === 32) { // TODO_DEMO_HACK use force layout instead
        x += 0.02;
        y += 0.01;
      }
      if (!this.props.badTids[i]) {
        commentsPoints.push({
          x: x,
          y: y,
          tid: i,
        });
      }
      allXs.push(compsX[i]);
      allYs.push(compsY[i]);
    }

    const baseClusterIdToGid = (baseClusterId) => {
      var clusters = this.props.math["group-clusters"];
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].members.indexOf(baseClusterId) >= 0) {
          return clusters[i].id;
        }
      }
    }


    // participants
    const clusterXs = this.props.math["base-clusters"].x;
    const clusterYs = this.props.math["base-clusters"].y;
    const ids = this.props.math["base-clusters"].id;
    let baseClusters = [];
    for (let i = 0; i < clusterXs.length; i++) {
      baseClusters.push({
        x: clusterXs[i],
        y: clusterYs[i],
        id: ids[i],
        gid: baseClusterIdToGid(ids[i]),
      });
      allXs.push(clusterXs[i]);
      allYs.push(clusterYs[i]);
    }

    let denom = 2;
    let border = 100;
    const xx = d3.scaleLinear().domain([_.min(allXs),_.max(allXs)]).range([-(globals.side / denom - border), globals.side / denom - border]);
    const yy = d3.scaleLinear().domain([_.min(allYs),_.max(allYs)]).range([-(globals.side / denom - border), globals.side / denom - border]);

    var greatestAbsPtptX = Math.abs(_.max(baseClusters, (pt) => { return Math.abs(pt.x); }).x);
    var greatestAbsPtptY = Math.abs(_.max(baseClusters, (pt) => { return Math.abs(pt.y); }).y);
    var greatestAbsCommentX = Math.abs(_.max(commentsPoints, (pt) => { return Math.abs(pt.x); }).x);
    var greatestAbsCommentY = Math.abs(_.max(commentsPoints, (pt) => { return Math.abs(pt.y); }).y);

    var commentScaleupFactorX = -0.4* greatestAbsPtptX / greatestAbsCommentX; // TODO figure out why *2 was needed
    var commentScaleupFactorY = -8 * greatestAbsPtptY / greatestAbsCommentY; // TODO figure out why *2 was needed



    return (
      <div>
        <p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
        <p style={globals.paragraph}>
          This graph shows all people and all comments. People who voted similarly across many comments are closer together.
        </p>
        <svg width={globals.side} height={globals.side} style={{border: "1px solid rgb(210,210,210)"}}>
          <VictoryAxis
            standalone={false}
            height={globals.side}
            width={globals.side}
            tickValues={["5", "4", "3", "2", "1", "0", "1", "2", "3", "4", "5"]}
            label={globals.axisLabels.x}
            style={{
              axis: {},
              axisLabel: {},
              grid: {},
              ticks: {},
              tickLabels: {}
            }}/>
          <VictoryAxis
            standalone={false}
            height={globals.side}
            width={globals.side}
            tickValues={["5", "4", "3", "2", "1", "0", "1", "2", "3", "4", "5"]}
            label={globals.axisLabels.y}
            dependentAxis/>
          {<Participants points={baseClusters} xx={xx} yy={yy}/>}
          {/* this.props.math["group-clusters"].map((cluster, i) => {
            return (<text x={300} y={300}> Renzi Supporters </text>)
          }) : null */}
          {<Comments points={commentsPoints} xx={xx} yy={yy} xScaleup={commentScaleupFactorX} yScaleup={commentScaleupFactorY} formatTid={this.props.formatTid}/>}
          {this.props.math["group-clusters"].map((c, i) => {
            return (<text
              key={i}
              transform={globals.getGroupNamePosition(i)}
              fill="rgba(0,0,0,0.7)"
              style={{
                display: "block",
                fontFamily: "Helvetica, sans-serif",
                fontSize: 10,
                fontWeight: 700
              }}
              >
              {this.props.groupNames[c.id]}
            </text>);
          })}
          groupNames
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
