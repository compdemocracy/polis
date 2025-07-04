import React, { useState, useEffect } from "react";
import net from "../../util/net";
import { useReportId } from "../framework/useReportId";

const TopicPrioritizeSimple = ({ conversation }) => {
  const { report_id } = useReportId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topicData, setTopicData] = useState(null);
  const [selectedTopics, setSelectedTopics] = useState(new Set());

  useEffect(() => {
    if (!report_id) return;

    setLoading(true);
    // Fetch topic data from Delphi endpoint
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("TopicMod topics response:", response);

        if (response && response.status === "success") {
          if (response.runs && Object.keys(response.runs).length > 0) {
            setTopicData(response);
          } else {
            setError("No LLM topic data available yet. Run Delphi analysis first.");
          }
        } else {
          setError("Failed to retrieve topic data");
        }

        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching topic data:", err);
        setError("Failed to connect to the topicMod endpoint");
        setLoading(false);
      });
  }, [report_id]);

  const toggleTopicSelection = (topicKey) => {
    const newSelected = new Set(selectedTopics);
    if (newSelected.has(topicKey)) {
      newSelected.delete(topicKey);
    } else {
      newSelected.add(topicKey);
    }
    setSelectedTopics(newSelected);
  };

  const renderTopicSelection = () => {
    if (!topicData || !topicData.runs) {
      return <div className="no-data">No topic data available</div>;
    }

    const runKeys = Object.keys(topicData.runs);
    const firstRun = topicData.runs[runKeys[0]];
    
    if (!firstRun.topics_by_layer || !firstRun.topics_by_layer[3]) {
      return <div className="no-data">No topics found for the coarsest layer</div>;
    }

    const coarsestTopics = firstRun.topics_by_layer[3];
    const topicEntries = Object.entries(coarsestTopics);
    
    return (
      <div className="topic-selection">
        <div className="header">
          <p className="subtitle">
            Which should rank higher in priority? Help set the agenda for you and for everyone: ({selectedTopics.size} selected)
          </p>
        </div>
        
        <div className="topics-list">
          {topicEntries.map(([clusterId, topic]) => {
            const topicKey = topic.topic_key;
            const isSelected = selectedTopics.has(topicKey);
            
            // Clean topic name
            let displayName = topic.topic_name;
            const layerClusterPrefix = `3_${clusterId}`;
            if (displayName && displayName.startsWith(layerClusterPrefix)) {
              displayName = displayName.substring(layerClusterPrefix.length).replace(/^:\s*/, '');
            }
            
            return (
              <label 
                key={topicKey} 
                className={`topic-item ${isSelected ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleTopicSelection(topicKey)}
                  className="topic-checkbox"
                />
                <div className="topic-content">
                  <span className="topic-id">3_{clusterId}</span>
                  <span className="topic-text">{displayName || `Topic ${clusterId}`}</span>
                </div>
              </label>
            );
          })}
        </div>

        {selectedTopics.size > 0 && (
          <div className="selected-summary">
            <h3>Selected Topics</h3>
            <div className="selected-list">
              {Array.from(selectedTopics).map(topicKey => {
                const [clusterId, topic] = Object.entries(coarsestTopics).find(
                  ([_, t]) => t.topic_key === topicKey
                ) || [];
                
                if (!topic) return null;
                
                let displayName = topic.topic_name;
                const layerClusterPrefix = `3_${clusterId}`;
                if (displayName && displayName.startsWith(layerClusterPrefix)) {
                  displayName = displayName.substring(layerClusterPrefix.length).replace(/^:\s*/, '');
                }
                
                return (
                  <div key={topicKey} className="selected-item">
                    <span className="selected-id">3_{clusterId}</span>
                    <span className="selected-text">{displayName}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="topic-prioritize-simple">
        <div className="loading">Loading topic data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="topic-prioritize-simple">
        <div className="error-message">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="topic-prioritize-simple">
      {renderTopicSelection()}

      <style jsx>{`
        .topic-prioritize-simple {
          padding: 20px;
          max-width: 800px;
          margin: 0 auto;
          background: #f8f9fa;
          min-height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .header {
          text-align: center;
          margin-bottom: 30px;
        }

        .header h1 {
          margin: 0 0 10px 0;
          color: #333;
          font-size: 2rem;
        }

        .subtitle {
          color: #666;
          font-size: 1.1rem;
          margin: 0;
        }

        .topics-list {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4px;
          margin-bottom: 20px;
        }

        .topic-item {
          display: flex;
          align-items: center;
          background: white;
          border: 1px solid #e9ecef;
          padding: 8px 12px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .topic-item:hover {
          border-color: #adb5bd;
          background: #f8f9fa;
        }

        .topic-item.selected {
          border-color: #6c757d;
          background: #f8f9fa;
        }

        .topic-checkbox {
          margin-right: 8px;
          transform: scale(1.1);
        }

        .topic-content {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
        }

        .topic-id {
          color: #6c757d;
          font-size: 0.9rem;
          font-weight: 600;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
          min-width: 40px;
        }

        .topic-text {
          color: #212529;
          font-size: 0.95rem;
          line-height: 1.3;
          font-weight: 500;
        }

        .selected-summary {
          background: white;
          border-radius: 8px;
          padding: 20px;
          border: 1px solid #e9ecef;
        }

        .selected-summary h3 {
          margin: 0 0 15px 0;
          color: #333;
          font-size: 1.3rem;
        }

        .selected-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .selected-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          background: #f8f9fa;
          border-radius: 4px;
        }

        .selected-id {
          color: #6c757d;
          font-size: 0.8rem;
          font-weight: 600;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
          min-width: 35px;
        }

        .selected-text {
          color: #495057;
          font-size: 0.95rem;
          font-weight: 500;
        }

        .loading, .error-message {
          text-align: center;
          padding: 40px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .error-message {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
        }

        .loading {
          font-size: 1.1rem;
          color: #666;
        }

        .no-data {
          text-align: center;
          padding: 40px;
          color: #666;
          font-style: italic;
        }

        /* Mobile responsiveness */
        @media (max-width: 768px) {
          .topic-prioritize-simple {
            padding: 15px;
          }
          
          .header h1 {
            font-size: 1.6rem;
          }
          
          .subtitle {
            font-size: 1rem;
          }
          
          .topic-item {
            padding: 12px;
          }
          
          .topic-text {
            font-size: 1rem;
          }
        }
      `}</style>
    </div>
  );
};

export default TopicPrioritizeSimple;