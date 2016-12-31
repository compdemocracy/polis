import React from "react";
// import { connect } from "react-redux";
import probabilities from "../sampleData/probabilities";

import Radium from "radium";
import _ from "lodash";

@Radium
class App extends React.Component {

  makeRect(comment, row, column) {
    return (
      <rect
        fill={d3.interpolateGreens(comment)}
        width="5"
        height="5"
        y={row * 10}
        x={column * 10}  />
    )
  }

  makeRow(comments, row) {
    return (
      <g>
        {comments.map((comment, column) => {
          return (
            <g>
              {this.makeRect(comment, row, column)}
            </g>
          )
        })}
      </g>
    )
  }

  render() {
    return (
      <div>
        <p style={{margin: 20}}> pol.is report </p>
        <svg style={{margin: 100}} width="1000" height="1000">
          {probabilities.map((comments, row) => {
            return (
              <g key={Math.random()}>
                {this.makeRow(comments, row)}
              </g>
            )
          })}
        </svg>
      </div>
    );
  }
}

export default App;
