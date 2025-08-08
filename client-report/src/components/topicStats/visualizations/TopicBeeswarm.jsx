import React, { useState, useEffect, useRef } from 'react';
import _ from 'lodash';
import CommentList from '../../lists/commentList.jsx';

const VoronoiCells = ({ currentComment, voronoi, onHoverCallback, dataExtent }) => {
  const getFill = (cell) => {
    if (currentComment?.tid === cell.data.tid) {
      return "rgb(0,0,255)"; // Blue for selected
    } else {
      // Color based on group consensus value, normalized to data extent
      const consensus = cell.data.groupConsensus || 0;
      const [min, max] = dataExtent || [0, 1];
      const normalized = Math.max(0, Math.min(1, (consensus - min) / (max - min)));
      
      // Use a smooth gradient from red to yellow to green
      let r, g, b;
      
      if (normalized < 0.5) {
        // Red to Yellow (increase green)
        const ratio = normalized * 2;
        r = 231;
        g = Math.round(76 + (165 * ratio));
        b = 60;
      } else {
        // Yellow to Green (decrease red)
        const ratio = (normalized - 0.5) * 2;
        r = Math.round(231 * (1 - ratio));
        g = 231;
        b = 60;
      }
      
      return `rgb(${r},${g},${b})`;
    }
  }

  return (
    <g>
      {voronoi.map((cell, i) => {
        return (
          <g key={i} onMouseEnter={onHoverCallback(cell)}>
            <path fill="none" style={{pointerEvents: "all"}} d={"M" + cell.join("L") + "Z"}/>
            <circle
              r={4}
              fill={getFill(cell)}
              cx={cell.data.x}
              cy={cell.data.y}
            />
          </g>
        )
      })}
    </g>
  )
}

