import React from "react";
import * as globals from "./globals";

const Hull = ({hull}) => {
  const line = d3.line().curve(d3.curveNatural);
  const pathString = line(hull.hull);

  return (
    <path
      d={pathString}
      fill={globals.groupColor(hull.group[0].gid)}
      fillOpacity={.4}/>
  );
};

export default Hull;
