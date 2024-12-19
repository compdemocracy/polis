// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState, useEffect } from "react";
import CommentList from "../lists/commentList.jsx";
import * as globals from "../globals";
import _ from "lodash";
// import Flex from "../framework/flex"

// function type(d) {
//   if (!d.value) return;
//   d.value = +d.value;
//   return d;
// }

// var formatValue = d3.format(",d");
// var probabilitiesScale = d3.scaleLinear().domain([-1, 1]).range([0, 1])

// const ProbabilityLegend = () => {
//   return (
//     <div style={{width: 500, marginTop: 30, marginBottom: 30}}>
//       <Flex justifyContent={"space-between"} alignItems={"baseline"} styleOverrides={{marginBottom: 5}}>
//         <span style={{fontSize: 10, width: 150}}>
//           negatively correlated
//         </span>
//         <span style={{fontSize: 10, width: 150, textAlign: "right"}}>
//           positively correlated
//         </span>
//       </Flex>
//       <img
//         style={{marginLeft: 0}}
//         width={"100%"}
//         height={20}
//         src={"https://raw.githubusercontent.com/d3/d3-scale-chromatic/master/img/PuOr.png"}/>
//       <Flex justifyContent={"space-between"} alignItems={"baseline"}>
//         <span style={{fontSize: 10, width: 150}}>
//           These two comments are in opposition. Participants who agreed with one comment tended to disagree with the other, or vice versa.
//         </span>
//         <span style={{fontSize: 10, width: 150, textAlign: "right"}}>
//           These two comments are harmonious. Participants tended to vote the same way on both comments, either agreeing or disagreeing with both.
//         </span>
//       </Flex>
//     </div>
//   )
// }


const VoronoiCells = ({ currentBeeswarmComment, voronoi, onHoverCallback }) => {

  /* https://bl.ocks.org/mbostock/6526445e2b44303eebf21da3b6627320 */

  const getFill = (cell) => {

    /* find the index of cell.data.tid in probabilitiesTids and use the index of it as the accessor */

    // if (
    //   !this.props.currentBeeswarmComment ||
    //   // !this.props.probabilities ||
    //   // !this.props.probabilitiesTids
    // ) {
    //   return
    if (currentBeeswarmComment?.tid === cell.data.tid) {
      return "rgb(255,0,0)";
    } else {
      return "black"
    }


    // else {
    //   /* for the given comment tid (as voronoi cell), find the index in the tid array that gives the coordinate in the matrix */
    //   const prob = this.props.probabilities[this.props.probabilitiesTids.indexOf(cell.data.tid)];
    //   if (prob === -1) { return "black" } else {
    //     return d3.interpolatePuOr(
    //       probabilitiesScale(
    //         this.props.probabilities[this.props.probabilitiesTids.indexOf(cell.data.tid)]
    //       )
    //     );
    //   }
    // }
  }


  return (
    <g>
      {
        voronoi.map((cell, i) => {
          return (
            <g key={i} onMouseEnter={onHoverCallback(cell)}>
              <path fill="none" style={{pointerEvents: "all"}} d={"M" + cell.join("L") + "Z"}/>

              <circle
                r={3}
                fill={getFill(cell)}
                cx={cell.data.x}
                cy={cell.data.y}
                />
            </g>
          )
        })
      }
    </g>
  )
}

