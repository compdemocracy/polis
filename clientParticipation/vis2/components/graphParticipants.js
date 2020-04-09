import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import {VictoryAnimation} from "victory";

const Participant = ({ptpt, tweenX, tweenY}) => {
  let picSize = ptpt.picture_size;
  return (
    <g
      transform={"translate(" + tweenX + "," + tweenY + ")"}>
      <clipPath id={"social_image_clip"}>
        <circle cx={0} cy={0} r={11} />
      </clipPath>
      {
        ptpt.isSelf ?
          <circle
            cx={0}
            cy={0}
            r={13}
            stroke={"#03a9f4"}
            strokeWidth={4}/> :
          ""
      }
      <image
        filter={"url(#grayscale)"}
        clipPath={"url(#social_image_clip)"}
        x={-picSize/2 * globals.ptptoiScaleFactor}
        y={-picSize/2 * globals.ptptoiScaleFactor}
        xlinkHref={ptpt.picture || ptpt.pic}
        width={picSize * globals.ptptoiScaleFactor}
        height={picSize * globals.ptptoiScaleFactor}/>
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


function getKey(ptpt) {
  return ptpt.isSelf ? "self" : (ptpt.bid*100000 + ptpt.pid);
}

const GraphParticipants = ({points, ptptois}) => {

  if (!points && !ptptois) return null

  return (
    <g id="vis2_participants">
      {
        ptptois.map((ptpt, i) => {
          return (
            <VictoryAnimation
              easing={"quadOut"}
              duration={1500}
              key={getKey(ptpt)}
              data={{tweenX: ptpt.x, tweenY: ptpt.y}}>
                {
                  (tweenedProps, animationInfo) => {
                    // if (animationInfo.animating && animationInfo.progress < 1) {
                      return  <Participant
                        tweenX={tweenedProps.tweenX}
                        tweenY={tweenedProps.tweenY}
                        key={getKey(ptpt) + "_"}
                        ptpt={ptpt}/>
                    // }
                  }
                }
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
