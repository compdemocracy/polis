// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState } from "react";

import _ from "lodash";
import * as globals from "../globals";

const leftOffset = 34;
const topOffset = 60;

const scale = d3.scaleLinear().domain([-1, 1]).range([0, 1]);

const square = 20;

const Matrix = ({ comments, tids, probabilities, title, error }) => {
  const [mouseOverRow, setMouseOverRow] = useState(null);
  const [mouseOverColumn, setMouseOverColumn] = useState(null);
  const [mouseOverCorrelation, setMouseOverCorrelation] = useState(null);
  
  const onMouseEnterCell = (row, column, correlation) => {
    setMouseOverRow(row);
    setMouseOverColumn(column);
    setMouseOverCorrelation(correlation);
  };

  const onMouseExitCell = (/*row, column*/) => {
    setMouseOverRow(null);
    setMouseOverColumn(null);
    setMouseOverCorrelation(null);
  }

  const makeRect = (comment, row, column) => {
    return (
      <g>
        <rect
          fill={d3.interpolatePuOr(scale(comment))}
          onMouseEnter={() => {
            return onMouseEnterCell(row, column, comment);
          }}
          width={square}
          height={square}
        />
        <text
          x={10}
          y={13}
          textAnchor={"middle"}
          fill={Math.abs(Math.floor(comment * 100)) > 30 ? "white" : "rgb(60,60,60)"}
          style={{
            fontFamily: globals.sans,
            fontSize: 10,
            pointerEvents: "none",
          }}
        >
          {Math.floor(comment * 100)}
        </text>
      </g>
    );
  }

  const makeColumn = (comments, row) => {
    return comments.map((comment, column) => {
      let markup = null;
      if (column < row) {
        /* diagonal matrix */
        markup = (
          <g key={column}>
            {/* this translate places the top text labels where they should go, rotated */}
            {/* this translate places the columns where they should go, and creates a gutter */}
            <g transform={"translate(" + column * square + ", 30)"}>
              {makeRect(comment, row, column)}
            </g>
          </g>
        );
      } else if (column === row) {
        const comment = comments.find(comment => {
          return comment.tid === tids[column];
        });
        markup = (
          <g key={column}>
            <text
              onMouseEnter={() => {
                return onMouseExitCell();
              }}
              onMouseLeave={() => {
                return onMouseExitCell();
              }}
              transform={"translate(" + (column * square + 10) + ", 46), rotate(315)"}
              fill={
                column === mouseOverColumn || column === mouseOverRow
                  ? "rgba(0,0,0,1)"
                  : "rgba(0,0,0,0.5)"
              }
              style={{
                fontFamily: "Helvetica, sans-serif",
                fontSize: 10,
                fontWeight: 400,
              }}
            >
              {comment ? comment.txt : "[[[none found]]]"}
            </text>
          </g>
        );
      }
      return markup;
    });
  }

  const makeRow = (comments, row) => {
    return (
      <g transform={"translate(0, " + (row * 20 + topOffset) + ")"}>
        {/* this translate moves just the colored squares over to make a gutter, not the text */}
        <g transform={"translate(" + leftOffset + ", -43)"}>{makeColumn(comments, row)}</g>
      </g>
    );
  }

  const renderMatrix = () => {
    let side = probabilities.length * square + 200;
    return (
      <div>
        <p style={globals.primaryHeading}>{title}</p>
        <p style={globals.paragraph}>
          What is the chance that a participant who agreed (or disagreed) with a given comment also
          agreed (or disagreed) with another given comment?
        </p>
        <p style={globals.paragraph}>
          Patterns emerge when we evaluate groups of statements that tended to be voted on
          similarly.
        </p>
        <p style={globals.paragraph}>
          This is an important bit of math (called a correlation matrix) that goes into making the
          graph above.
        </p>

        <svg width="100%" height={side} style={{ cursor: "crosshair" }}>
          <rect
            fill="rgba(0,0,0,0)"
            onMouseEnter={() => {
              return onMouseExitCell();
            }}
            onMouseLeave={() => {
              return onMouseExitCell();
            }}
            width={side}
            height={side}
          />

          {!mouseOverCorrelation ? (
            " "
          ) : (
            <text
              x={300}
              y={40}
              textAnchor={"middle"}
              fill={d3.interpolatePuOr(scale(mouseOverCorrelation))}
              style={{
                fontFamily: globals.sans,
                fontSize: 18,
              }}
            >
              {`${
                Math.round(mouseOverCorrelation * 1000) / 10
              }% chance of casting the same vote on these two statements`}
            </text>
          )}

          <g transform={"translate(200,0), rotate(45)" /* abstract translate magic number */}>
            {probabilities.map((comments, row) => {
              return <g key={row}>{makeRow(comments, row)}</g>;
            })}
          </g>
        </svg>
      </div>
    );
  };

  const renderError = (err) => {
    return (
      <div>
        <div> error loading matrix </div>
        <div>{err}</div>
      </div>
    );
  }

  const renderLoading = () => {
    return <div>loading matrix... (may take up to a minute)</div>;
  }


  if (error) {
    return renderError();
  } else if (probabilities) {
    return renderMatrix();
  } else {
    return renderLoading();
  }
}

export default Matrix;

// This is a matrix showing every comment by every comment (all comments are shown, in order of being submitted, on each axis). Each square represents the likihood that if someone agreed with one comment, they would agree with the other. For instance, [n%] of people who agreed with comment [n] also agreed with comment [m].
