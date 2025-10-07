// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import * as globals from "../globals";

const BarChartCompact = ({ comment, voteCounts, nMembers, voteColors }) => {
  if (!comment) return null;

  // Early validation for essential data
  const safeNMembers = typeof nMembers === 'number' && nMembers > 0 ? nMembers : 0;
  const hasValidVoteCounts = voteCounts && 
    typeof voteCounts.A === 'number' && 
    typeof voteCounts.D === 'number' && 
    typeof voteCounts.S === 'number';

  let w = 100;
  let agrees = 0;
  let disagrees = 0;
  let sawTheComment = 0;
  let missingCounts = false;

  if (hasValidVoteCounts) {
    agrees = Math.max(0, voteCounts.A || 0);
    disagrees = Math.max(0, voteCounts.D || 0);
    sawTheComment = Math.max(0, voteCounts.S || 0);
  } else {
    missingCounts = true;
  }

  // If we have missing counts or invalid data, show simplified view
  if (missingCounts || safeNMembers === 0 || sawTheComment === 0) {
    return (
      <div>
        <svg width={101} height={10} style={{ marginRight: 30 }}>
          <g>
            <rect x={0} width={w + 0.5} height={10} fill={"#f5f5f5"} stroke={"rgb(200,200,200)"} />
          </g>
        </svg>
        <div>
          <span style={{ fontSize: 12, marginRight: 4, color: "grey" }}>
            {missingCounts ? "Missing vote counts" : "No votes yet"}
          </span>
        </div>
      </div>
    );
  }

  let passes = Math.max(0, sawTheComment - (agrees + disagrees));

  // Safe division with fallbacks
  const agree = safeNMembers > 0 ? (agrees / safeNMembers) * w : 0;
  const disagree = safeNMembers > 0 ? (disagrees / safeNMembers) * w : 0;
  const pass = safeNMembers > 0 ? (passes / safeNMembers) * w : 0;

  const agreeSaw = sawTheComment > 0 ? (agrees / sawTheComment) * w : 0;
  const disagreeSaw = sawTheComment > 0 ? (disagrees / sawTheComment) * w : 0;
  const passSaw = sawTheComment > 0 ? (passes / sawTheComment) * w : 0;

  // Ensure percentages are valid numbers
  const agreeString = (isNaN(agreeSaw) ? 0 : Math.floor(agreeSaw)) + "%";
  const disagreeString = (isNaN(disagreeSaw) ? 0 : Math.floor(disagreeSaw)) + "%";
  const passString = (isNaN(passSaw) ? 0 : Math.floor(passSaw)) + "%";

  return (
    <div
      title={
        agreeString +
        " Agreed\n" +
        disagreeString +
        " Disagreed\n" +
        passString +
        " Passed\n" +
        sawTheComment +
        " Respondents"
      }
    >
      <svg width={101} height={10} style={{ marginRight: 30 }}>
        <g>
          <rect x={0} width={w + 0.5} height={10} fill={"white"} stroke={"rgb(180,180,180)"} />
          <rect 
            x={Math.max(0, 0.5 + (agree || 0) + (disagree || 0))} 
            width={Math.max(0, pass || 0)} 
            y={0.5} 
            height={9} 
            fill={voteColors.pass} 
          />
          <rect 
            x={0.5} 
            width={Math.max(0, agree || 0)} 
            y={0.5} 
            height={9} 
            fill={voteColors.agree} 
          />
          <rect 
            x={Math.max(0, 0.5 + (agree || 0))} 
            width={Math.max(0, disagree || 0)} 
            y={0.5} 
            height={9} 
            fill={voteColors.disagree} 
          />
        </g>
      </svg>
      <div>
        {missingCounts ? (
          <span style={{ fontSize: 12, marginRight: 4, color: "grey" }}>Missing vote counts</span>
        ) : (
          <span>
            <span style={{ fontSize: 12, marginRight: 4, color: voteColors.agree }}>
              {agreeString}
            </span>
            <span style={{ fontSize: 12, marginRight: 4, color: voteColors.disagree }}>
              {disagreeString}
            </span>
            <span style={{ fontSize: 12, marginRight: 4, color: "#999" }}>{passString}</span>
            <span style={{ fontSize: 12, color: "grey" }}>({sawTheComment})</span>
          </span>
        )}
      </div>
    </div>
  );
};