const Beeswarm = ({ comments, extremity, probabilitiesTids, probabilities, conversation, ptptCount, math, formatTid, voteColors }) => {

    const svgWidth = 960;
    const svgHeight = 200;
    const margin = {top: 10, right: 10, bottom: 10, left: 10};
    const widthMinusMargins = 960 - margin.left - margin.right;
    const heightMinusMargins = 200 - margin.top - margin.bottom;

    const [currentBeeswarmComment, setCurrentBeeswarmComment] = useState(null);
    const [commentsWithExtremity, setCommentsWithExtremity] = useState(null);
    const [x, setX] = useState(null);
    const [axesRendered, setAxesRendered] = useState(false);
    const[vor, setVoronoi] = useState(null);

  const onHoverCallback = (d) => {
    return () => {
      setCurrentBeeswarmComment(d.data);
    }
  }

  const setup = () => {
    const commentsWithExtremityPlaceHolder = [];
    _.each(comments, (comment) => {
      if (extremity[comment.tid] > 0) {
        const cwe = Object.assign({}, comment, {extremity: extremity[comment.tid]});
        commentsWithExtremityPlaceHolder.push(cwe)
      }
    })

    var x = window.d3.scaleLinear()
      .rangeRound([0, widthMinusMargins]);

    x.domain(window.d3.extent(commentsWithExtremityPlaceHolder, function(d) { return d.extremity; }));

    var simulation = window.d3.forceSimulation(commentsWithExtremityPlaceHolder)
        .force("x", window.d3.forceX(function(d) {
          return x(d.extremity);
        }).strength(1))
        .force("y", window.d3.forceY(heightMinusMargins / 2))
        .force("collide", window.d3.forceCollide(4))
        .stop();

    for (var i = 0; i < 120; ++i) simulation.tick();

    const voronoi = window.d3.voronoi()
      .extent([[-margin.left, -margin.top], [widthMinusMargins + margin.right, heightMinusMargins + margin.top]])
      .x(function(d) { return d.x; })
      .y(function(d) { return d.y; })
    .polygons(commentsWithExtremityPlaceHolder)

    // if (!this.state.axesRendered) {
    //   d3.select("#beeswarmAxisAttachPointD3").append("g")
    //   .attr("class", "axis axis--x")
    //   .attr("transform", "translate(0," + this.heightMinusMargins + ")")
    //   .call(d3.axisBottom(x).ticks(3));
    // }

    setX(x);
    setVoronoi(voronoi);
    setCommentsWithExtremity(commentsWithExtremityPlaceHolder);
    setAxesRendered(true);
}

  useEffect(() => {
    if (
      comments &&
      extremity &&
      !commentsWithExtremity /* if we poll, change this so it is auto updating */
    ) {
      setup();
    }
  }, []);
  
  
  return (
    <div style={{width: svgWidth}}>
      <p style={globals.primaryHeading}> How divisive was the conversation? </p>
      <p style={globals.paragraph}>
        Statements (here as little circles) to the left were voted on the same way—either everyone agreed or everyone disagreed. Statements to the right were divisive—participants were split between agreement and disagreement.
      </p>
      <p style={globals.paragraph}>
        <strong>How to use this:</strong> Hover to see the statement text. Start on the far right to find out what the most divisive statement was.
      </p>
      <svg width={svgWidth} height={svgHeight}>
        <g id="beeswarmAxisAttachPointD3" transform={"translate(" + margin.left + "," + margin.top + ")"}>
          {
            commentsWithExtremity ?
            <VoronoiCells
              probabilitiesTids={probabilitiesTids}
              probabilities={currentBeeswarmComment ? probabilities[currentBeeswarmComment.tid] : null}
              currentBeeswarmComment={currentBeeswarmComment}
              voronoi={vor}
              onHoverCallback={onHoverCallback}/> : null
          }
        </g>
        <line x1="0" y1={svgHeight - 10} x2={svgWidth} y2={svgHeight - 10} strokeWidth="1" stroke="black"/>
      </svg>
      <div style={{display: "flex", justifyContent: "space-between", margin: 0}}>
        <p style={{margin: 0}}> Consensus statements </p>
        <p style={{margin: 0}}> Divisive statements</p>
      </div>
      {/*<ProbabilityLegend/>*/}

      <div style={{minHeight: "140px", paddingTop: "20px"}}>
        { currentBeeswarmComment ?

          <CommentList
            conversation={conversation}
            ptptCount={ptptCount}
            math={math}
            formatTid={formatTid}
            tidsToRender={[currentBeeswarmComment.tid]}
            comments={comments}
            voteColors={voteColors}/> : null
        }
      </div>

    </div>
  );
}

export default Beeswarm;

// <text
//   style={{textAnchor: "middle"}}
//   transform={"translate(" + (this.svgWidth/2) + " ," + (this.heightMinusMargins + this.margin.top + 40) + ")"}>
//   ← less divisive - more divisive →
// </text>
