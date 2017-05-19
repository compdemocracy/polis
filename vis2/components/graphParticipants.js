import React from "react";
import _ from "lodash";
import * as globals from "./globals";

const Participant = ({ptpt, ptptoiScaleFactor}) => {
  let picSize = ptpt.picture_size;
  return (
    <g
      transform={"translate(" + ptpt.x + "," + ptpt.y + ")"}>
      <clipPath id={"social_image_clip_" + ptpt.bid}>
        <circle cx={0} cy={0} r={10} />
      </clipPath>
      {ptpt.isSelf ? <circle cx={0} cy={0} r={10} stroke={"#03a9f4"} strokeWidth={4}/> : ""}
      <image
        clipPath={`url(#social_image_clip_${ptpt.bid})`}
        x={-picSize/2 * ptptoiScaleFactor}
        y={-picSize/2 * ptptoiScaleFactor}
        xlinkHref={ptpt.picture || ptpt.pic}
        width={picSize * ptptoiScaleFactor}
        height={picSize * ptptoiScaleFactor}/>
    </g>
  );
}

const Bucket = ({pt}) => {
  return <circle
    r={0}
    fill={/* globals.groupColor(pt.gid)*/ "rgb(180,180,180)"}
    key={pt.bid}
    cx={pt.x}
    cy={pt.y}/>;
}

const GraphParticipants = ({points, ptptois, ptptoiScaleFactor}) => {

  if (!points && !ptptois) return null

  return (
    <g id="vis2_participants">
      {
        ptptois.map((ptpt, i) => {
          return (
            <Participant
              key={ptpt.bid*100000 + ptpt.pid}
              ptpt={ptpt}
              ptptoiScaleFactor={ptptoiScaleFactor}/>
          )
        })
      }
      {
        points.map((pt, i) => {
          return (
            <Bucket
              key={pt.bid}
              pt={pt}/>
          )
        })
      }
    </g>
  );
}

export default GraphParticipants;
