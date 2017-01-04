import React from "react";
// import { connect } from "react-redux";

import Radium from "radium";
import _ from "lodash";


var leftOffset = 70;
var topOffset = 70;

@Radium
class Report extends React.Component {

  makeRect(comment, row, column) {
    return (
      <g>
        <rect
          fill={d3.interpolateGreens(comment)}
          width="20"
          height="20"
          x={column * 20}
          y="0" />
          <text
            x={column * 20 + 5}
            y={13}
            textAnchor="auto"
            alignmentBaseline="auto"
            fill="rgba(0,0,0,0.5)"
            style={{
              fontFamily: "Helvetica, sans-serif",
              fontSize: 10
            }}>
            {Math.floor(comment * 100)}
          </text>
      </g>
    )
  }

  makeRow(comments, row) {
    return (
      <g transform={"translate(0, " + (row * 10 + topOffset) + ")"} >
        <text
          textAnchor="right"
          alignmentBaseline="middle"
          fill="rgba(0,0,0,0.5)"
          style={{
            fontFamily: "Helvetica, sans-serif",
            fontSize: 10
          }}>
          {this.props.tids[row]}
        </text>

        {
          comments.map((comment, column) => {

            return (
              <g key={column}>
                {
                row === 0 ?
                <g transform={"translate(" + (column * 10) + ", 20),  rotate(270)"}>
                  <text
                    textAnchor="right"
                    alignmentBaseline="middle"
                    fill="rgba(0,0,0,0.5)"
                    // style="font-family: Helvetica, sans-serif; font-size: 11px;"
                    >
                    {this.props.tids[column]}
                  </text>
                </g>
                : ""
              }
                <g>
                  {this.makeRect(comment, row, column)}
                </g>
            </g>
            )
          })
        }
      </g>
    )
  }

  renderMatrix() {
    return (
      <div>
        <p style={{margin: 20}}> pol.is report </p>
        <svg style={{margin: 100}} width="1000" height="1000">
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

export default Report;
