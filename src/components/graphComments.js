import React from "react";
import _ from "lodash";
import * as globals from "./globals";

class GraphComments extends React.Component {

  render () {
    return (
      <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
        {this.props.points.map((pt, i) => {
          return <text
              key={i}
              onMouseEnter={this.props.handleCommentHover(pt)}
              onMouseLeave={this.props.handleCommentHover(pt)}
              transform={"translate(" + (this.props.xx(pt.x * this.props.xScaleup)) + ", " + (this.props.yy(pt.y * this.props.yScaleup)) +")"}
              fill="rgba(0,0,0,0.7)"
              style={{
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
