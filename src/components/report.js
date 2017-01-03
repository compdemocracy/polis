import React from "react";
// import { connect } from "react-redux";

import Radium from "radium";
import _ from "lodash";

@Radium
class Report extends React.Component {

  makeRect(comment, row, column) {
    return (
      <rect
        fill={d3.interpolateGreens(comment)}
        width="10"
        height="10"
        x={column * 10}
        y="0" />
    )
  }

  makeRow(comments, row) {
    return (
      <g transform={"translate(0, " + (row * 10) + ")"} >
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
            {
              row === 0 ?
              <g transform={"translate(" + (column * 10) + ", 20)"}>
                <text
                  textAnchor="right"
                  alignmentBaseline="middle"
                  fill="rgba(0,0,0,0.5)"
                  // style="font-family: Helvetica, sans-serif; font-size: 11px;"
                  >
                  {"a"}
                </text>
              </g>
              : ""
            }
            return (
              <g key={column}>
                {this.makeRect(comment, row, column)}
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
