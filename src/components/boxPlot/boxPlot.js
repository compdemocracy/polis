import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import drawBoxPlot from "./drawBoxPlot";

class BoxPlot extends React.Component {

  componentDidMount() {
    drawBoxPlot();
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
      <div>
      <p> Which group was the most agreeable? </p>
      <div id="boxPlot"> </div>
      </div>
    );
  }
}

export default BoxPlot;
