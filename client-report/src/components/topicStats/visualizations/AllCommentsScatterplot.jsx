import React from 'react';
import TopicScatterplot from '../../topicScatterplot/TopicScatterplot.jsx';

const AllCommentsScatterplot = ({ comments, math, voteColors }) => {
  if (!comments || !math) {
    return null;
  }
  
  // Use normalized consensus if available, fall back to raw
  const consensusData = math["group-consensus-normalized"] || math["group-aware-consensus"];
  if (!consensusData) {
    return null;
  }

  const data = (() => {
    const scatterData = [];
    let minConsensus = Infinity;
    let maxConsensus = -Infinity;
    
    comments.forEach(comment => {
      const groupConsensus = consensusData[comment.tid];
      if (groupConsensus !== undefined) {
        const totalVotes = (comment.agree_count || 0) + (comment.disagree_count || 0) + (comment.pass_count || 0);
        
        // Track min/max consensus for color scaling
        minConsensus = Math.min(minConsensus, groupConsensus);
        maxConsensus = Math.max(maxConsensus, groupConsensus);
        
        scatterData.push({
          topic_name: `Comment ${comment.tid}: ${comment.txt}`,
          consensus: groupConsensus,
          avg_votes_per_comment: totalVotes, // Using total votes for x-axis
          comment_count: 1, // Fixed size for all comments
          comment_id: comment.tid,
          full_text: comment.txt
        });
      }
    });
    
    // Fix edge case where no data
    if (minConsensus === Infinity) {
      minConsensus = 0;
      maxConsensus = 1;
    }
    
    // Add consensus extents to each item for color calculation
    return scatterData.map(d => ({ ...d, minConsensus, maxConsensus }));
  })();

  return (
    <div style={{ marginTop: 30, marginBottom: 40, padding: 20, backgroundColor: "#e8f4f8", borderRadius: 8 }}>
      <h3>All Comments: Group-Aware Consensus</h3>
      <p style={{ marginBottom: 15, fontSize: "0.9em", color: "#666" }}>
        <strong>Y-axis (Group-Aware Consensus):</strong> Measures agreement across different participant groups from PCA2. 
        Higher values indicate comments where groups tend to vote similarly (cross-group agreement).<br />
        <strong>X-axis:</strong> Total votes | <strong>Bubble size:</strong> Fixed (all comments equal)<br />
        <strong>Colors:</strong> <span style={{ color: voteColors?.agree || "#21a53a" }}>Green</span> = high group consensus, 
        <span style={{ color: voteColors?.disagree || "#e74c3c" }}> Red</span> = low group consensus
      </p>
      <TopicScatterplot
        data={data}
        config={{
          height: 600,
          bubbleOpacity: 0.6,
          xTransform: 'sqrt',
          yTransform: 'pow2',
          yAxisLabel: "Group-Aware Consensus",
          xAxisLabel: "Total Votes",
          useColorScale: true,
          colorScale: [[0, '#e74c3c'], [0.5, '#f1c40f'], [1, '#21a53a']],
          minBubbleSize: 8,
          maxBubbleSize: 8  // Fixed size for all comments
        }}
        onClick={(comment) => {
          console.log('Comment clicked:', comment);
        }}
      />
    </div>
  );
};

export default AllCommentsScatterplot;