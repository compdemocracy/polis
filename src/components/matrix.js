import React from "react";
// import { connect } from "react-redux";

import Radium from "radium";
import _ from "lodash";
import * as globals from "./globals";

var leftOffset = 17;
var topOffset = 50;

var scale = d3.scaleLinear().domain([-1, 1]).range([0, 1])

const square = 20;

@Radium
class Matrix extends React.Component {

  makeRect(comment, row, column) {
    return (
      <g>
        <rect
          fill={d3.interpolateRdBu(scale(comment))}
          width={square}
          height={square}
          />
          <text
            x={5}
            y={13}
            fill="rgba(0,0,0,0.5)"
            style={{
              fontFamily: globals.sans,
              fontSize: 10
            }}>
            {Math.floor(comment * 100)}
          </text>
      </g>
    )
  }

  makeColumn(comments, row) {
    return comments.map((comment, column) => {
      return (
        <g key={column} >
          {/* this translate places the top text labels where they should go, rotated */}
          <text
            transform={"translate(" + (column * square + 13) + ", 20), rotate(270)"}
            fill="rgba(0,0,0,0.7)"
            style={{
              display: row === 0 ? "block" : "none",
              fontFamily: "Helvetica, sans-serif",
              fontSize: 10,
              fontWeight: 700
            }}
            >
            {this.props.tids[column]}
          </text>
          {/* this translate places the columns where they should go, and creates a gutter */}
          <g transform={"translate(" + (column * square) + ", 30)"}>
            {this.makeRect(comment, row, column)}
          </g>
        </g>
      )
    })
  }

  makeRow(comments, row) {
    return (
      <g transform={"translate(0, " + (row * 20 + topOffset) + ")"}>
        {/* this translate seperates the rows */}
        <text
          fill="rgba(0,0,0,.7)"
          style={{
            fontFamily: "Helvetica, sans-serif",
            fontSize: 10,
            fontWeight: 700
          }}>
          {this.props.tids[row]}
        </text>
        {/* this translate moves just the colored squares over to make a gutter, not the text */}
        <g transform={"translate("+ leftOffset +", -43)"}>
          {this.makeColumn(comments, row)}
        </g>
      </g>
    )
  }

  renderMatrix() {
    return (
      <div>
        <p style={{fontSize: globals.primaryHeading}}>{this.props.title}</p>
        <p style={{width: globals.paragraphWidth}}>
          This is a matrix showing every comment by every comment (all comments are shown, in order of being submitted, on each axis). Each square represents the likihood that if someone agreed with one comment, they would agree with the other. For instance, [n%] of people who agreed with comment [n] also agreed with comment [m].
        </p>
        <svg style={{margin: 20}} width="1000" height="800">
          {this.props.probabilities.map((comments, row) => {
            return (
              <g key={row}>
                {this.makeRow(comments, row)}
              </g>
            )
          })}
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
      <div>loading matrix...</div>
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
