import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({points, ptptois}) => {

  if (!points) {
    return null
  }
// transform={`translate(${globals.side / 2},${globals.side / 2})`}>
  return (
    <g>
      {points.map((pt, i) => {
        return <circle
          r={4}
          fill={/* globals.groupColor(pt.gid)*/ ptptois[pt.bid] ? "orange" : "rgb(130,130,130)"}
          key={pt.bid}
          cx={pt.x}
          cy={pt.y}/>
      })}
    </g>
  );
}

export default GraphParticipants;
