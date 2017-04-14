import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const GraphParticipants = ({points, ptptois, ptptoiScaleFactor}) => {

  if (!points) {
    return null
  }
// transform={`translate(${globals.side / 2},${globals.side / 2})`}>
  return (
    <g>
      {points.map((pt, i) => {
        let ptptoi = ptptois[pt.bid];
        if (ptptoi) {
          console.log(ptptoi);
          let picSize = ptptoi.picture_size;
          return <g
            transform={"translate(" + pt.x + "," + pt.y + ")"}>
            <image
              clipPath={"url(#clipCircleVis2)"}
              x={-picSize/2 * ptptoiScaleFactor}
              y={-picSize/2 * ptptoiScaleFactor}
              href={ptptoi.picture}
              width={picSize * ptptoiScaleFactor}
              height={picSize * ptptoiScaleFactor}/>
            </g>
        } else {
          return <circle
            r={4}
            fill={/* globals.groupColor(pt.gid)*/ ptptoi ? "orange" : "rgb(130,130,130)"}
            key={pt.bid}
            cx={pt.x}
            cy={pt.y}/>
        }
      })}
    </g>
  );
}

export default GraphParticipants;
