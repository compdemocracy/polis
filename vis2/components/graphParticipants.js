import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import {VictoryAnimation} from "victory";

const Participant = ({ptpt, ptptoiScaleFactor, tweenX, tweenY}) => {
  let picSize = ptpt.picture_size;
  return (
    <g
      transform={"translate(" + tweenX + "," + tweenY + ")"}>
      <clipPath id={"social_image_clip_" + ptpt.bid}>
        <circle cx={0} cy={0} r={10} />
      </clipPath>
      {
        ptpt.isSelf ?
          <circle
            cx={0}
            cy={0}
            r={10}
            stroke={"#03a9f4"}
            strokeWidth={4}/> :
          ""
      }
      <image
        filter={"url(#grayscale)"}
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
            <VictoryAnimation
              easing={"quadOut"}
              duration={1500}
              key={ptpt.bid*100000 + ptpt.pid}
              data={{tweenX: ptpt.x, tweenY: ptpt.y}}>
                {(tweenedProps, animationInfo) => {
                  // if (animationInfo.animating && animationInfo.progress < 1) {
                    return  <Participant
                      tweenX={tweenedProps.tweenX}
                      tweenY={tweenedProps.tweenY}
                      key={ptpt.bid*100000 + ptpt.pid}
                      ptpt={ptpt}
                      ptptoiScaleFactor={ptptoiScaleFactor}/>
                  // }
                }}
            </VictoryAnimation>
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
