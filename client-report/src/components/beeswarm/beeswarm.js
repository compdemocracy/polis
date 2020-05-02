// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import CommentList from "../lists/commentList";
import * as globals from "../globals";
import _ from "lodash";
import Flex from "../framework/flex"

function type(d) {
  if (!d.value) return;
  d.value = +d.value;
  return d;
}

var formatValue = d3.format(",d");
var probabilitiesScale = d3.scaleLinear().domain([-1, 1]).range([0, 1])

const ProbabilityLegend = () => {
  return (
    <div style={{width: 500, marginTop: 30, marginBottom: 30}}>
      <Flex justifyContent={"space-between"} alignItems={"baseline"} styleOverrides={{marginBottom: 5}}>
        <span style={{fontSize: 10, width: 150}}>
          negatively correlated
        </span>
        <span style={{fontSize: 10, width: 150, textAlign: "right"}}>
          positively correlated
        </span>
      </Flex>
      <img
        style={{marginLeft: 0}}
        width={"100%"}
        height={20}
        src={"https://raw.githubusercontent.com/d3/d3-scale-chromatic/master/img/PuOr.png"}/>
      <Flex justifyContent={"space-between"} alignItems={"baseline"}>
        <span style={{fontSize: 10, width: 150}}>
          These two comments are in opposition. Participants who agreed with one comment tended to disagree with the other, or vice versa.
        </span>
        <span style={{fontSize: 10, width: 150, textAlign: "right"}}>
          These two comments are harmonious. Participants tended to vote the same way on both comments, either agreeing or disagreeing with both.
        </span>
      </Flex>
    </div>
  )
}


class VoronoiCells extends React.Component {

  /* https://bl.ocks.org/mbostock/6526445e2b44303eebf21da3b6627320 */

  getFill(cell) {

    /* find the index of cell.data.tid in probabilitiesTids and use the index of it as the accessor */

    // if (
    //   !this.props.currentBeeswarmComment ||
    //   // !this.props.probabilities ||
    //   // !this.props.probabilitiesTids
    // ) {
    //   return
    if (this.props.currentBeeswarmComment && this.props.currentBeeswarmComment.tid === cell.data.tid) {
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

  render() {

    return (
      <g>
        {
          this.props.voronoi.map((cell, i) => {
            return (
              <g key={i} onMouseEnter={this.props.onHoverCallback(cell)}>
                <path fill="none" style={{pointerEvents: "all"}} d={"M" + cell.join("L") + "Z"}/>

                <circle
                  r={3}
                  fill={this.getFill(cell)}
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
}

class Beeswarm extends React.Component {
  constructor(props) {
    super(props);

    this.svgWidth = 960;
    this.svgHeight = 200;
    this.margin = {top: 10, right: 10, bottom: 10, left: 10};
    this.widthMinusMargins = 960 - this.margin.left - this.margin.right;
    this.heightMinusMargins = 200 - this.margin.top - this.margin.bottom;

    this.state = {
      currentBeeswarmComment: null,
      commentsWithExtremity: null,
      axesRendered: false,
    };
  }
  onHoverCallback(d) {
    return () => {
      this.setState({currentBeeswarmComment: d.data});
    }
  }

  componentDidMount() {
    if (
      this.props.comments &&
      this.props.extremity &&
      !this.state.commentsWithExtremity /* if we poll, change this so it is auto updating */
    ) {
      this.setup();
    }
  }
  setup () {
      const commentsWithExtremity = [];
      _.each(this.props.comments, (comment) => {
        if (this.props.extremity[comment.tid] > 0) {
          const cwe = Object.assign({}, comment, {extremity: this.props.extremity[comment.tid]});
          commentsWithExtremity.push(cwe)
        }
      })

      var x = d3.scaleLinear()
        .rangeRound([0, this.widthMinusMargins]);

      x.domain(d3.extent(commentsWithExtremity, function(d) { return d.extremity; }));

      var simulation = d3.forceSimulation(commentsWithExtremity)
          .force("x", d3.forceX(function(d) {
            return x(d.extremity);
          }).strength(1))
          .force("y", d3.forceY(this.heightMinusMargins / 2))
          .force("collide", d3.forceCollide(4))
          .stop();

      for (var i = 0; i < 120; ++i) simulation.tick();

      const voronoi = d3.voronoi()
        .extent([[-this.margin.left, -this.margin.top], [this.widthMinusMargins + this.margin.right, this.heightMinusMargins + this.margin.top]])
        .x(function(d) { return d.x; })
        .y(function(d) { return d.y; })
      .polygons(commentsWithExtremity)

      // if (!this.state.axesRendered) {
      //   d3.select("#beeswarmAxisAttachPointD3").append("g")
      //   .attr("class", "axis axis--x")
      //   .attr("transform", "translate(0," + this.heightMinusMargins + ")")
      //   .call(d3.axisBottom(x).ticks(3));
      // }

      this.setState({
        x,
        voronoi,
        commentsWithExtremity,
        axesRendered: true
      })
  }
  render() {
    return (
      <div style={{width: this.svgWidth}}>
        <p style={globals.primaryHeading}> How divisive was the conversation? </p>
        <p style={globals.paragraph}>
          Statements (here as little circles) to the left were voted on the same way—either everyone agreed or everyone disagreed. Statements to the right were divisive—participants were split between agreement and disagreement.
        </p>
        <p style={globals.paragraph}>
          <strong>How to use this:</strong> Hover to see the statement text. Start on the far right to find out what the most divisive statement was.
        </p>
        <svg width={this.svgWidth} height={this.svgHeight}>
          <g id="beeswarmAxisAttachPointD3" transform={"translate(" + this.margin.left + "," + this.margin.top + ")"}>
            {
              this.state.commentsWithExtremity ?
              <VoronoiCells
                probabilitiesTids={this.props.probabilitiesTids}
                probabilities={this.state.currentBeeswarmComment ? this.props.probabilities[this.state.currentBeeswarmComment.tid] : null}
                currentBeeswarmComment={this.state.currentBeeswarmComment}
                voronoi={this.state.voronoi}
                onHoverCallback={this.onHoverCallback.bind(this)}/> : null
            }
          </g>
          <line x1="0" y1={this.svgHeight - 10} x2={this.svgWidth} y2={this.svgHeight - 10} strokeWidth="1" stroke="black"/>
        </svg>
        <div style={{display: "flex", justifyContent: "space-between", margin: 0}}>
          <p style={{margin: 0}}> Consensus statements </p>
          <p style={{margin: 0}}> Divisive statements</p>
        </div>
        {/*<ProbabilityLegend/>*/}

        <div style={{minHeight: "140px", paddingTop: "20px"}}>
          { this.state.currentBeeswarmComment ?

            <CommentList
              conversation={this.props.conversation}
              ptptCount={this.props.ptptCount}
              math={this.props.math}
              formatTid={this.props.formatTid}
              tidsToRender={[this.state.currentBeeswarmComment.tid]}
              comments={this.props.comments}
              voteColors={this.props.voteColors}/> : null
          }
        </div>

      </div>
    );
  }
}

export default Beeswarm;

// <text
//   style={{textAnchor: "middle"}}
//   transform={"translate(" + (this.svgWidth/2) + " ," + (this.heightMinusMargins + this.margin.top + 40) + ")"}>
//   ← less divisive - more divisive →
// </text>
