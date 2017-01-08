import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({math, xScale, yScale}) => {

  if (!math) {
    return null
  }

  return (
    <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
      {math["base-clusters"].id.map((cluster, i) => {
        return <circle
          r={3}
          fill={"red"}
          key={i}
          cx={xScale(math["base-clusters"].x[cluster])}
          cy={yScale(math["base-clusters"].y[cluster])}/>
      })}
    </g>
  );

}

export default GraphParticipants;
