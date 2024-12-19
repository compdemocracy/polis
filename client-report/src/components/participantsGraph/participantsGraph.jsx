// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState } from "react";
import * as globals from "../globals.js";
import graphUtil from "../../util/graphUtil.js";
import Axes from "../graphAxes.jsx";
import * as d3contour from "d3-contour";
import * as d3chromatic from "d3-scale-chromatic";
import Comments from "../commentsGraph/comments.jsx";
import Hull from "./hull.jsx";
import CommentList from "../lists/commentList.jsx";

const pointsPerSquarePixelMax = 0.0017; /* choose dynamically ? */
const contourBandwidth = 20;
const colorScaleDownFactor = 0.5; /* The colors are too dark. This helps. */


const Contour = ({ contour }) => {
  const color = window.d3
    .scaleSequential(d3chromatic.interpolateYlGnBu)
    .domain([0, pointsPerSquarePixelMax]);
  const geoPath = window.d3.geoPath();
  return <path fill={color(contour.value * colorScaleDownFactor)} d={geoPath(contour)} />
};

const Participants = ({ points, math }) => {
  if (!points) {
    return null;
  }

  return (
    <g>
      {points.map((pt, i) => {
        return (
          <g key={i}>
            <circle
              r={Math.sqrt(math["base-clusters"].count[pt.id]) * 3}
              fill={globals.groupColor(pt.gid)}
              fillOpacity=".3"
              cx={pt.x}
              cy={pt.y}
            />
            <text fill={globals.groupColor(pt.gid)} fillOpacity=".8" x={pt.x - 5} y={pt.y + 5}>
              {" "}
              {globals.groupSymbols[pt.gid]}
            </text>
          </g>
        );
      })}
    </g>
  );
};

