import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphComments = ({points, xx, yy, xScaleup, yScaleup}) => {

  if (!points) {
    return null
  }

  return (
    <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
      {points.map((pt, i) => {
        return <text
            key={i}
            transform={"translate(" + (xx(pt.x*xScaleup)) + ", " + (yy(pt.y*yScaleup)) +")"}
            fill="rgba(0,0,0,0.7)"
            style={{
              display: "block",
              fontFamily: "Helvetica, sans-serif",
              fontSize: 10,
              fontWeight: 700
            }}
            >
            {'#' + pt.tid}
          </text>
      })}
    </g>
  );
}

      // <circle
      //     r={4}
      //     stroke={"blue"}
      //     fill={"rgba(0,0,0,0)"}
      //     key={9999999}
      //     cx={xx(0*xScaleup)}
      //     cy={yy(0*yScaleup)}/>


export default GraphComments;
