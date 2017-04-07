import React from "react";
import _ from "lodash";
import * as globals from "./globals";

/* https://bl.ocks.org/mbostock/2206590 */

class GraphComments extends React.Component {

  render () {

    if (!this.props.commentsPoints) return null;

    let shouldShowOnlyOneGroup = _.isNumber(this.props.showOnlyGroup);

    // transform={`translate(${globals.side / 2},${globals.side / 2})`}>
    return (
      <g>
        {this.props.points.map((pt, i) => {

          let repfulForGid = null;
          let antiRepfulForGid = null;
          let color = "black";
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


          return <text
              key={i}
              onMouseEnter={this.props.handleCommentHover(pt)}
              onMouseLeave={this.props.handleCommentHover(pt)}
              transform={"translate(" + (this.props.xCenter + pt.x * this.props.xScaleup) + ", " + (this.props.yCenter + pt.y * this.props.yScaleup) +")"}
              fill="rgba(0,0,0,0.7)"
              style={{
                fill: color,
                display: "block",
                fontFamily: "Helvetica, sans-serif",
                fontSize: 10,
                fontWeight: 700
              }}
              >
              {this.props.formatTid(pt.tid)}

            </text>
        })}
      </g>
    );
  }
}

      // <circle
      //     r={4}
      //     stroke={"blue"}
      //     fill={"rgba(0,0,0,0)"}
      //     key={9999999}
      //     cx={xx(0*xScaleup)}
      //     cy={yy(0*yScaleup)}/>


export default GraphComments;