const CommentRow = ({ comment, groups, voteColors }) => {
  if (!comment) {
    return null;
  }

  const safeGroups = groups || {};
  let BarCharts = [];
  let totalMembers = 0;

  // groups
  Object.entries(safeGroups).forEach(([key, g]) => {
    const i = parseInt(key, 10); // Parse the key to an integer
    
    // Add safety checks for group data
    if (!g || typeof g["n-members"] !== 'number') {
      return; // Skip this group if it's invalid
    }
    
    const nMembers = g["n-members"];
    totalMembers += nMembers;
    
    // Safely access votes data
    const gVotes = g.votes && g.votes[comment.tid] ? g.votes[comment.tid] : undefined;
  
    BarCharts.push(
      <BarChartCompact
        key={i}
        index={i}
        comment={comment}
        voteCounts={gVotes}
        nMembers={nMembers}
        voteColors={voteColors}
      />
    );
  });

  // Add overall totals bar chart with safe data
  BarCharts.unshift(
    <BarChartCompact
      key={99}
      index={99}
      comment={comment}
      voteCounts={{
        A: typeof comment.agreed === 'number' ? comment.agreed : 0,
        D: typeof comment.disagreed === 'number' ? comment.disagreed : 0,
        S: typeof comment.saw === 'number' ? comment.saw : 0,
      }}
      nMembers={totalMembers}
      voteColors={voteColors}
    />
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "6px 0px",
        borderBottom: "1px solid rgb(220,220,220)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          width: 20,
          marginRight: 10,
        }}
      >
        {comment.tid}
      </span>

      <span
        style={{
          fontSize: 12,
          minWidth: 200,
          width: 200,
          marginRight: 50,
          flexShrink: 0,
          whiteSpace: "normal",
          wordBreak: "break-word",
        }}
      >
        {comment.txt}
      </span>
      {BarCharts}
    </div>
  );
};

const CommentList = ({ comments, math, ptptCount, tidsToRender, voteColors, style }) => {
  // Add safety checks for required data
  const safeComments = Array.isArray(comments) ? comments : [];
  const safeMath = math || {};
  const safePtptCount = typeof ptptCount === 'number' ? ptptCount : 0;
  const safeTidsToRender = Array.isArray(tidsToRender) ? tidsToRender : [];
  const safeGroupVotes = safeMath["group-votes"] || {};

  const getGroupLabels = () => {
    function makeLabel(key, label, numMembers) {
      return (
        <span
          key={key}
          style={{
            minWidth: 101,
            marginRight: 30,
            display: "inline-block",
            whiteSpace: "nowrap",
            fontWeight: 400,
            fontSize: 14,
            textTransform: "uppercase",
          }}
        >
          {label || `Group ${key}`}
          <span
            style={{
              marginLeft: 5,
            }}
          >
            {typeof numMembers === 'number' ? numMembers : 0}
          </span>
        </span>
      );
    }
    let labels = [];

    // totals
    labels.push(makeLabel(99, "Overall", safePtptCount));

    Object.entries(safeGroupVotes).forEach(([key, g]) => {
      const i = parseInt(key, 10);
      const groupLabel = globals.groupLabels && globals.groupLabels[i] ? globals.groupLabels[i] : `Group ${i}`;
      const memberCount = g && typeof g["n-members"] === 'number' ? g["n-members"] : 0;
      labels.push(makeLabel(i, groupLabel, memberCount));
    });

    return labels;
  }

  const cs = safeComments.reduce((acc, comment) => {
    if (comment && typeof comment.tid !== 'undefined') {
      acc[comment.tid] = comment;
    }
    return acc;
  }, {});

  return (
    <div style={style}>
      <div
        style={{
          marginBottom: 1,
          borderBottom: "2px solid black",
          position: "relative",
          display: "flex",
          alignItems: "baseline",
          whiteSpace: "nowrap",
          overflowX: "visible",
        }}
      >
        <span
          style={{
            minWidth: 200,
            marginRight:
              50 + 10 + 33 /* the 10 in padding from the cells, the 33 for offset group labels */,
            display: "inline-block",
            fontWeight: 700,
            fontSize: 14,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          Statement
        </span>

        {getGroupLabels()}
      </div>
      {safeTidsToRender.map((tid, i) => {
        const comment = cs[tid];
        if (!comment) {
          return null; // Skip rendering if comment doesn't exist
        }
        return (
          <CommentRow
            key={i}
            index={i}
            groups={safeGroupVotes}
            comment={comment}
            voteColors={voteColors}
          />
        );
      })}
    </div>
  );
}

export default CommentList;