const TopicBeeswarm = ({ comments, commentTids, math, conversation, ptptCount, formatTid, voteColors }) => {
  const svgWidth = 1100; // Increased to fill modal width
  const svgHeight = 200;
  const margin = {top: 10, right: 40, bottom: 30, left: 40};
  const widthMinusMargins = svgWidth - margin.left - margin.right;
  const heightMinusMargins = svgHeight - margin.top - margin.bottom;

  const [currentComment, setCurrentComment] = useState(null);
  const [commentsWithConsensus, setCommentsWithConsensus] = useState(null);
  const [voronoi, setVoronoi] = useState(null);
  const [dataExtent, setDataExtent] = useState([0, 1]);
  const [filterLowVotes, setFilterLowVotes] = useState(true);
  const svgRef = useRef(null);

  const onHoverCallback = (d) => {
    return () => {
      setCurrentComment(d.data);
    }
  }

  const setup = () => {
    if (!comments || !commentTids || !math) return;
    
    // Use normalized consensus if available, fall back to raw consensus
    const consensusData = math["group-consensus-normalized"] || math["group-aware-consensus"];
    if (!consensusData) return;

    // Filter to only topic comments and add group consensus
    const commentsWithConsensusData = [];
    comments.forEach((comment) => {
      if (commentTids.includes(comment.tid)) {
        const totalVotes = (comment.agree_count || 0) + (comment.disagree_count || 0) + (comment.pass_count || 0);
        const groupConsensus = consensusData[comment.tid];
        // Apply vote filter - remove comments with 0 or 1 votes if filter is on
        const minVotes = filterLowVotes ? 2 : 0;
        if (groupConsensus !== undefined && totalVotes >= minVotes) {
          commentsWithConsensusData.push({
            ...comment,
            groupConsensus: groupConsensus,
            totalVotes: totalVotes
          });
        }
      }
    });

    if (commentsWithConsensusData.length === 0) return;

    // Always use fixed scale from 0 to 1
    setDataExtent([0, 1]);

    // Create x scale with fixed domain [0, 1]
    const x = window.d3.scaleLinear()
      .domain([0, 1])
      .rangeRound([0, widthMinusMargins]);

    // Run force simulation
    const simulation = window.d3.forceSimulation(commentsWithConsensusData)
      .force("x", window.d3.forceX(function(d) {
        return x(d.groupConsensus);
      }).strength(1))
      .force("y", window.d3.forceY(heightMinusMargins / 2))
      .force("collide", window.d3.forceCollide(5))
      .stop();

    // Run simulation
    for (let i = 0; i < 120; ++i) simulation.tick();

    // Create voronoi for hover detection
    const voronoiGenerator = window.d3.voronoi()
      .extent([[-margin.left, -margin.top], [widthMinusMargins + margin.right, heightMinusMargins + margin.top]])
      .x(function(d) { return d.x; })
      .y(function(d) { return d.y; });
    
    const voronoiPolygons = voronoiGenerator.polygons(commentsWithConsensusData);

    setCommentsWithConsensus(commentsWithConsensusData);
    setVoronoi(voronoiPolygons);

    // Don't add axis here - we'll add it once in the useEffect
  }

  useEffect(() => {
    setup();
  }, [comments, commentTids, math, filterLowVotes]);

  // Add axis in a separate effect after data is loaded
  useEffect(() => {
    if (svgRef.current && commentsWithConsensus && dataExtent) {
      const svg = window.d3.select(svgRef.current);
      
      // First remove ALL axes to prevent duplicates
      svg.selectAll(".x-axis").remove();
      svg.selectAll("g").selectAll(".x-axis").remove();
      
      const x = window.d3.scaleLinear()
        .domain(dataExtent)
        .rangeRound([0, widthMinusMargins]);
      
      // Ensure we're selecting the right group and only adding one axis
      const mainGroup = svg.select("g.main-group");
      if (!mainGroup.empty()) {
        mainGroup
          .append("g")
          .attr("class", "x-axis")
          .attr("transform", `translate(0, ${heightMinusMargins})`)
          .call(window.d3.axisBottom(x).ticks(5).tickFormat(d => d.toFixed(1)));
      }
    }
  }, [commentsWithConsensus, dataExtent, widthMinusMargins, heightMinusMargins]);

  if (!commentsWithConsensus || !voronoi) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
        <p>Loading visualization...</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      {/* Vote filter checkbox moved to the left */}
      <div style={{ marginBottom: '10px' }}>
        <label style={{ 
          fontSize: '12px',
          color: '#666',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center'
        }}>
          <input
            type="checkbox"
            checked={filterLowVotes}
            onChange={(e) => setFilterLowVotes(e.target.checked)}
            style={{ marginRight: '5px', marginTop: '0' }}
          />
          remove comments with 0 or 1 votes
        </label>
      </div>
      
      <svg ref={svgRef} width={svgWidth} height={svgHeight} style={{ display: 'block' }}>
        <g className="main-group" transform={`translate(${margin.left},${margin.top})`}>
          <VoronoiCells
            currentComment={currentComment}
            voronoi={voronoi}
            onHoverCallback={onHoverCallback}
            dataExtent={dataExtent}
          />
        </g>
      </svg>
      
      {/* Gradient legend as SVG */}
      <svg width={svgWidth} height={100} style={{ display: 'block' }}>
        <g transform={`translate(${margin.left},10)`}>
          {/* Gradient definition */}
          <defs>
            <linearGradient id="consensus-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#e74c3c" />
              <stop offset="50%" stopColor="#f1c40f" />
              <stop offset="100%" stopColor="#21a53a" />
            </linearGradient>
          </defs>
          
          {/* Labels above gradient */}
          {(() => {
            const steps = 6;
            const labels = [];
            for (let i = 0; i < steps; i++) {
              const value = dataExtent[0] + (dataExtent[1] - dataExtent[0]) * (i / (steps - 1));
              const x = (widthMinusMargins / (steps - 1)) * i;
              labels.push(
                <text key={i} x={x} y={0} fontSize="11" fill="#666" textAnchor="middle">
                  {value.toFixed(2)}
                </text>
              );
            }
            return labels;
          })()}
          
          {/* Gradient bar */}
          <rect
            x={0}
            y={10}
            width={widthMinusMargins}
            height={20}
            fill="url(#consensus-gradient)"
            rx={4}
          />
          
          {/* Text labels below gradient */}
          <text x={0} y={50} fontSize="12" fill="#666" textAnchor="start">
            All groups
          </text>
          <text x={0} y={65} fontSize="12" fill="#666" textAnchor="start">
            DISAGREE
          </text>
          
          <text x={widthMinusMargins / 2} y={50} fontSize="12" fill="#666" textAnchor="middle">
            Groups are split
          </text>
          <text x={widthMinusMargins / 2} y={65} fontSize="12" fill="#666" textAnchor="middle">
            (or low votes)
          </text>
          
          <text x={widthMinusMargins} y={50} fontSize="12" fill="#666" textAnchor="end">
            All groups
          </text>
          <text x={widthMinusMargins} y={65} fontSize="12" fill="#666" textAnchor="end">
            AGREE
          </text>
        </g>
      </svg>

      <div style={{
        marginTop: "20px",
        padding: "15px",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
        height: "140px",
        maxWidth: svgWidth + "px",
        boxSizing: "border-box",
        overflow: "auto"
      }}>
        {currentComment ? (
          <CommentList
            conversation={conversation}
            ptptCount={ptptCount}
            math={math}
            formatTid={formatTid}
            tidsToRender={[currentComment.tid]}
            comments={comments}
            voteColors={voteColors}
          />
        ) : (
          <div style={{ 
            height: "100%", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center",
            color: "#999",
            fontSize: "14px"
          }}>
            Hover over a circle to see comment details
          </div>
        )}
      </div>
    </div>
  );
}

export default TopicBeeswarm;