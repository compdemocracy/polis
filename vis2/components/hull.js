import React from "react";
import * as globals from "./globals";

const Hull = ({hull}) => {
  const line = d3.line().curve(d3.curveNatural);
  const pathString = line(hull.hull);

  return (
    <path
      d={pathString}
      fill={/*globals.groupColor(hull.group[0].gid)*/ "rgb(200,200,200)"}
      fillOpacity={.4}/>
  );
};

const Hulls = ({hulls, showOnlyGroup}) => {
  return (
    <g>
      {
        hulls.map((hull) => {
          let gid = hull.group[0].gid;
          if (_.isNumber(showOnlyGroup)) {
            if (gid !== showOnlyGroup) {
              return "";
            }
          }
          return <Hull key={gid} hull={hull}/>
        })
      }
    </g>
  )
}

export default Hulls;
