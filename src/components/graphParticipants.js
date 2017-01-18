import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({points, xx, yy}) => {

  if (!points) {
    return null
  }

  return (
    <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
      {points.map((pt, i) => {
        return <circle
          r={6}
          fill={globals.groupColor(pt.gid)}
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
