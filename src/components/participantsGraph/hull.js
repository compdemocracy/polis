import React from "react";
import * as globals from "../globals";

const Hull = ({hull}) => {
  const line = d3.line().curve(d3.curveLinear);
  const pathString = line(hull.hull);

  return (
    <path
      d={pathString}
      strokeDasharray="5, 5"
      stroke={"rgb(90,90,90)"}
      fill="none"
      fillOpacity={.4}/>
  );
};

export default Hull;

// fill={"rgba(0,0,0,.2)" /*globals.groupColor(hull.group[0].gid)*/}
