// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { setState } from "react";
import * as globals from "../globals";
import graphUtil from "../../util/graphUtil";
import Axes from "../graphAxes";
import Comments from "./comments";

const CommentsGraph = ({ comments, math, badTids, height, report, groupNames, formatTid, repfulAgreeTidsByGroup, renderHeading, voteColors }) => {
  const [viewer, setViewer] = useState(null);
  const [selectedComment, setSelectedComment] = useState(null);

  const handleCommentClick = (sc) => {
    return () => {
      setSelectedComment(sc);
    };
  }

    if (math) {
      return null;
    }

    const {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      commentScaleupFactorX,
      commentScaleupFactorY,
    } = graphUtil(comments, math, badTids);

    return (
      <div style={{ position: "relative" }}>
        <div>
          <p style={globals.primaryHeading}> Statements </p>
          <p style={globals.paragraph}>
            How do statements relate to each other? Did people who agreed with one comment also
            agree with another?
          </p>
          <p style={globals.paragraph}>
            In this graph, statements that met disagreement are closer together if they were voted
            on similarly. Those statements which were voted on differently are further apart.
          </p>
          <p style={Object.assign({}, globals.paragraph, { fontStyle: "italic" })}>
            This is important because it is the basis on which we will lay out and cluster
            participants in a 2d space in later steps (closer to the statements on which they
            agreed). There are no meaningful axes, but there are regions of statements that lend a
            certain personality to a given area.
          </p>
        </div>
        <p style={{ fontWeight: 500, maxWidth: 600, lineHeight: 1.4, minHeight: 50 }}>
          {selectedComment
            ? "#" + selectedComment.tid + ". " + selectedComment.txt
            : "Click a statement, identified by its number, to explore regions of the graph."}
        </p>
        <svg
          style={{
            border: "1px solid rgb(180,180,180)",
          }}
          width={height ? height : globals.side}
          height={height ? height : globals.side}
        >
          {/* Comment https://bl.ocks.org/mbostock/7555321 */}
          <g transform={`translate(${globals.side / 2}, ${15})`}>
            <text
              style={{
                fontFamily: "Georgia",
                fontSize: 14,
                fontStyle: "italic",
              }}
              textAnchor="middle"
            ></text>
          </g>
          <Axes xCenter={xCenter} yCenter={yCenter} report={report} />
          {commentsPoints ? (
            <Comments
              groupNames={groupNames}
              formatTid={formatTid}
              repfulAgreeTidsByGroup={repfulAgreeTidsByGroup}
              renderHeading={renderHeading}
              voteColors={voteColors}
              handleClick={handleCommentClick}
              points={commentsPoints}
              xx={xx}
              yy={yy}
              xCenter={xCenter}
              yCenter={yCenter}
              xScaleup={commentScaleupFactorX}
              yScaleup={commentScaleupFactorY}
            />
          ) : null}
        </svg>
      </div>
    );
}

export default CommentsGraph;
