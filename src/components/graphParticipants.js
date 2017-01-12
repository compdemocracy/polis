import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({points, xx, yy}) => {

  if (!points) {
    return null
  }

  function getColor(gid) {
    if (gid === 0) {
      return "rgb(100, 100, 255)";
    } else if (gid === 1) {
      return "rgb(100, 200, 200)";
    } else if (gid === 2) {
      return "rgb(100, 255, 100)";
    } else if (gid === 3) {
      return "rgb(255, 100, 100)";
    } else if (gid === 4) {
      return "rgb(200, 200, 100)";
    } else if (gid === 5) {
      return "rgb(200, 100, 200)";
    } else {
      return "rgb(255, 0, 0)";
    }
  }

  return (
    <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
      {points.map((pt, i) => {
        return <circle
          r={6}
          fill={getColor(pt.gid)}
          key={i}
          cx={xx(pt.x)}
          cy={yy(pt.y)}/>
      })}
    </g>
  );
}
      // <circle
      //     r={8}
      //     stroke={"purple"}
      //     fill={"rgba(0,0,0,0)"}
      //     key={9999}
      //     cx={xx(0)}
      //     cy={yy(0)}/>

export default GraphParticipants;
