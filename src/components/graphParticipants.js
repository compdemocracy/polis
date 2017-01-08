import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({math}) => {

  if (!math) {
    return null
  }

  const xx = d3.scaleLinear().domain([_.min(math["base-clusters"].x),_.max(math["base-clusters"].x)]).range([-(globals.side / 2 - 50), globals.side / 2 - 50]);
  const yy = d3.scaleLinear().domain([_.min(math["base-clusters"].y),_.max(math["base-clusters"].y)]).range([-(globals.side / 2 - 50), globals.side / 2 - 50]);

  return (
    <g transform={`translate(${globals.side / 2},${globals.side / 2})`}>
      {math["base-clusters"].id.map((cluster, i) => {
        return <circle
          r={3}
          fill={"red"}
          key={i}
          cx={xx(math["base-clusters"].x[cluster])}
          cy={yy(math["base-clusters"].y[cluster])}/>
      })}
    </g>
  );

}

export default GraphParticipants;
