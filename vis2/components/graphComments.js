import React from "react";
import _ from "lodash";
import * as globals from "./globals";

/* https://bl.ocks.org/mbostock/2206590 */

class GraphComment extends React.Component {
  getRectX() {
    let x = -7;

    if (this.props.pt.tid >= 10 && this.props.pt.tid < 100) {
      x = -5
    } else if (this.props.pt.tid >= 100) {
      // big, handle hundreds for now...
      x = -2
    }

    return x;
  }
  render() {
    return (
      <g transform={ "translate(" +
        this.props.pt.x +
        ", " +
        this.props.pt.y +
        ")"}>
          <rect
            height="20"
            width="20"
            x={this.getRectX()}
            y={-13}
            fill={this.props.isSelected ? "rgb(3, 169, 244)" : "none"}
            rx="3"
            ry="3"
            strokeWidth="2"
            strokeDasharray={"4, 7, 10, 9, 10, 7, 12, 9, 100"}
            stroke={"none"} />
          <text
            onMouseEnter={this.props.handleCommentHover(this.props.pt)}
            onMouseLeave={this.props.handleCommentHover(this.props.pt)}
            style={{
              fill: this.props.isSelected ? "white" : "black",
              cursor: "pointer",
              display: "block",
              fontFamily: "Helvetica, sans-serif",
              fontSize: 10,
              fontWeight: this.props.isSelected ? 700 : 500,
            }}>
            {/*this.props.formatTid(this.props.pt.tid)*/}
            {this.props.pt.tid}
          </text>
        </g>
    )
  }
}

class GraphComments extends React.Component {

  drawComments() {
    let shouldShowOnlyOneGroup = _.isNumber(this.props.showOnlyGroup);

    return this.props.points.map((pt, i) => {

      let repfulForGid = null;
      let antiRepfulForGid = null;
      if (globals.shouldColorizeTidsByRepfulness) {
        let tid = pt.tid;
        _.each(this.props.repfulAgreeTidsByGroup, (tids, gid) => {
          if (tids && tids.indexOf(tid) >= 0) {
            // console.log('rep', tid, gid);
            repfulForGid = Number(gid);
          }
        });
        _.each(this.props.repfulDisageeTidsByGroup, (tids, gid) => {
          if (tids && tids.indexOf(tid) >= 0) {
            // console.log('!rep', tid, gid);
            antiRepfulForGid = Number(gid);
          }
        });
        if (!_.isNull(repfulForGid) && repfulForGid === this.props.showOnlyGroup) {
          color = globals.groupColor(repfulForGid);
        } else if (!_.isNull(antiRepfulForGid)) {
          color = globals.antiRepfulColor;
        }
      }
      if (shouldShowOnlyOneGroup) {
        if (!(repfulForGid === this.props.showOnlyGroup || antiRepfulForGid === this.props.showOnlyGroup)) {
          // console.log('skip',repfulForGid,antiRepfulForGid,this.props.showOnlyGroup);
          return "";
        } else {
          // console.log('ok');
        }
      }
      return (
        <GraphComment
          key={i}
          pt={pt}
          isSelected={this.props.selectedComment ? pt.tid === this.props.selectedComment.tid : null}
          handleCommentHover={this.props.handleCommentHover}
        />
      )
    })
  }
  render () {
    return (
      <g id="vis2_comments">
        {this.props.commentsPoints ? this.drawComments() : null}
      </g>
    );
  }
}

  // transform={`translate(${globals.side / 2},${globals.side / 2})`}>

  // <circle
  //     r={4}
  //     stroke={"blue"}
  //     fill={"rgba(0,0,0,0)"}
  //     key={9999999}
  //     cx={xx(0*xScaleup)}
  //     cy={yy(0*yScaleup)}/>


export default GraphComments;
