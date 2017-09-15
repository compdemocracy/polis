import React from "react";
import _ from "lodash";
import * as globals from "./globals";
import {
  VictoryScatter,
  VictoryChart,
  VictoryTheme,
  VictoryLabel,
  VictoryAxis,
  VictoryLine,

} from "victory";

class ScatterplotCommentAgreesPerGroup extends React.Component {

  xAxisTicks() {

    let ticks = [];

    _.each(this.props.groupVotes, (g, i) => {
      ticks.push(`${globals.groupLabels[i]} (${g["n-members"]})`)
    })

    return ticks;
  }

  createScatterData() {
    /*
      format:
      data={[
        { x: 0, y: 2 },
        { x: 1, y: 3 },
        { x: 3, y: 5 },
        { x: 3, y: 4 },
        { x: 2, y: 7 }
      ]}
    */

    const dataset = [];

    /* for each comment each group voted on ... */
    _.each(this.props.groupVotes, (g, ii) => {
      _.each(g.votes, (v, jj) => {
        if (v["S"] > 0) { /* make sure someone saw it */
          dataset.push({
            x: ii,
            y: Math.floor(v["A"] / v["S"] * 100) /* agreed / saw ... so perhaps 5 agreed / 10 saw for 50% */
          })
        }
      })
    })


    return dataset;
  }

  render() {
    return (
      <svg
        width={600}
        height={300}>
        <g transform={"translate(0, 0)"}>
          {/* Add shared independent axis */}
          <VictoryAxis
            offsetY={50}
            standalone={false}
            tickValues={this.xAxisTicks()}
          />

          <VictoryAxis dependentAxis
            domain={[0, 100]}
            offsetX={50}
            orientation="left"
            standalone={false}
          />

          <VictoryScatter
            domain={{x: [0, Object.keys(this.props.groupVotes).length - 1], y: [0, 100]}}
            style={{
              data: {
                fill: "rgba(46, 204, 113, .4)",
                stroke: "rgba(46, 204, 113, .8)",
                strokeWidth: 1,
              }
            }}
            size={4}
            data={this.createScatterData()}
          />

        </g>
      </svg>
    );
  }
}

export default ScatterplotCommentAgreesPerGroup;
