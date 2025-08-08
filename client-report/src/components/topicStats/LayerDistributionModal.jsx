import React, { useState, useEffect } from 'react';

const LayerDistributionModal = ({ 
  isOpen, 
  onClose, 
  layerName,
  layerId,
  topics,
  statsData,
  math,
  comments
}) => {
  const [plotData, setPlotData] = useState(null);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !topics || !statsData || !math || !comments) return;
    
    // Use normalized consensus if available, fall back to raw
    const consensusData = math["group-consensus-normalized"] || math["group-aware-consensus"];
    if (!consensusData) return;

    // Prepare data for boxplot
    const traces = [];
    
    Object.entries(topics).forEach(([clusterId, topic]) => {
      const stats = statsData[topic.topic_key];
      if (!stats || !stats.comment_tids) return;
      
      // Get group consensus values for comments in this topic
      const consensusValues = [];
      const commentsData = [];
      
      stats.comment_tids.forEach(tid => {
        const consensus = consensusData[tid];
        if (consensus !== undefined) {
          // Find the comment to check vote count
          const comment = comments?.find(c => c.tid === tid);
          const totalVotes = comment ? 
            (comment.agree_count || 0) + (comment.disagree_count || 0) + (comment.pass_count || 0) : 0;
          
          // Only include comments with at least 5 votes for meaningful distribution
          // Comments with very few votes default to 0.333 consensus
          if (totalVotes >= 5) {
            consensusValues.push(consensus);
            commentsData.push({ tid, consensus, votes: totalVotes });
          }
        }
      });
      
      if (consensusValues.length > 0) {
        traces.push({
          y: consensusValues,
          type: 'box',
          name: topic.topic_name,
          boxpoints: 'outliers',
          marker: {
            color: 'rgba(100, 100, 100, 0.6)',
            outliercolor: 'rgba(150, 150, 150, 0.8)'
          },
          line: {
            color: 'rgba(80, 80, 80, 1)'
          }
        });
      }
    });
    
    setPlotData(traces);
  }, [isOpen, topics, statsData, math, comments]);

  useEffect(() => {
    if (plotData && plotData.length > 0) {
      const layout = {
        title: '',
        yaxis: {
          title: 'Group-Aware Consensus',
          range: [0, 1],
          zeroline: false
        },
        xaxis: {
          title: 'Topics',
          tickangle: -45
        },
        showlegend: false,
        margin: {
          l: 80,
          r: 40,
          t: 40,
          b: 250
        },
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: 'rgba(0,0,0,0)'
      };
      
      const config = {
        responsive: true,
        displayModeBar: false
      };
      
      window.Plotly.newPlot('layer-distribution-plot', plotData, layout, config);
    }
  }, [plotData]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}
    onClick={onClose}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        maxWidth: '95vw',
        maxHeight: '95vh',
        width: '1600px',
        height: '900px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
      onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          padding: '20px',
          borderBottom: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <h2 style={{ margin: 0 }}>{layerName} - Consensus Distribution</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              padding: '5px'
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '20px'
        }}>
          <p style={{ marginBottom: '20px', color: '#666', fontSize: '14px' }}>
            Box plots showing the distribution of group-aware consensus values for comments with at least 5 votes within each topic. 
            The box shows the quartiles, the line inside is the median, and outliers are shown as individual points.
            Comments with fewer than 5 votes are excluded as they default to 0.333 consensus.
          </p>
          
          {plotData && plotData.length > 0 ? (
            <div id="layer-distribution-plot" style={{ width: '100%', height: '700px' }}></div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
              No data to display
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LayerDistributionModal;