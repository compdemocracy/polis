import React, { useState } from 'react';
import { canGenerateCollectiveStatement, THRESHOLDS } from '../../../util/consensusThreshold';

const TopicTables = ({ latestRun, statsData, math, report_id, onTopicSelect, onScatterplot, onBeeswarm, onLayerDistribution, onViewTopic }) => {
  const [sortConfig, setSortConfig] = useState({ key: 'comment_count', direction: 'desc' });
  
  const handleSort = (key) => {
    setSortConfig(prevConfig => ({
      key,
      direction: prevConfig.key === key && prevConfig.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const layerEntries = Object.entries(latestRun.topics_by_layer || {});
  const totalLayers = layerEntries.length;
  
  return (
    <div>
      {/* Threshold explanation note */}
      <div style={{ 
        textAlign: 'right', 
        marginBottom: 20, 
        fontSize: '0.85em', 
        color: '#666',
        fontStyle: 'italic'
      }}>
        <span style={{ 
          display: 'inline-block',
          padding: '8px 12px',
          backgroundColor: '#f0f0f0',
          borderRadius: '4px',
          lineHeight: 1.4
        }}>
          Candidate collective statements require at least {THRESHOLDS.MIN_COMMENTS} comments with 
          ≥{(THRESHOLDS.MIN_CONSENSUS * 100)}% consensus and 
          ≥{(THRESHOLDS.MIN_GROUP_PARTICIPATION * 100)}% participation from every group
        </span>
      </div>
      
      {layerEntries
    .sort(([a], [b]) => parseInt(b) - parseInt(a)) // Sort layers in descending order
    .map(([layerId, topics]) => {
      const topicCount = Object.keys(topics).length;
      const layerNum = parseInt(layerId);
      
      // Dynamic layer naming based on position
      let layerName = "";
      let layerDescription = "";
      
      if (layerNum === 0) {
        layerName = "Finer Grained";
        layerDescription = "(Specific insights)";
      } else if (layerNum === totalLayers - 1) {
        layerName = "Coarse";
        layerDescription = "(Big picture themes)";
      } else {
        layerName = "Medium";
        layerDescription = "(Balanced overview)";
      }
      
      const layerLabel = `${layerName}: ${topicCount} Topics\n${layerDescription}`;
      
      return (
        <div key={layerId} style={{ marginTop: 30 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ whiteSpace: "pre-line", margin: 0 }}>{layerLabel}</h3>
            <button 
              style={{
                backgroundColor: "transparent",
                color: "#666",
                border: "1px solid #ccc",
                padding: "4px 8px",
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "0.85em"
              }}
              onClick={() => onLayerDistribution({ layerId, layerName, topics })}
              title="View distribution of consensus across topics"
            >
              Boxplots
            </button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #333" }}>
                <th style={{ padding: "10px", textAlign: "left", cursor: "pointer", userSelect: "none", width: "35%" }} 
                    onClick={() => handleSort('topic_name')}>
                  Topic {sortConfig.key === 'topic_name' && (sortConfig.direction === 'desc' ? '↓' : '↑')}
                </th>
                <th style={{ padding: "5px", textAlign: "right", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                    onClick={() => handleSort('comment_count')}>
                  Comments {sortConfig.key === 'comment_count' && (sortConfig.direction === 'desc' ? '↓' : '↑')}
                </th>
                <th style={{ padding: "5px", textAlign: "right", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                    onClick={() => handleSort('total_votes')}>
                  Total Votes {sortConfig.key === 'total_votes' && (sortConfig.direction === 'desc' ? '↓' : '↑')}
                </th>
                <th style={{ padding: "5px", textAlign: "right", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                    onClick={() => handleSort('vote_density')}>
                  Avg Votes/Comment {sortConfig.key === 'vote_density' && (sortConfig.direction === 'desc' ? '↓' : '↑')}
                </th>
                <th style={{ padding: "5px", textAlign: "right", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                    onClick={() => handleSort('group_consensus')}
                    title="Group-aware consensus from PCA2">
                  Group Consensus {sortConfig.key === 'group_consensus' && (sortConfig.direction === 'desc' ? '↓' : '↑')}
                </th>
                <th style={{ padding: "10px", textAlign: "center", whiteSpace: "nowrap" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(topics)
                .map(([clusterId, topic]) => {
                  const stats = statsData?.[topic.topic_key] || {};
                  
                  // Calculate average group consensus for this topic
                  let groupConsensus = null;
                  // Use normalized consensus if available, fall back to raw
                  const consensusData = math?.["group-consensus-normalized"] || math?.["group-aware-consensus"];
                  if (consensusData && stats.comment_tids) {
                    const consensusValues = stats.comment_tids
                      .map(tid => consensusData[tid])
                      .filter(val => val !== undefined);
                    
                    if (consensusValues.length > 0) {
                      groupConsensus = consensusValues.reduce((sum, val) => sum + val, 0) / consensusValues.length;
                    }
                  }
                  
                  // Check if this topic can generate a collective statement
                  const statementCheck = canGenerateCollectiveStatement(stats.comment_tids, math);
                  
                  return {
                    clusterId,
                    topic,
                    stats: { ...stats, group_consensus: groupConsensus },
                    statementCheck
                  };
                })
                .sort((a, b) => {
                  let aValue, bValue;
                  
                  switch (sortConfig.key) {
                    case 'topic_name':
                      aValue = a.topic.topic_name.toLowerCase();
                      bValue = b.topic.topic_name.toLowerCase();
                      break;
                    case 'comment_count':
                      aValue = a.stats.comment_count || 0;
                      bValue = b.stats.comment_count || 0;
                      break;
                    case 'total_votes':
                      aValue = a.stats.total_votes || 0;
                      bValue = b.stats.total_votes || 0;
                      break;
                    case 'vote_density':
                      aValue = a.stats.vote_density || 0;
                      bValue = b.stats.vote_density || 0;
                      break;
                    case 'group_consensus':
                      aValue = a.stats.group_consensus || 0;
                      bValue = b.stats.group_consensus || 0;
                      break;
                    default:
                      aValue = a.stats.comment_count || 0;
                      bValue = b.stats.comment_count || 0;
                  }
                  
                  if (sortConfig.direction === 'asc') {
                    return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
                  } else {
                    return aValue < bValue ? 1 : aValue > bValue ? -1 : 0;
                  }
                })
                .map(({ clusterId, topic, stats, statementCheck }) => (
                  <tr key={clusterId} style={{ borderBottom: "1px solid #ccc" }}>
                    <td style={{ padding: "10px" }}>
                      <a 
                        href={`/topicStats/${report_id}/${topic.topic_key.replace(/#/g, '%23')}`}
                        style={{
                          color: "#0066cc",
                          textDecoration: "none",
                          cursor: "pointer"
                        }}
                        onMouseEnter={(e) => e.target.style.textDecoration = "underline"}
                        onMouseLeave={(e) => e.target.style.textDecoration = "none"}
                      >
                        {topic.topic_name}
                      </a>
                    </td>
                    <td style={{ padding: "10px", textAlign: "right" }}>{stats.comment_count || 0}</td>
                    <td style={{ padding: "10px", textAlign: "right" }}>{stats.total_votes || 0}</td>
                    <td style={{ padding: "10px", textAlign: "right" }}>
                      {stats.vote_density !== undefined ? stats.vote_density.toFixed(1) : '-'}
                    </td>
                    <td style={{ padding: "10px", textAlign: "right" }}>
                      {stats.group_consensus !== null ? stats.group_consensus.toFixed(2) : '-'}
                    </td>
                    <td style={{ padding: "5px", textAlign: "center" }}>
                      <div style={{ display: 'flex', gap: '5px', justifyContent: 'center', alignItems: 'center' }}>
                        <button 
                          style={{
                            backgroundColor: statementCheck.canGenerate ? "#4CAF50" : "#f5f5f5",
                            color: statementCheck.canGenerate ? "white" : "#ccc",
                            border: statementCheck.canGenerate ? "1px solid #45a049" : "1px solid #ccc",
                            padding: "3px 6px",
                            borderRadius: "3px",
                            cursor: statementCheck.canGenerate ? "pointer" : "not-allowed",
                            fontSize: "0.8em",
                            whiteSpace: "nowrap",
                            fontWeight: statementCheck.canGenerate ? "500" : "normal"
                          }}
                          onClick={() => {
                            if (statementCheck.canGenerate) {
                              onTopicSelect({ name: topic.topic_name, key: topic.topic_key });
                            }
                          }}
                          title={statementCheck.canGenerate ? 
                            `Generate collective statement (${statementCheck.count} high-consensus comments)` : 
                            statementCheck.message
                          }
                        >
                          Collective Statement{statementCheck.canGenerate && ` (${statementCheck.count})`}
                        </button>
                        
                        <button 
                          style={{
                            backgroundColor: "transparent",
                            color: "#666",
                            border: "1px solid #ccc",
                            padding: "3px 6px",
                            borderRadius: "3px",
                            cursor: "pointer",
                            fontSize: "0.8em",
                            whiteSpace: "nowrap"
                          }}
                          onClick={() => onScatterplot({ name: topic.topic_name, key: topic.topic_key })}
                          title="View votes"
                        >
                          Votes
                        </button>
                        
                        <button 
                          style={{
                            backgroundColor: "transparent",
                            color: "#666",
                            border: "1px solid #ccc",
                            padding: "3px 6px",
                            borderRadius: "3px",
                            cursor: "pointer",
                            fontSize: "0.8em",
                            whiteSpace: "nowrap"
                          }}
                          onClick={() => onBeeswarm({ name: topic.topic_name, key: topic.topic_key })}
                          title="View beeswarm"
                        >
                          Beeswarm
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      );
    })}
    </div>
  );
};

export default TopicTables;