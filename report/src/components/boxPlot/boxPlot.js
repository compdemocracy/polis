// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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
      dataset[ii][1] = [];
      _.forEach(g.votes, (v) => {      /* extract agrees as percent */
        if (v["S"] > 0) {                           /* make sure someone saw it */
          dataset[ii][1].push(Math.floor(v["A"] / v["S"] * 100))  /* agreed / saw ... so perhaps 5 agreed / 10 saw for 50% */
        }
      });
    });
    return dataset;
  }

  render() {
    return (
      <div>
        <p style={globals.primaryHeading}> Average level of agreement per group </p>
        <p style={globals.paragraph}>
          Which group agreed the most, across all statements?
          The line in the middle of the blue boxes below shows the mean (average) percentage agreement by a given group across all statements.
          The lower the line in the middle of the blue box, the more a group disagreed. The higher the line, the more they agreed.
        </p>
        <p style={globals.paragraph}>
          If the mean, and the colored box is higher, it means people in the group agreed more overall.
          This would suggest their views are represented.
        </p>
        <p style={globals.paragraph}>
          If the colored box is lower, it means the group, on avereage, disagreed on more across all statements.
          A group with a lower than average agreement may be a group that needs to comment more,
          so that its views are properly represented.
        </p>
        <p style={globals.paragraph}>
          <a target="_blank" href="https://www.khanacademy.org/math/probability/data-distributions-a1/box--whisker-plots-a1/v/reading-box-and-whisker-plots">
          How to read a box plot
          </a> (3 minute video).</p>
        <div id="boxPlot"> </div>
      </div>
    );
  }
}

export default BoxPlot;
