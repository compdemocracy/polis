import React, { useState, useEffect } from "react";
import net from "../../util/net";
import CommentList from "../lists/commentList.jsx";
import { canGenerateCollectiveStatement, getTopicConsensusValues } from "../../util/consensusThreshold";

const CollectiveStatementModal = ({
  isOpen,
  onClose,
  topicName,
  topicKey,
  reportId,
  conversation,
  math,
  comments,
  ptptCount,
  formatTid,
  voteColors,
}) => {
  const [loading, setLoading] = useState(false);
  const [statementData, setStatementData] = useState(null);
  const [commentsData, setCommentsData] = useState(null);
  const [error, setError] = useState(null);
  const [statementMetadata, setStatementMetadata] = useState(null);

  useEffect(() => {
    if (isOpen && topicKey && reportId) {
      generateStatement();
    }
  }, [isOpen, topicKey, reportId]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const checkExistingStatements = async () => {
    try {
      const response = await net.polisGet("/api/v3/collectiveStatement", {
        report_id: reportId
      });
      
      if (response.status === "success" && response.statements && response.statements.length > 0) {
        // Find statements for this topic
        const topicStatements = response.statements.filter(stmt => 
          stmt.topic_key === topicKey
        );
        
        if (topicStatements.length > 0) {
          // Use the most recent statement
          const mostRecent = topicStatements.sort((a, b) => 
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          )[0];
          
          return mostRecent;
        }
      }
      return null;
    } catch (err) {
      console.log("Error checking existing statements:", err);
      return null;
    }
  };

  const generateStatement = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // First check if we have an existing statement
      const existingStatement = await checkExistingStatements();
      
      if (existingStatement) {
        console.log("Using existing collective statement from", existingStatement.created_at);
        setStatementData(existingStatement.statement_data);
        setCommentsData(existingStatement.comments_data);
        setStatementMetadata({
          created_at: existingStatement.created_at,
          model: existingStatement.model
        });
        setLoading(false);
        return;
      }

      // Only send group-aware consensus for comments in this topic
      const topicStats = await net.polisGet("/api/v3/topicStats", {
        report_id: reportId,
      });
      
      let topicCommentIds = [];
      if (topicStats.status === "success" && topicStats.stats[topicKey]) {
        topicCommentIds = topicStats.stats[topicKey].comment_tids || [];
      }
      
      // Check if this topic can generate a collective statement
      const statementCheck = canGenerateCollectiveStatement(topicCommentIds, math);
      
      if (!statementCheck.canGenerate) {
        setError(statementCheck.message);
        setLoading(false);
        return;
      }
      
      // Get only the qualifying comment IDs
      const qualifyingTids = statementCheck.details.map(comment => comment.tid);
      
      // Get the consensus values only for qualifying comments
      const relevantConsensus = {};
      const consensusData = math["group-consensus-normalized"] || math["group-aware-consensus"];
      qualifyingTids.forEach(tid => {
        if (consensusData[tid] !== undefined) {
          relevantConsensus[tid] = consensusData[tid];
        }
      });

      const response = await net.polisPost("/api/v3/collectiveStatement", {
        report_id: reportId,
        topic_key: topicKey,
        topic_name: topicName,
        group_consensus: relevantConsensus,
        qualifying_tids: qualifyingTids  // Send the list of qualifying comment IDs
      });

      if (response.status === "success") {
        console.log("Collective statement response:", response);
        setStatementData(response.statementData);
        setCommentsData(response.commentsData);
        setStatementMetadata({
          created_at: response.created_at,
          model: response.model
        });
      } else {
        setError(response.message || "Failed to generate statement");
      }
    } catch (err) {
      console.error("Error generating collective statement:", err);
      setError(err.message || "Failed to generate collective statement");
    } finally {
      setLoading(false);
    }
  };

  // Extract citation IDs from the statement data
  const extractCitations = (content) => {
    const citations = [];
    if (content && content.paragraphs) {
      content.paragraphs.forEach((paragraph) => {
        if (paragraph.sentences) {
          paragraph.sentences.forEach((sentence) => {
            if (sentence.clauses) {
              sentence.clauses.forEach((clause) => {
                if (clause.citations && Array.isArray(clause.citations)) {
                  citations.push(...clause.citations.filter((c) => typeof c === "number"));
                }
              });
            }
          });
        }
      });
    }
    return [...new Set(citations)]; // Remove duplicates
  };

  // Clear state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStatementData(null);
      setCommentsData(null);
      setError(null);
      setStatementMetadata(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: "8px",
          maxWidth: "95vw",
          width: "95vw",
          maxHeight: "95vh",
          height: "95vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{ 
            display: "flex",
            height: "100%",
            overflow: "hidden"
          }}
        >
          {/* Left sidebar with title */}
          <div 
            style={{ 
              width: "150px",
              padding: "20px 10px",
              borderRight: "2px solid #eee",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#f8f9fa",
              overflow: "hidden",
              flexShrink: 0
            }}
          >
            <div style={{ 
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "visible",
              maxHeight: "80vh"
            }}>
              <h2 style={{ margin: 0, marginBottom: "10px", fontSize: "1.4em" }}>{topicName}</h2>
              <p style={{ margin: 0, color: "#333", fontSize: "0.95em", fontWeight: "500" }}>Candidate Collective Statement</p>
              <p style={{ margin: 0, marginTop: "8px", color: "#666", fontSize: "0.85em", fontStyle: "italic" }}>Based on voting trends thus far</p>
            </div>
          </div>
          
          {/* Main content area */}
          <div style={{ 
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }}>

            {loading && (
              <div style={{ 
                display: "flex", 
                alignItems: "center", 
                justifyContent: "center", 
                height: "100%",
                flexDirection: "column"
              }}>
                <p>Generating candidate collective statement...</p>
                <p style={{ fontSize: "0.85em", color: "#666", marginTop: "10px" }}>
                  This may take a moment as we analyze voting patterns and comments.
                </p>
              </div>
            )}

            {error && (
              <div style={{ padding: "40px" }}>
                <div
                  style={{
                    padding: "20px",
                    backgroundColor: "#fee",
                    borderRadius: "4px",
                  }}
                >
                  <p style={{ margin: 0, color: "#c00" }}>Error: {error}</p>
                </div>
              </div>
            )}

            {!loading && !error && statementData && (
              <div
                style={{
                  display: "flex",
                  height: "100%",
                  overflow: "hidden",
                }}
              >
                {/* Left side: Collective Statement */}
                <div style={{ 
                  flex: "0 0 45%",
                  display: "flex",
                  flexDirection: "column",
                  borderRight: "1px solid #e0e0e0"
                }}>
                  <div style={{
                    flex: 1,
                    padding: "30px",
                    overflowY: "auto"
                  }}>
                    <div style={{ marginBottom: "20px" }}>
                      <h3 style={{ marginTop: 0, marginBottom: "5px", fontSize: "1.2em" }}>Candidate Collective Statement</h3>
                      {statementMetadata && (
                        <p style={{ margin: 0, fontSize: "0.85em", color: "#666" }}>
                          Generated {new Date(statementMetadata.created_at).toLocaleDateString()} at {new Date(statementMetadata.created_at).toLocaleTimeString()} 
                          {statementMetadata.model && ` (${statementMetadata.model.includes('claude') ? 'Claude Opus 4' : statementMetadata.model})`}
                        </p>
                      )}
                    </div>
                    <div
                      style={{
                        lineHeight: "1.8",
                        fontSize: "1.05em"
                      }}
                    >
                {statementData &&
                  statementData.paragraphs &&
                  statementData.paragraphs.map((paragraph, idx) => (
                    <div key={idx} style={{ marginBottom: "20px" }}>
                      <h4 style={{ marginTop: 0, marginBottom: "10px", color: "#333" }}>
                        {paragraph.title}
                      </h4>
                      {paragraph.sentences &&
                        paragraph.sentences.map((sentence, sIdx) => (
                          <p key={sIdx} style={{ marginBottom: "10px" }}>
                            {sentence.clauses &&
                              sentence.clauses.map((clause, cIdx) => (
                                <span key={cIdx}>
                                  {clause.text}
                                  {clause.citations && clause.citations.length > 0 && (
                                    <sup
                                      style={{
                                        color: "#007bff",
                                        fontSize: "0.8em",
                                        marginLeft: "2px",
                                      }}
                                    >
                                      [{clause.citations.join(", ")}]
                                    </sup>
                                  )}
                                  {cIdx < sentence.clauses.length - 1 && " "}
                                </span>
                              ))}
                          </p>
                        ))}
                    </div>
                  ))}
                    </div>
                  </div>
                  
                  {/* Footer note in left column */}
                  <div
                    style={{
                      padding: "20px 30px",
                      borderTop: "1px solid #e0e0e0",
                      backgroundColor: "#f8f9fa"
                    }}
                  >
                    <p style={{ margin: 0, fontSize: "0.85em", color: "#666", marginBottom: "15px" }}>
                      <strong>Note:</strong> This candidate collective statement was generated using AI based on the voting patterns and comments from all participants. It represents
                      areas of shared understanding and consensus on this topic.
                    </p>
                    <button
                      onClick={onClose}
                      style={{
                        padding: "10px 20px",
                        backgroundColor: "#007bff",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "1em",
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/* Right side: Cited Comments */}
                <div style={{ 
                  flex: "0 0 55%",
                  padding: "30px",
                  overflowY: "auto",
                  backgroundColor: "#fafafa"
                }}>
                  <h3 style={{ marginTop: 0, marginBottom: "20px", fontSize: "1.2em" }}>
                    Cited Comments
                  </h3>
                  {comments && comments.length > 0 && statementData ? (
                    <div>
                  <CommentList
                    conversation={conversation}
                    ptptCount={ptptCount}
                    math={math}
                    formatTid={formatTid}
                    tidsToRender={extractCitations(statementData)}
                    comments={comments}
                    voteColors={
                      voteColors || {
                        agree: "#21a53a",
                        disagree: "#e74c3c",
                        pass: "#b3b3b3",
                      }
                    }
                  />
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: "40px",
                        textAlign: "center",
                        color: "#999",
                        backgroundColor: "#fff",
                        borderRadius: "8px",
                      }}
                    >
                      No comments referenced
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CollectiveStatementModal;
