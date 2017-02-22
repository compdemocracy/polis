import React from "react";

const Hull = ({hull}) => {
  const line = d3.line().curve(d3.curveNatural);
  const pathString = line(hull.hull);

  return (
    <path d={pathString} fill={`rgba(255,0,0,.3)`}/>
  );
};

export default Hull;
