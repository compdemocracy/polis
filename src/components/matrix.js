import React from "react";
// import { connect } from "react-redux";
import Flex from "./flex";

import Radium from "radium";
import _ from "lodash";
import * as globals from "./globals";

var leftOffset = 34;
var topOffset = 60;

var scale = d3.scaleLinear().domain([-1, 1]).range([0, 1])

const square = 20;

@Radium
class Matrix extends React.Component {


  onMouseEnterCell(row, column, correlation) {
    this.setState({
      mouseOverRow: row,
      mouseOverColumn: column,
      mouseOverCorrelation: correlation,
    });
  }
  onMouseExitCell(row, column) {
    this.setState({
      mouseOverRow: null,
      mouseOverColumn: null,
      mouseOverCorrelation: null,
    });
  }

  makeRect(comment, row, column) {
    return (
      <g>
        <rect
          fill={d3.interpolateRdBu(scale(comment))}
          onMouseEnter={() => {
            return this.onMouseEnterCell(row, column, comment);
          }}
          width={square}
          height={square} />
          <text
            x={10}
            y={13}
            textAnchor={"middle"}
            fill={Math.abs(Math.floor(comment * 100)) > 30 ? "white" : "rgb(60,60,60)"}
            style={{
              fontFamily: globals.sans,
              fontSize: 10,
              pointerEvents: "none",
            }}>
            {Math.floor(comment * 100)}
          </text>
      </g>
    )
  }

  makeColumn(comments, row) {
    // <text
    //   transform={"translate(" + (column * square + 10) + ", 25), rotate(315)"}
    //   fill="rgba(0,0,0,0.7)"
    //   style={{
    //     display: row === 0 ? "block" : "none",
    //     fontFamily: "Helvetica, sans-serif",
    //     fontSize: 10,
    //     fontWeight: 700
    //   }}
    //   >
    //   {this.props.formatTid(this.props.tids[column])}
    // </text>
    return comments.map((comment, column) => {
      let markup = null;
      if (column < row) {  /* diagonal matrix */
        markup = (
          <g key={column} >
            {/* this translate places the top text labels where they should go, rotated */}
            {/* this translate places the columns where they should go, and creates a gutter */}
            <g transform={"translate(" + (column * square) + ", 30)"}>
              {this.makeRect(comment, row, column)}
            </g>
          </g>
        )
      } else if (column === row) {
        const comment = _.find(this.props.comments, (comment) => {
          return comment.tid === this.props.tids[column]
        })
        markup = (
          <g key={column} >
            <text

              onMouseEnter={() => {
                return this.onMouseExitCell();
              }}
              onMouseLeave={() => {
                return this.onMouseExitCell();
              }}
              transform={"translate(" + (column * square + 10) + ", 46), rotate(315)"}
              fill={ (column === this.state.mouseOverColumn || column === this.state.mouseOverRow) ? "rgba(0,0,0,1)" : "rgba(0,0,0,0.5)"}
              style={{
                fontFamily: "Helvetica, sans-serif",
                fontSize: 10,
                fontWeight: 700
              }}
              >
              {
                comment ? comment.txt : "[[[none found]]]"
              }
            </text>
          </g>
        )
      }
      return markup;
    })
  }

  makeRow(comments, row) {
    // {/* this translate seperates the rows */}
    // <text
    //   fill="rgba(0,0,0,.7)"
    //   style={{
    //     fontFamily: "Helvetica, sans-serif",
    //     fontSize: 10,
    //     fontWeight: 700
    //   }}>
    //   {this.props.formatTid(this.props.tids[row])}
    // </text>
    return (
      <g transform={"translate(0, " + (row * 20 + topOffset) + ")"}>
        {/* this translate moves just the colored squares over to make a gutter, not the text */}
        <g transform={"translate("+ leftOffset +", -43)"}>
          {this.makeColumn(comments, row)}
        </g>
      </g>
    )
  }

  renderMatrix() {
    let side = this.props.probabilities.length * square + 750;
    return (
      <div>
        <p style={globals.primaryHeading}>{this.props.title}</p>
        <p style={globals.paragraph}>
          What is the probability that a participant who agreed (or disagreed) with a given comment also agreed (or disagreed) with another given comment? This symmetrical matrix, which shows all comments along both axes, computes this probability. Patterns emerge when we evaluate groups of comments that tended to be voted on similarly.
        </p>

        <div style={{width: 500, marginTop: 30}}>
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
            src={"https://raw.githubusercontent.com/d3/d3-scale-chromatic/master/img/RdBu.png"}/>
          <Flex justifyContent={"space-between"} alignItems={"baseline"}>
            <span style={{fontSize: 10, width: 150}}>
              These two comments are in opposition. Participants who agreed with one comment tended to disagree with the other, or vice versa.
            </span>
            <span style={{fontSize: 10, width: 150, textAlign: "right"}}>
              These two comments are harmonious. Participants tended to vote the same way on both comments, either agreeing or disagreeing with both.
            </span>
          </Flex>
        </div>

        <svg width="100%" height={side} style={{cursor: "crosshair"}}>

          <rect
            fill="rgba(0,0,0,0)"
            onMouseEnter={() => {
              return this.onMouseExitCell();
            }}
            onMouseLeave={() => {
              return this.onMouseExitCell();
            }}
            width={side}
            height={side} />

          {this.state.mouseOverCorrelation === null ? "" : <text
            x={200}
            y={100}
            textAnchor={"middle"}
            fill={d3.interpolateRdBu(scale(this.state.mouseOverCorrelation))}
            style={{
              fontFamily: globals.sans,
              fontSize: 20
            }}>
            {Math.round(this.state.mouseOverCorrelation * 1000) / 1000}
          </text>}

          <g transform={"translate(1200,0), rotate(45)"/* abstract translate magic number */}>
          {this.props.probabilities.map((comments, row) => {
            return (
              <g key={row}>
                {this.makeRow(comments, row)}
              </g>
            )
          })}
          </g>
        </svg>
      </div>
    );
  }
  renderError(err) {
    return (
      <div>
        <div> error loading matrix </div>
        <div>{err}</div>
      </div>
    );
  }
  renderLoading() {
    return (
      <div>loading matrix... (may take up to a minute)</div>
    );
  }
  render() {
    if (this.props.error) {
      return this.renderError();
    } else if (this.props.probabilities) {
      return this.renderMatrix();
    } else {
      return this.renderLoading();
    }
  }
}

export default Matrix;



// This is a matrix showing every comment by every comment (all comments are shown, in order of being submitted, on each axis). Each square represents the likihood that if someone agreed with one comment, they would agree with the other. For instance, [n%] of people who agreed with comment [n] also agreed with comment [m].
