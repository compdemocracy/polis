import React from "react";
import _ from "lodash";
import {ReactSVGPanZoom} from 'react-svg-pan-zoom';
import * as globals from "../globals";
import graphUtil from "../../util/graphUtil";
import Axes from "../graphAxes";
// import Participants from "./graphParticipants";
// import Hull from "./hull";

const Participants = ({points}) => {

  if (!points) {
    return null
  }
// transform={`translate(${globals.side / 2},${globals.side / 2})`}>
  return (
    <g>
      {points.map((pt, i) => {
        // return <circle
        //   r={2}
        //   fill={globals.groupColor(pt.gid)}
        //   key={i}
        //   cx={pt.x}
        //   cy={pt.y}/>
        return (<text
            key={i}
            transform={
              `translate(
                ${pt.x},
                ${pt.y}
              )`
            }
            style={{
              fill: "rgba(0,0,0,.5)",
              fontSize: 12,
            }}
            >
            {globals.groupSymbols[pt.gid]}
          </text>)
      })}
    </g>
  );
}

class ParticipantsGraph extends React.Component {

  constructor(props) {
    super(props);
    this.Viewer = null;
    this.state = {
      selectedComment: null,
    };
  }

  handleCommentClick(selectedComment) {
    return () => {
      this.setState({selectedComment});
    }
  }

  render() {

    if (!this.props.math) {
      return null;
    }

    const {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
    } = graphUtil(this.props.comments, this.props.math, this.props.badTids);

    console.log(this.props, baseClustersScaled, hulls)

    return (
      <div style={{position: "relative"}}>
        <div>
          <p style={globals.primaryHeading}> Participants </p>
          <p style={globals.paragraph}>
          How do participants relate to each other?
          </p>
          <p style={globals.paragraph}>
          In this graph, participants are positioned closer to statements on which the agreed (see Comments graph above)
          and further from statements on which they disagreed.
          This means participants who voted similarly are closer together.
          </p>
          <p style={globals.paragraph}>
            This is meaningful as it lends visual weight to the <i>amount</i> of people who fall in each quadrant,
            the characteristics of which have been established above.
          </p>
        </div>
          <p style={globals.paragraph}>
            {hulls.map((h,i) => {
              return (
                <span style={{marginRight: 40}} key={i}>
                  {`${globals.groupSymbols[i]} ${globals.groupLabels[i]}`}
                </span>
              )
            })}
          </p>
          <svg
            style={{
              border: "1px solid rgb(180,180,180)",

            }}
            width={this.props.height ? this.props.height : globals.side}
            height={this.props.height ? this.props.height : globals.side}>
            {/* Comment https://bl.ocks.org/mbostock/7555321 */}
            <g transform={`translate(${globals.side / 2}, ${15})`}>
              <text
                style={{
                  fontFamily: "Georgia",
                  fontSize: 14,
                  fontStyle: "italic"
                }}
                textAnchor="middle">

              </text>
            </g>
            <Axes xCenter={xCenter} yCenter={yCenter} report={this.props.report}/>
            <Participants points={baseClustersScaled}/>
          </svg>

      </div>
    );
  }
}

export default ParticipantsGraph;
