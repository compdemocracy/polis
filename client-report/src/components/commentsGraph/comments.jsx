// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";

const Comments = ({
  points,
  formatTid,
  handleClick,
  comments,
  xCenter,
  xScaleup,
  yCenter,
  yScaleup,
}) => {
  const createComments = () => {
    return points.map((comment, i) => {
      const _comment = comments.find(c => c.tid === comment.tid);

      /* see if it's meta or consensus */
      if (
        _comment.is_meta
      ) {
        return;
      }

      return (
        <text
          key={i}
          transform={`translate(
              ${xCenter + comment.x * xScaleup},
              ${yCenter + comment.y * yScaleup}
            )`}
          onClick={handleClick(comment)}
          style={{
            fill: "rgba(0,0,0,.5)",
            fontFamily: "Helvetica",
            cursor: "pointer",
            fontSize: 10,
          }}
        >
          <title>Tooltip 2</title>
          {formatTid(comment.tid)}
        </text>
      );
    });
  }


  return <g>{createComments()}</g>;
}

export default Comments;
