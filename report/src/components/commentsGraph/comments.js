// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import textWrap from 'svg-text-wrap';

class Comments extends React.Component {

  createComments() {

    console.log('in create comments, comments graph', this.props.points[0])

    // const _points = this.props.points.slice(0);
    //
    // var simulation = d3.forceSimulation(_points)
    //   .force("x", d3.forceX())
    //   .force("y", d3.forceY())
    //   .force("collide", d3.forceCollide().radius(function(d) { return 4; }))
    //   .stop()
    //
    //   for (let i = 0; i < 10; i++) {
    //     simulation.tick()
    //   }

    // console.log('simulation', _points[0])

    return this.props.points.map((comment, i) => {

      /* find the original comment */
      const _comment = _.find(this.props.comments, (c) => { return c.tid === comment.tid});

      /* see if it's meta or consensus */
      if (
        _comment.is_meta
        // this.props.math.pca["comment-extremity"][comment.tid] < globals.maxCommentExtremityToShow
      ) {
        return
      }

      /* break the text up into pieces */
      const textArray = textWrap(comment.txt, 200, {'letter-spacing': '1px'})

      return <text
          key={i}
          transform={
            `translate(
              ${this.props.xCenter + comment.x * this.props.xScaleup},
              ${this.props.yCenter + comment.y * this.props.yScaleup}
            )`
          }
          onClick={this.props.handleClick(comment)}
          style={{
            fill: "rgba(0,0,0,.5)",
            fontFamily: "Helvetica",
            cursor: "pointer",
            fontSize: 10,
          }}
          >
          <title>Tooltip 2</title>
          {this.props.formatTid(comment.tid)}
          {
            /*textArray.map((t, i) => {
              return (
                <TextSegment key={i} t={t} i={i}/>
              )
            })*/
          }
        </text>
    })
  }

  render () {
    return (
      <g>
        {this.createComments()}
      </g>
    );
  }
}

export default Comments;