const ParticipantsGraph = (props) => {
  const [selectedComment, setSelectedComment] = useState(null);
  const [showContour, setShowContour] = useState(false);
  const [showGroupLabels, setShowGroupLabels] = useState(true);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showGroupOutline, setShowGroupOutline] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showRadialAxes, setShowRadialAxes] = useState(true);

  const handleCommentClick = (sc) => {
    return () => {
      setSelectedComment(sc);
    };
  }

  const getInnerRadialAxisColor = () => {
    let color = globals.brandColors.lightgrey;
    if (props.consensusDivisionColorScale && props.colorBlindMode) {
      color = globals.brandColors.blue;
    } else if (props.consensusDivisionColorScale && !props.colorBlindMode) {
      color = props.voteColors.agree;
    }
    return color;
  }

  if (!props.math) {
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
  } = graphUtil(props.comments, props.math, props.badTids);

  const contours = d3contour
    .contourDensity()
    .x(function (d) {
      return d.x;
    })
    .y(function (d) {
      return d.y;
    })
    .size([globals.side, globals.side])
    // .bandwidth(10)(baseClustersScaled)
    .bandwidth(contourBandwidth)(baseClustersScaled);

  return (
    <div style={{ position: "relative" }}>
      <div>
        <p style={globals.primaryHeading}> Graph </p>
        <p style={globals.paragraph}>
          Which statements were voted on similarly? How do participants relate to each other?
        </p>
        <p style={globals.paragraph}>
          In this graph, statements are positioned more closely to statements which were voted on
          similarly. Participants, in turn, are positioned more closely to statements on which
          they agreed, and further from statements on which they disagreed. This means
          participants who voted similarly are closer together.
        </p>
      </div>
      <div>
        <button
          style={{
            color: showAxes ? "white" : "black",
            border: showAxes ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showAxes ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowAxes(a => !a);
          }}
        >
          Axes
        </button>
        <button
          style={{
            color: showRadialAxes ? "white" : "black",
            border: showRadialAxes ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showRadialAxes ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowRadialAxes(ra => !ra);
          }}
        >
          Radial axes
        </button>
        <button
          style={{
            color: showComments ? "white" : "black",
            border: showComments ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showComments ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowComments(c => !c)
          }}
        >
          Statements
        </button>
        <button
          style={{
            color: showParticipants ? "white" : "black",
            border: showParticipants ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showParticipants ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowParticipants(p => !p);
          }}
        >
          Participants (bucketized)
        </button>
        <button
          style={{
            color: showGroupOutline ? "white" : "black",
            border: showGroupOutline ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showGroupOutline ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowGroupOutline(g => !g);
          }}
        >
          Group outline
        </button>
        <button
          style={{
            color: showGroupLabels ? "white" : "black",
            border: showGroupLabels ? "1px solid #03A9F4" : "1px solid black",
            cursor: "pointer",
            borderRadius: 3,
            background: showGroupLabels ? "#03A9F4" : "none",
            padding: 4,
            marginRight: 20,
          }}
          onClick={() => {
            setShowGroupLabels(l => !l);
          }}
        >
          Group labels
        </button>
      </div>

      <div style={{ paddingTop: "30px", paddingBottom: "10px" }}>
        {selectedComment ? (
          <CommentList
            conversation={props.conversation}
            ptptCount={props.ptptCount}
            math={props.math}
            formatTid={props.formatTid}
            tidsToRender={[selectedComment.tid]}
            comments={props.comments}
            voteColors={props.voteColors}
          />
        ) : (
          <p>Click a statement, identified by its number, to explore regions of the graph.</p>
        )}
      </div>

      {showParticipants ? (
        <p style={globals.paragraph}>
          {hulls.map((h, i) => {
            return (
              <span style={{ marginRight: 40 }} key={i}>
                {`${globals.groupSymbols[i]}`}
                <span
                  style={{
                    fontFamily:
                      '"HelveticaNeue-Light", "Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif',
                  }}
                >
                  {" "}
                  {`${globals.groupLabels[i]}`}{" "}
                </span>
              </span>
            );
          })}
        </p>
      ) : null}
      <svg
        className="shrink-for-print-70 move-left-20-for-print"
        width={props.height ? props.height : globals.side}
        height={props.height ? props.height : globals.side}
      >
        <defs>
          <radialGradient
            cx="50%"
            cy="50%"
            fx="50%"
            fy="50%"
            r="43.818169%"
            id="radialGradient-1"
          >
            <stop stopColor={props.voteColors.agree} offset="0%"></stop>
            <stop stopColor={globals.brandColors.yellowForRadial} offset="46.7315051%"></stop>
            <stop stopColor={props.voteColors.disagree} offset="100%"></stop>
          </radialGradient>
          <circle
            id="path-2"
            style={{ pointerEvents: "none" }}
            cx={xCenter}
            cy={yCenter}
            r={globals.side / 2.3}
          ></circle>
        </defs>
        {showRadialAxes ? (
          <g>
            <circle
              strokeWidth={1}
              stroke={"rgb(230,230,230)"}
              fill={"rgb(248,248,248)"}
              cx={xCenter}
              cy={yCenter}
              r={globals.side / 2.3}
            />
            <circle
              strokeWidth={1}
              stroke={"rgb(230,230,230)"}
              fill={"rgb(245,245,245)"}
              cx={xCenter}
              cy={yCenter}
              r={globals.side / 4}
            />
            <circle
              strokeWidth={1}
              stroke={"rgb(230,230,230)"}
              fill={"rgb(248,248,248)"}
              cx={xCenter}
              cy={yCenter}
              r={globals.side / 8}
            />
          </g>
        ) : null}
        {showContour
          ? contours.map((contour, i) => <Contour key={i} contour={contour} />)
          : null}
        {showAxes ? (
          <Axes xCenter={xCenter} yCenter={yCenter} report={props.report} />
        ) : null}
        {showGroupOutline
          ? hulls.map((hull) => {
              let gid = hull.group[0].gid;
              if (typeof props.showOnlyGroup === 'number' && isFinite(props.showOnlyGroup)) {
                if (gid !== props.showOnlyGroup) {
                  return "";
                }
              }
              return <Hull key={gid} hull={hull} />;
            })
          : null}
        {showParticipants ? (
          <Participants math={props.math} points={baseClustersScaled} />
        ) : null}
        {showComments ? (
          <Comments
            {...props}
            handleClick={handleCommentClick}
            parentGraph={"contour"}
            points={commentsPoints}
            xx={xx}
            yy={yy}
            xCenter={xCenter}
            yCenter={yCenter}
            xScaleup={commentScaleupFactorX}
            yScaleup={commentScaleupFactorY}
          />
        ) : null}
        {showGroupLabels
          ? props.math["group-clusters"].map((g, i) => {
              // console.log('g',g )
              return (
                <text
                  key={i}
                  transform={`translate(
                      ${xx(g.center[0])},
                      ${yy(g.center[1])}
                    )`}
                  style={{
                    fill: "rgba(0,0,0,.5)",
                    fontFamily: "Helvetica",
                    fontWeight: 700,
                    fontSize: 18,
                  }}
                >
                  {globals.groupLabels[g.id]}
                </text>
              );
            })
          : null}
        {props.consensusDivisionColorScale ? (
          <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
            <g id="Artboard-Copy-4">
              <g id="Oval">
                <use
                  fill="url(#radialGradient-1)"
                  fillRule="evenodd"
                  style={{
                    mixBlendMode: "color-burn",
                  }}
                  xlinkHref="#path-2"
                ></use>
                <use stroke="none" strokeWidth="1" xlinkHref="#path-2"></use>
              </g>
            </g>
          </g>
        ) : null}
      </svg>
    </div>
  );
}

export default ParticipantsGraph;
