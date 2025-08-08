import React, { useState, useEffect } from "react";
import net from "../../util/net";
import Heading from "../framework/heading.jsx";
import Footer from "../framework/Footer.jsx";
import TopicBeeswarm from "../topicStats/visualizations/TopicBeeswarm.jsx";
import AllCommentsScatterplot from "../topicStats/visualizations/AllCommentsScatterplot.jsx";
import CommentList from "../lists/commentList.jsx";
import * as globals from "../globals";
import { canGenerateCollectiveStatement, getTopicConsensusValues } from "../../util/consensusThreshold";

const TopicPage = ({ conversation, report_id, topic_key, math, comments, ptptCount, formatTid, voteColors, onBack }) => {
  const [loading, setLoading] = useState(true);
  const [topicData, setTopicData] = useState(null);
  const [topicStats, setTopicStats] = useState(null);
  const [collectiveStatement, setCollectiveStatement] = useState(null);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [statementGenerated, setStatementGenerated] = useState(false);
  const [statementMetadata, setStatementMetadata] = useState(null);
  const [topicComments, setTopicComments] = useState([]);
  const [sortedComments, setSortedComments] = useState([]);
  const [topicNarrative, setTopicNarrative] = useState(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  useEffect(() => {
    const fetchTopicData = async () => {
      try {
        setLoading(true);
        // Reset collective statement when topic changes
        setCollectiveStatement(null);
        setStatementGenerated(false);
        
        // Fetch topic data from Delphi endpoint
        const topicsResponse = await net.polisGet("/api/v3/delphi", {
          report_id: report_id,
        });
        
        // Fetch topic statistics
        const statsResponse = await net.polisGet("/api/v3/topicStats", {
          report_id: report_id,
        });
        
        if (topicsResponse.status === "success" && statsResponse.status === "success") {
          // Find the topic data
          const latestRunKey = Object.keys(topicsResponse.runs).sort().reverse()[0];
          const latestRun = topicsResponse.runs[latestRunKey];
          let foundTopic = null;
          
          Object.entries(latestRun.topics_by_layer || {}).forEach(([layerId, topics]) => {
            Object.entries(topics).forEach(([clusterId, topic]) => {
              if (topic.topic_key === topic_key) {
                foundTopic = { ...topic, layerId };
              }
            });
          });
          
          if (foundTopic && statsResponse.stats[topic_key]) {
            setTopicData(foundTopic);
            
            // Calculate metrics client-side
            const stats = statsResponse.stats[topic_key];
            const commentTids = stats.comment_tids || [];
            const topicCommentsData = comments.filter(c => commentTids.includes(c.tid));
            
            // Calculate metrics
            let totalVotes = 0;
            let totalAgree = 0;
            let totalDisagree = 0;
            let totalPass = 0;
            
            topicCommentsData.forEach(comment => {
              const agreeCount = comment.agree_count || 0;
              const disagreeCount = comment.disagree_count || 0;
              const passCount = comment.pass_count || 0;
              
              totalVotes += agreeCount + disagreeCount + passCount;
              totalAgree += agreeCount;
              totalDisagree += disagreeCount;
              totalPass += passCount;
            });
            
            const enrichedStats = {
              ...stats,
              comment_count: commentTids.length,
              total_votes: totalVotes,
              agree_votes: totalAgree,
              disagree_votes: totalDisagree,
              pass_votes: totalPass,
              vote_density: commentTids.length > 0 ? totalVotes / commentTids.length : 0
            };
            
            setTopicStats(enrichedStats);
            setTopicComments(topicCommentsData);
            
            // Sort by group consensus
            const consensusData = math?.["group-consensus-normalized"] || math?.["group-aware-consensus"];
            if (consensusData) {
              const sorted = topicCommentsData
                .map(comment => ({
                  ...comment,
                  groupConsensus: consensusData[comment.tid] || 0
                }))
                .sort((a, b) => b.groupConsensus - a.groupConsensus);
              setSortedComments(sorted);
            }
          }
        }
        
        setLoading(false);
      } catch (err) {
        console.error("Error fetching topic data:", err);
        setLoading(false);
      }
    };

    if (report_id && topic_key && comments && math) {
      fetchTopicData();
    }
  }, [report_id, topic_key, comments, math]);

  const checkExistingStatements = async () => {
    try {
      const response = await net.polisGet("/api/v3/collectiveStatement", {
        report_id: report_id
      });
      
      if (response.status === "success" && response.statements && response.statements.length > 0) {
        // Find statements for this topic
        const topicStatements = response.statements.filter(stmt => 
          stmt.topic_key === topic_key
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

  const generateCollectiveStatement = async () => {
    if (loadingStatement || statementGenerated) return;
    
    try {
      setLoadingStatement(true);
      
      // First check if we have an existing statement
      const existingStatement = await checkExistingStatements();
      
      if (existingStatement) {
        console.log("Using existing collective statement from", existingStatement.created_at);
        setCollectiveStatement(existingStatement.statement_data);
        setStatementGenerated(true);
        setStatementMetadata({
          created_at: existingStatement.created_at,
          model: existingStatement.model
        });
        setLoadingStatement(false);
        return;
      }
      
      // Check if this topic can generate a collective statement
      const statementCheck = canGenerateCollectiveStatement(topicStats.comment_tids, math);
      
      if (!statementCheck.canGenerate) {
        console.log(`Skipping collective statement generation: ${statementCheck.message}`);
        setLoadingStatement(false);
        setCollectiveStatement({
          insufficient: true,
          message: statementCheck.message
        });
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
      
      console.log("Generating collective statement with:", {
        report_id: report_id,
        topic_key: topic_key,
        topic_name: topicData?.topic_name,
        qualifyingCount: qualifyingTids.length,
        qualifyingTids: qualifyingTids
      });
      
      const response = await net.polisPost("/api/v3/collectiveStatement", {
        report_id: report_id,
        topic_key: topic_key,
        topic_name: topicData?.topic_name || "",
        group_consensus: relevantConsensus,
        qualifying_tids: qualifyingTids  // Send the list of qualifying comment IDs
      });
      
      console.log("Collective statement response:", response);
      
      if (response.status === "success" && response.statementData) {
        setCollectiveStatement(response.statementData);
        setStatementGenerated(true);
        setStatementMetadata({
          created_at: response.created_at,
          model: response.model
        });
      } else if (response.statement) {
        setCollectiveStatement(response.statement);
        setStatementGenerated(true);
      } else {
        console.error("Unexpected response format:", response);
        setCollectiveStatement({ 
          error: true, 
          message: "Received unexpected response format" 
        });
      }
    } catch (err) {
      console.error("Error generating collective statement:", err);
      // Show user-friendly error message
      setCollectiveStatement({ 
        error: true, 
        message: "Unable to generate candidate collective statement. Please try again later." 
      });
    } finally {
      setLoadingStatement(false);
    }
  };

  // Fetch narrative report if it exists
  const fetchNarrativeReport = async () => {
    if (!topic_key || narrativeLoading) return;
    
    try {
      setNarrativeLoading(true);
      const response = await net.polisGet("/api/v3/delphi/reports", {
        report_id: report_id,
        section: topic_key
      });
      
      if (response && response.status === "success" && response.reports) {
        const sectionData = response.reports[topic_key];
        if (sectionData && sectionData.report_data) {
          const reportData = typeof sectionData.report_data === 'string' 
            ? JSON.parse(sectionData.report_data) 
            : sectionData.report_data;
          setTopicNarrative(reportData);
        }
      }
    } catch (err) {
      console.error("Error fetching narrative report:", err);
    } finally {
      setNarrativeLoading(false);
    }
  };

  useEffect(() => {
    if (topic_key && report_id) {
      fetchNarrativeReport();
    }
  }, [topic_key, report_id]);

  // Auto-generate collective statement when topic data is loaded
  useEffect(() => {
    if (topicStats && topicData && math && !collectiveStatement && !loadingStatement) {
      generateCollectiveStatement();
    }
  }, [topicStats, topicData, math]);

  if (loading) {
    return (
      <div style={{ maxWidth: "1400px", margin: "0 auto", padding: "20px" }}>
        <Heading conversation={conversation} />
        <div style={{ marginTop: 40, textAlign: "center" }}>
          <p>Loading topic data...</p>
        </div>
      </div>
    );
  }

  if (!topicData || !topicStats) {
    return (
      <div style={{ maxWidth: "1400px", margin: "0 auto", padding: "20px" }}>
        <Heading conversation={conversation} />
        <div style={{ marginTop: 40, textAlign: "center" }}>
          <p>Topic not found</p>
          <button onClick={onBack} style={{ marginTop: 20 }}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "1400px", margin: "0 auto", padding: "20px" }}>
      <Heading conversation={conversation} />
      
      <div style={{ marginTop: 40 }}>
        <button 
          onClick={() => window.location.href = `/topicStats/${report_id}`}
          style={{
            background: "none",
            border: "none",
            fontSize: "16px",
            cursor: "pointer",
            marginBottom: 20,
            color: "#0066cc"
          }}
        >
          ← Back to Topics
        </button>
        
        <p style={globals.primaryHeading}>{topicData.topic_name}</p>
        
        {/* Key Statistics */}
        <section style={{ 
          maxWidth: 1200, 
          marginTop: 30,
          marginBottom: 40
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "2rem" }}>
            <div style={{ flex: 1, minWidth: "200px", textAlign: "center"}}>
              <p style={{ 
                fontSize: "13px", 
                textTransform: "uppercase", 
                letterSpacing: "1px", 
                color: "#666",
                marginBottom: "8px"
              }}>Comments</p>
              <p style={{ 
                fontFamily: "Georgia, serif", 
                fontSize: "3rem", 
                margin: 0,
                fontWeight: "normal"
              }}>{topicStats.comment_count}</p>
            </div>
            <div style={{ flex: 1, minWidth: "200px", textAlign: "center"}}>
              <p style={{ 
                fontSize: "13px", 
                textTransform: "uppercase", 
                letterSpacing: "1px", 
                color: "#666",
                marginBottom: "8px"
              }}>Total Votes</p>
              <p style={{ 
                fontFamily: "Georgia, serif", 
                fontSize: "3rem", 
                margin: 0,
                fontWeight: "normal"
              }}>{topicStats.total_votes.toLocaleString()}</p>
            </div>
            <div style={{ flex: 1, minWidth: "200px", textAlign: "center"}}>
              <p style={{ 
                fontSize: "13px", 
                textTransform: "uppercase", 
                letterSpacing: "1px", 
                color: "#666",
                marginBottom: "8px"
              }}>Total Agree Votes</p>
              <p style={{ 
                fontFamily: "Georgia, serif", 
                fontSize: "3rem", 
                margin: 0, 
                color: voteColors?.agree || globals.brandColors.agree,
                fontWeight: "normal"
              }}>
                {topicStats.total_votes > 0 ? Math.round((topicStats.agree_votes / topicStats.total_votes) * 100) : 0}%
              </p>
              <p style={{ fontSize: "13px", color: "#999", marginTop: "5px" }}>
                {topicStats.agree_votes.toLocaleString()} votes
              </p>
            </div>
            <div style={{ flex: 1, minWidth: "200px", textAlign: "center"}}>
              <p style={{ 
                fontSize: "13px", 
                textTransform: "uppercase", 
                letterSpacing: "1px", 
                color: "#666",
                marginBottom: "8px"
              }}>Total Disagree Votes</p>
              <p style={{ 
                fontFamily: "Georgia, serif", 
                fontSize: "3rem", 
                margin: 0, 
                color: voteColors?.disagree || globals.brandColors.disagree,
                fontWeight: "normal"
              }}>
                {topicStats.total_votes > 0 ? Math.round((topicStats.disagree_votes / topicStats.total_votes) * 100) : 0}%
              </p>
              <p style={{ fontSize: "13px", color: "#999", marginTop: "5px" }}>
                {topicStats.disagree_votes.toLocaleString()} votes
              </p>
            </div>
          </div>
        </section>
        
        {/* Comment Divisiveness Distribution - moved to top */}
        <div style={{ 
          marginTop: 40, 
          marginBottom: 60,
          borderTop: "1px solid #e0e0e0",
          paddingTop: 40
        }}>
          <p style={{
            ...globals.secondaryHeading,
            marginBottom: 8,
            fontSize: "18px",
            letterSpacing: "0.5px",
            textTransform: "uppercase"
          }}>Comment Divisiveness Distribution</p>
          <p style={{
            ...globals.paragraph,
            fontSize: "14px",
            lineHeight: 1.6,
            color: "#666",
            marginBottom: 30
          }}>
            Each circle represents a comment. Position shows how similarly groups voted. Hover to see the group vote breakdown.
          </p>
          <TopicBeeswarm
            comments={comments}
            commentTids={topicStats.comment_tids || []}
            math={math}
            conversation={conversation}
            ptptCount={ptptCount}
            formatTid={formatTid}
            voteColors={voteColors}
          />
        </div>
        
        {/* Collective Statement - moved to top and auto-generated */}
        <div style={{ 
          marginTop: 40, 
          marginBottom: 60,
          borderTop: "1px solid #e0e0e0",
          paddingTop: 40
        }}>
          <p style={{
            ...globals.secondaryHeading,
            marginBottom: 4,
            fontSize: "18px",
            letterSpacing: "0.5px",
            textTransform: "uppercase"
          }}>Candidate Collective Statement</p>
          <p style={{
            ...globals.paragraph,
            fontSize: "14px",
            lineHeight: 1.6,
            color: "#666",
            marginBottom: 20,
            fontStyle: "italic"
          }}>
            Based on voting trends thus far
            {statementMetadata && (
              <span style={{ marginLeft: "10px", fontSize: "13px", color: "#888", fontStyle: "normal" }}>
                • Generated {new Date(statementMetadata.created_at).toLocaleDateString()} at {new Date(statementMetadata.created_at).toLocaleTimeString()} 
                {statementMetadata.model && ` (${statementMetadata.model.includes('claude') ? 'Claude Opus 4' : statementMetadata.model})`}
              </span>
            )}
          </p>
          
          {loadingStatement && (
            <div style={{ 
              padding: "20px",
              backgroundColor: "#f5f5f5",
              border: "1px solid #e0e0e0",
              borderRadius: "8px"
            }}>
              <p style={{ color: "#666", fontStyle: "italic", margin: 0 }}>Generating candidate collective statement...</p>
            </div>
          )}
          
          {collectiveStatement && collectiveStatement.insufficient && (
            <div style={{ 
              padding: "20px",
              backgroundColor: "#fff3cd",
              border: "1px solid #ffeaa7",
              borderRadius: "8px",
              marginTop: 20
            }}>
              <p style={{ color: "#856404", margin: 0 }}>
                <strong>Insufficient consensus:</strong> {collectiveStatement.message}
              </p>
              <p style={{ color: "#856404", margin: "10px 0 0 0", fontSize: "14px" }}>
                Candidate collective statements require topics with strong cross-group agreement to ensure meaningful representation.
              </p>
            </div>
          )}
          
          {collectiveStatement && !collectiveStatement.error && !collectiveStatement.insufficient && (() => {
            // Extract all citations from the collective statement
            const citationIds = [];
            const paragraphs = collectiveStatement.paragraphs || collectiveStatement.content?.paragraphs || [];
            paragraphs.forEach(paragraph => {
              paragraph.sentences?.forEach(sentence => {
                sentence.clauses?.forEach(clause => {
                  if (clause.citations && Array.isArray(clause.citations)) {
                    citationIds.push(...clause.citations.filter(c => typeof c === 'number'));
                  }
                });
              });
            });
            const uniqueCitations = [...new Set(citationIds)];
            
            return (
              <div style={{ 
                display: "flex", 
                flexDirection: window.innerWidth > 992 ? "row" : "column", 
                gap: "20px",
                marginTop: 20
              }}>
                {/* Collective statement text content */}
                <div style={{ 
                  flexGrow: 0,
                  flexShrink: 1,
                  flexBasis: window.innerWidth > 992 ? "520px" : "auto",
                  minWidth: window.innerWidth > 992 ? "400px" : "auto",
                  width: window.innerWidth > 992 ? "auto" : "100%"
                }}>
                  <div style={{ 
                    background: "#f5f5f5",
                    padding: "20px",
                    borderRadius: "8px",
                    border: "1px solid #e0e0e0",
                    lineHeight: 1.6
                  }}>
                    {paragraphs.map((paragraph, idx) => (
                      <div key={idx} style={{ marginBottom: 20 }}>
                        {paragraph.title && <h3 style={{ marginBottom: 10 }}>{paragraph.title}</h3>}
                        {paragraph.sentences && paragraph.sentences.map((sentence, sIdx) => (
                          <p key={sIdx} style={{ marginBottom: 15, color: "#555" }}>
                            {sentence.clauses && sentence.clauses.map((clause, cIdx) => (
                              <span key={cIdx}>
                                {clause.text}
                                {clause.citations && clause.citations.length > 0 && (
                                  <sup style={{ 
                                    color: "#0066cc",
                                    fontSize: "0.85em",
                                    marginLeft: "2px"
                                  }}>
                                    {clause.citations.join(', ')}
                                  </sup>
                                )}
                                {cIdx < sentence.clauses.length - 1 && ' '}
                              </span>
                            ))}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Comments referenced in collective statement */}
                {uniqueCitations.length > 0 && (
                  <div style={{ 
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: window.innerWidth > 992 ? "0%" : "auto",
                    minWidth: window.innerWidth > 992 ? "400px" : "auto",
                    width: window.innerWidth > 992 ? "auto" : "100%",
                    overflowX: "auto",
                    marginTop: window.innerWidth > 992 ? 0 : 30
                  }}>
                    <h3 style={{ marginBottom: 20 }}>Comments Referenced</h3>
                    <div style={{ width: "max-content" }}>
                      <CommentList
                        conversation={conversation}
                        ptptCount={ptptCount}
                        math={math}
                        formatTid={formatTid}
                        tidsToRender={uniqueCitations}
                        comments={comments}
                        voteColors={voteColors}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          
          {collectiveStatement && collectiveStatement.error && (
            <div style={{ 
              padding: "20px",
              backgroundColor: "#f5f5f5",
              border: "1px solid #e0e0e0",
              borderRadius: "8px"
            }}>
              <p style={{ color: "#666", fontStyle: "italic", margin: 0 }}>{collectiveStatement.message}</p>
            </div>
          )}
          
          {!collectiveStatement && !loadingStatement && (
            <div style={{ 
              padding: "20px",
              backgroundColor: "#f5f5f5",
              border: "1px solid #e0e0e0",
              borderRadius: "8px"
            }}>
              <p style={{ color: "#666", fontStyle: "italic", margin: 0 }}>
                Unable to generate candidate collective statement. Please try refreshing the page.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Narrative Report Section */}
      {topicNarrative && topicNarrative.paragraphs && (
        <div style={{ 
          marginTop: 40,
          borderTop: "1px solid #e0e0e0",
          paddingTop: 40
        }}>
          <p style={{
            ...globals.secondaryHeading,
            marginBottom: 30,
            fontSize: "18px",
            letterSpacing: "0.5px",
            textTransform: "uppercase"
          }}>Narrative Summary</p>
          
          {/* Extract all citations from the narrative */}
          {(() => {
            const citationIds = [];
            topicNarrative.paragraphs.forEach(paragraph => {
              paragraph.sentences?.forEach(sentence => {
                sentence.clauses?.forEach(clause => {
                  if (clause.citations && Array.isArray(clause.citations)) {
                    citationIds.push(...clause.citations.filter(c => typeof c === 'number'));
                  }
                });
              });
            });
            const uniqueCitations = [...new Set(citationIds)];
            
            return (
              <div style={{ 
                display: "flex", 
                flexDirection: window.innerWidth > 992 ? "row" : "column", 
                gap: "20px",
                marginTop: 30,
                marginBottom: 40
              }}>
                {/* Narrative text content */}
                <div style={{ 
                  flexGrow: 0,
                  flexShrink: 1,
                  flexBasis: window.innerWidth > 992 ? "520px" : "auto",
                  minWidth: window.innerWidth > 992 ? "400px" : "auto",
                  width: window.innerWidth > 992 ? "auto" : "100%"
                }}>
                  <div style={{ 
                    background: "#f9f9f9",
                    padding: "20px",
                    borderRadius: "8px",
                    lineHeight: 1.6
                  }}>
                    {topicNarrative.paragraphs.map((paragraph, idx) => (
                      <div key={idx} style={{ marginBottom: 20 }}>
                        {paragraph.title && <h3 style={{ marginBottom: 10 }}>{paragraph.title}</h3>}
                        {paragraph.sentences && paragraph.sentences.map((sentence, sIdx) => (
                          <p key={sIdx} style={{ marginBottom: 15, color: "#555" }}>
                            {sentence.clauses && sentence.clauses.map((clause, cIdx) => (
                              <span key={cIdx}>
                                {clause.text}
                                {clause.citations && clause.citations.length > 0 && (
                                  <sup style={{ 
                                    color: "#0066cc",
                                    fontSize: "0.85em",
                                    marginLeft: "2px"
                                  }}>
                                    {clause.citations.join(', ')}
                                  </sup>
                                )}
                                {cIdx < sentence.clauses.length - 1 && ' '}
                              </span>
                            ))}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Comments referenced in narrative */}
                {uniqueCitations.length > 0 && (
                  <div style={{ 
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: window.innerWidth > 992 ? "0%" : "auto",
                    minWidth: window.innerWidth > 992 ? "400px" : "auto",
                    width: window.innerWidth > 992 ? "auto" : "100%",
                    overflowX: "auto",
                    marginTop: window.innerWidth > 992 ? 0 : 30
                  }}>
                    <h3 style={{ marginBottom: 20 }}>Comments Referenced</h3>
                    <div style={{ width: "max-content" }}>
                      <CommentList
                        conversation={conversation}
                        ptptCount={ptptCount}
                        math={math}
                        formatTid={formatTid}
                        tidsToRender={uniqueCitations}
                        comments={comments}
                        voteColors={voteColors}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}


      {/* Consensus vs Engagement Section */}
      <div style={{ 
        marginTop: 40,
        borderTop: "1px solid #e0e0e0",
        paddingTop: 40
      }}>
        <p style={{
          ...globals.secondaryHeading,
          marginBottom: 8,
          fontSize: "18px",
          letterSpacing: "0.5px",
          textTransform: "uppercase"
        }}>Consensus vs Engagement</p>
        <p style={{
          ...globals.paragraph,
          fontSize: "14px",
          lineHeight: 1.6,
          color: "#666",
          marginBottom: 30
        }}>
          This visualization shows how group consensus relates to voting engagement for each comment.
          Comments with high consensus and high engagement represent areas of strong agreement or disagreement across the conversation.
        </p>
        <div style={{ marginTop: 30, marginBottom: 40 }}>
          {topicComments.length > 0 && math && math["group-aware-consensus"] && topicStats ? (
            <AllCommentsScatterplot
              comments={topicComments}
              math={math}
              voteColors={voteColors}
            />
          ) : (
            <div style={{ textAlign: "center", padding: "40px", color: "#666" }}>
              No data available for visualization
            </div>
          )}
        </div>
      </div>


      {/* All Comments Section */}
      <div style={{ 
        marginTop: 40,
        borderTop: "1px solid #e0e0e0",
        paddingTop: 40,
        marginBottom: 60
      }}>
        <p style={{
          ...globals.secondaryHeading,
          marginBottom: 8,
          fontSize: "18px",
          letterSpacing: "0.5px",
          textTransform: "uppercase"
        }}>All Comments ({topicComments.length})</p>
        <p style={{
          ...globals.paragraph,
          fontSize: "14px",
          lineHeight: 1.6,
          color: "#666",
          marginBottom: 30
        }}>
          All comments in this topic.
        </p>
        <div style={{ marginTop: 30 }}>
          <CommentList
            conversation={conversation}
            ptptCount={ptptCount}
            math={math}
            formatTid={formatTid}
            tidsToRender={topicStats.comment_tids || []}
            comments={comments}
            voteColors={voteColors}
          />
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default TopicPage;