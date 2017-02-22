import React from "react";
import Radium from "radium";
import _ from "lodash";
import createHull from "hull.js";
// import Flex from "./framework/flex";
import * as globals from "./globals";
import {VictoryAxis} from "victory";
import Axes from "./graphAxes";
import Comments from "./graphComments";
import Participants from "./graphParticipants";
import Hull from "./hull";

@Radium
class Graph extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      selectedComment: null,
    };
  }

  handleCommentHover(selectedComment) {
    return () => {
      // console.log('setting state', selectedComment)
      this.setState({selectedComment});
    }
  }

  render() {

    if (!this.props.math) {
      return null;
    }

    const allXs = [];
    const allYs = [];


    const commentsByTid = _.keyBy(this.props.comments, "tid");

    // comments
    const commentsPoints = [];
    const compsX = this.props.math.pca.comps[0];
    const compsY = this.props.math.pca.comps[1];
    let rejectedCount = 0;
    for (let i = 0; i < compsX.length; i++) {
      if (this.props.comments[i]) {
        let x = compsX[i];
        let y = compsY[i];
        // if (i === 32) { // TODO_DEMO_HACK use force layout instead
        //   x += 0.02;
        //   y += 0.01;
        // }
        if (!this.props.badTids[i]) {
          if (commentsByTid[i]) {
            commentsPoints.push({
              x: x,
              y: y,
              tid: i,
              txt: commentsByTid[i].txt,
            });
          } else {
            rejectedCount += 1;
            // console.log('skipping rejected', i, rejectedCount);
          }
        } else {
          // console.log('skipping bad', i);
        }
      }
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
    const bids = this.props.math["base-clusters"].id;
    let baseClusters = [];
    for (let i = 0; i < clusterXs.length; i++) {
      baseClusters.push({
        x: clusterXs[i],
        y: clusterYs[i],
        id: bids[i],
        gid: baseClusterIdToGid(bids[i]),
      });
      allXs.push(clusterXs[i]);
      allYs.push(clusterYs[i]);
    }

    let border = 100;
    let minClusterX = _.min(allXs);
    let maxClusterX = _.max(allXs);
    let minClusterY = _.min(allYs);
    let maxClusterY = _.max(allYs);
    const xx = d3.scaleLinear().domain([minClusterX, maxClusterX]).range([border, globals.side - border]);
    const yy = d3.scaleLinear().domain([minClusterY, maxClusterY]).range([border, globals.side - border]);

    const xCenter = xx(0);
    const yCenter = yy(0);

    var greatestAbsPtptX = _.maxBy(baseClusters, (pt) => { return Math.abs(pt.x); }).x;
    var greatestAbsPtptY = _.maxBy(baseClusters, (pt) => { return Math.abs(pt.y); }).y;
    var greatestAbsCommentX = _.maxBy(commentsPoints, (pt) => { return Math.abs(pt.x); }).x;
    var greatestAbsCommentY = _.maxBy(commentsPoints, (pt) => { return Math.abs(pt.y); }).y;

    var maxCommentX = _.maxBy(commentsPoints, (pt) => { return pt.x; }).x;
    var minCommentX = _.minBy(commentsPoints, (pt) => { return pt.x; }).x;
    var maxCommentY = _.maxBy(commentsPoints, (pt) => { return pt.y; }).y;
    var minCommentY = _.minBy(commentsPoints, (pt) => { return pt.y; }).y;

    // xGreatestMapped = xCenter + xScale * maxCommentX
    // globals.side - border = xCenter + xScale * maxCommentX
    // globals.side - border - xCenter = xScale * maxCommentX
    var xScaleCandidateForRightSide = (globals.side - border - xCenter) / maxCommentX;
    var yScaleCandidateForBottomSide = (globals.side - border - yCenter) / maxCommentY;

    // xLowestMapped = xCenter + xScale * minCommentX
    // border = xCenter + xScale * minCommentX
    // border - xCenter = xScale * minCommentX
    // (border - xCenter) / minCommentX = xScale
    var xScaleCandidateForLeftSide = (border - xCenter) / minCommentX;
    var yScaleCandidateForTopSide = (border - yCenter) / minCommentY;

    // TODO_VOTE_FLIP: we can probably remove the -1 below if we flip the vote values.
    var commentScaleupFactorX = -1 * Math.min(xScaleCandidateForRightSide, xScaleCandidateForLeftSide);
    var commentScaleupFactorY = -1 * Math.min(yScaleCandidateForBottomSide, yScaleCandidateForTopSide);

    const baseClustersScaled = baseClusters.map((p) => {
      return {
        gid: p.gid,
        id: p.id,
        x: xx(p.x),
        y: yy(p.y)
      }
    })

    const baseClustersScaledAndGrouped = {}

    baseClustersScaled.forEach((baseCluster) => {
      if (baseClustersScaledAndGrouped[baseCluster.gid]) {
        baseClustersScaledAndGrouped[baseCluster.gid].push(baseCluster);
      } else {
        baseClustersScaledAndGrouped[baseCluster.gid] = [baseCluster];
      }
    });

    const hulls = [];

    _.each(baseClustersScaledAndGrouped, (group) => {
      const pairs = group.map((g) => { /* create an array of arrays */
        return [g.x, g.y]
      })
      const hull = createHull(
        pairs,
        5
      )
      hulls.push({
        group,
        hull,
      })
    })

    console.log(hulls)

    return (
      <div>
        <p style={{fontSize: globals.primaryHeading}}> Opinion Graph </p>
        <p style={globals.paragraph}>
          This graph shows all people and all comments.
        </p>
        <p style={globals.paragraph}>
          Comments, identified by their number, are positioned more closely to comments that were voted on similarly (blue, in the correlation matrix above). Comments are positioned further away from comments that tended to be voted on differently (red, in the correlation matrix above). </p>
        <p style={globals.paragraph}>People are positioned closer to the comments on which they agreed, and further from the comments on which they disagreed. Groups of participants that tended to vote similarly across many comments (elaborated in the previous section) are identified by their similar color.
        </p>
        <svg width={globals.side} height={globals.side} style={{ marginTop: 30}}>
          <Axes selectedComment={this.state.selectedComment} xCenter={xCenter} yCenter={yCenter}/>

          <Participants points={baseClustersScaled}/>
          {/* this.props.math["group-clusters"].map((cluster, i) => {
            return (<text x={300} y={300}> Renzi Supporters </text>)
          }) : null */}
          {
            commentsPoints ?
            <Comments
              handleCommentHover={this.handleCommentHover.bind(this)}
              points={commentsPoints}
              repfulAgreeTidsByGroup={this.props.repfulAgreeTidsByGroup}
              xx={xx}
              yy={yy}
              xCenter={xCenter}
              yCenter={yCenter}
              xScaleup={commentScaleupFactorX}
              yScaleup={commentScaleupFactorY}
              formatTid={this.props.formatTid}/> :
            null
          }
          {
            hulls.map((hull) => {
              return <Hull key={hull.group[0].gid} hull={hull}/>
            })
          }
        </svg>
      </div>
    );
  }
}

export default Graph;


// {/*this.props.math["group-clusters"].map((c, i) => {
//   return (<text
//   key={i}
//   transform={globals.getGroupNamePosition(i)}
//   fill="rgba(0,0,0,0.7)"
//   style={{
//   display: "block",
//   fontFamily: "Helvetica, sans-serif",
//   fontSize: 10,
//   fontWeight: 700
//   }}
//   >
//   {this.props.groupNames[c.id]}
//   </text>);
//   }) */}
