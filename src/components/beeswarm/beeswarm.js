import React from "react";
import drawBeeswarm from "./drawBeeswarm";
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

    if (
      !this.props.currentBeeswarmComment ||
      !this.props.probabilities ||
      !this.props.probabilitiesTids
    ) {
      return
    } else if (this.props.currentBeeswarmComment.tid === cell.data.tid) {
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
                  fill={this.props.currentBeeswarmComment ? this.getFill(cell) : "rgb(0,0,0)"}
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
    this.margin = {top: 40, right: 40, bottom: 40, left: 40};
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

      if (!this.state.axesRendered) {
        d3.select("#beeswarmAxisAttachPointD3").append("g")
        .attr("class", "axis axis--x")
        .attr("transform", "translate(0," + this.heightMinusMargins + ")")
        .call(d3.axisBottom(x).ticks(9));
      }

      this.setState({
        x,
        voronoi,
        commentsWithExtremity,
        axesRendered: true
      })
  }
  render() {
    return (
      <div>
        <p style={globals.primaryHeading}> Which statements were divisive? </p>
        <p style={globals.paragraph}>
          Which statements did everyone vote the same way on, vs which statements were voted on differently?
          If most of the statements (here as little circles) are to the left of the graph, the conversation was mostly
          in agreement. If towards the right, there were a lot of controversial statements.
        </p>
        <p style={globals.paragraph}>
          If most of the statements (here as little circles) are to the left of the graph, the conversation was mostly
          in agreement. If towards the right, there were a lot of controversial statements.
        </p>
        <p style={{fontWeight: 500, maxWidth: 600, lineHeight: 1.4, minHeight: 70}}>
          {
            this.state.currentBeeswarmComment ?
            "#" + this.state.currentBeeswarmComment.tid + ". " + this.state.currentBeeswarmComment.txt :
            "Hover on a comment to see it."
          }
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
          <text
            style={{textAnchor: "middle"}}
            transform={"translate(" + (this.svgWidth/2) + " ," + (this.heightMinusMargins + this.margin.top + 40) + ")"}>
            ← less divisive - more divisive →
          </text>
        </svg>

        {/*<ProbabilityLegend/>*/}

      </div>
    );
  }
}

export default Beeswarm;
