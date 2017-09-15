import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import drawBoxPlot from "./drawBoxPlot";

class BoxPlot extends React.Component {

  componentDidMount() {
    drawBoxPlot(this.createBoxplotDataset());
  }

  createBoxplotDataset() {
    const dataset = [];
    _.each(this.props.groupVotes, (g, ii) => {      /* for each comment each group voted on ... */
      dataset[ii] = [];                             /* initialize empty array which will have two entries: label and array of votes */
      dataset[ii][0] = globals.groupLabels[g.id]    /* g.id = 0, so go get "A" for the label */
      dataset[ii][1] = _.map(g.votes, (v) => {      /* extract agrees as percent */
        if (v["S"] > 0) {                           /* make sure someone saw it */
          return Math.floor(v["A"] / v["S"] * 100)  /* agreed / saw ... so perhaps 5 agreed / 10 saw for 50% */
        }
      });
    });
    return dataset;
  }

  render() {
    return (
      <div>
      <p> Which group was the most agreeable? <a target="_blank" href="https://www.khanacademy.org/math/probability/data-distributions-a1/box--whisker-plots-a1/v/reading-box-and-whisker-plots"> How to read a box plot (3 minute video). </a> </p>
      <div id="boxPlot"> </div>
      </div>
    );
  }
}

export default BoxPlot;
