import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const Participant = ({pt, ptptois, ptptoiScaleFactor}) => {
  let ptptoi = ptptois[pt.bid];
  let markup;
  if (ptptoi) {
    let picSize = ptptoi.picture_size;
    markup = (
      <g
        transform={"translate(" + pt.x + "," + pt.y + ")"}>
        <clipPath id={"social_image_clip_" + pt.bid}>
          <circle cx={0} cy={0} r={10} />
        </clipPath>
        {ptptoi.isSelf ? <circle cx={0} cy={0} r={10} stroke={"#03a9f4"} strokeWidth={4}/> : ""}
        <image
          clipPath={`url(#social_image_clip_${pt.bid})`}
          x={-picSize/2 * ptptoiScaleFactor}
          y={-picSize/2 * ptptoiScaleFactor}
          xlinkHref={ptptoi.picture || ptptoi.pic}
          width={picSize * ptptoiScaleFactor}
          height={picSize * ptptoiScaleFactor}/>
      </g>
    )
  } else {
    markup = (<circle
      r={0}
      fill={/* globals.groupColor(pt.gid)*/ ptptoi ? "black" : "rgb(180,180,180)"}
      key={pt.bid}
      cx={pt.x}
      cy={pt.y}/>)
  }
  return markup;
}

const GraphParticipants = ({points, ptptois, ptptoiScaleFactor}) => {

  if (!points) return null

  return (
    <g id="vis2_participants">
      {
        points.map((pt, i) => {
          return (
            <Participant
              key={pt.bid}
              ptptois={ptptois}
              ptptoiScaleFactor={ptptoiScaleFactor}
              pt={pt}/>
          )
        })
      }
    </g>
  );
}

export default GraphParticipants;
