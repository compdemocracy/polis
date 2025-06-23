import React, { useState } from "react";
import net from "../../util/net";
import CommentList from "../lists/commentList.jsx";
import TopicDataProvider from "./TopicDataProvider.jsx";
import TopicSectionsBuilder from "./TopicSectionsBuilder.jsx";
import TopicSelector from "./TopicSelector.jsx";

const TopicReport = ({ report_id, math, comments, conversation, ptptCount, formatTid, voteColors }) => {
  const [selectedTopic, setSelectedTopic] = useState("");
  const [topicContent, setTopicContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(false);

  // Extract content fetching logic for reuse
  const fetchTopicContent = (topicKey) => {
    if (!topicKey) {
      setTopicContent(null);
      return;
    }

    setContentLoading(true);
    net
      .polisGet("/api/v3/delphi/reports", {
        report_id: report_id,
        section: topicKey  // The topic key IS the section (e.g., "layer0_8")
      })
      .then((response) => {
        
        if (response && response.status === "success" && response.reports) {
          // The response contains reports object with the section as key
          const sectionData = response.reports[topicKey] || response.reports[Object.keys(response.reports).map(key => key.includes(topicKey))];
          if (sectionData && sectionData.report_data) {
            // Parse the report_data if it's a string
            const reportData = typeof sectionData.report_data === 'string' 
              ? JSON.parse(sectionData.report_data) 
              : sectionData.report_data;
            setTopicContent(reportData);
          } else {
            setTopicContent({
              error: true,
              message: "No report data found for this topic"
            });
          }
        } else if (response && response.status === "error") {
          setTopicContent({
            error: true,
            message: response.message || "No narrative report available for this topic"
          });
        }
        setContentLoading(false);
      })
      .catch((error) => {
        console.error("Error fetching topic report:", error);
        setContentLoading(false);
      });
  };

  const handleTopicChange = (event) => {
    const topicKey = event.target.value;
    setSelectedTopic(topicKey);
    fetchTopicContent(topicKey);
  };

  // Extract citation IDs from the topic content
  const extractCitations = (content) => {
    const citations = [];
    if (content && content.paragraphs) {
      content.paragraphs.forEach(paragraph => {
        if (paragraph.sentences) {
          paragraph.sentences.forEach(sentence => {
            if (sentence.clauses) {
              sentence.clauses.forEach(clause => {
                if (clause.citations && Array.isArray(clause.citations)) {
                  citations.push(...clause.citations.filter(c => typeof c === 'number'));
                }
              });
            }
          });
        }
      });
    }
    return [...new Set(citations)]; // Remove duplicates
  };


  const renderContent = () => {
    if (!topicContent) return null;

    // Handle error state
    if (topicContent.error) {
      return (
        <div className="topic-content">
          <p style={{ color: '#666', fontStyle: 'italic' }}>{topicContent.message}</p>
          <p style={{ color: '#666', fontSize: '14px', marginTop: '10px' }}>
            To generate narrative reports, use the "Generate Narrative Report" button in the Comments Report page.
          </p>
        </div>
      );
    }

    // Extract citations for this topic
    const citationIds = extractCitations(topicContent);
    console.log("Extracted citations:", citationIds);
    console.log("Comments loaded:", comments?.length || 0);

    // Render the topic content in the same format as the main report
    return (
      <div className="topic-layout-container">
        <div className="topic-text-content">
          <div className="topic-content">
            {topicContent.paragraphs && topicContent.paragraphs.map((paragraph, idx) => (
            <div key={idx} className="paragraph">
              <h3>{paragraph.title}</h3>
              {paragraph.sentences && paragraph.sentences.map((sentence, sIdx) => (
                <p key={sIdx}>
                  {sentence.clauses && sentence.clauses.map((clause, cIdx) => (
                    <span key={cIdx}>
                      {clause.text}
                      {clause.citations && clause.citations.length > 0 && (
                        <sup className="citations">
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
        
        {/* Comments list section - side by side */}
        {citationIds.length > 0 && comments && comments.length > 0 && (
          <div className="topic-comments-column" style={{ overflowX: "scroll"}}>
            <h3 style={{ marginBottom: '20px' }}>Comments Referenced in This Topic</h3>
            <CommentList
              conversation={conversation}
              ptptCount={ptptCount}
              math={math}
              formatTid={formatTid}
              tidsToRender={citationIds}
              comments={comments}
              voteColors={voteColors || {
                agree: "#21a53a",
                disagree: "#e74c3c", 
                pass: "#b3b3b3"
              }}
              style={{
                width: "max-content"
              }}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <TopicDataProvider report_id={report_id}>
      {({ topicData, narrativeData }) => (
        <TopicSectionsBuilder topicData={topicData} narrativeData={narrativeData}>
          {({ sections, runInfo, error, defaultSectionKey }) => {
            // Auto-select cross-group consensus if not already selected
            React.useEffect(() => {
              if (defaultSectionKey && !selectedTopic) {
                setSelectedTopic(defaultSectionKey);
                // Trigger content loading for the auto-selected topic
                fetchTopicContent(defaultSectionKey);
              }
            }, [defaultSectionKey]);

            return (
            <div className="topic-report-container">
      <style>{`
        .topic-report-container {
          padding: 20px;
          font-family: Arial, sans-serif;
          max-width: 1600px;
          margin: 0 auto;
        }
        .run-info-header {
          margin-bottom: 20px;
          padding: 15px;
          background: #f5f5f5;
          border-radius: 6px;
          border-left: 4px solid #03a9f4;
        }
        .run-info-header h3 {
          margin: 0 0 8px 0;
          color: #333;
        }
        .run-meta {
          display: flex;
          gap: 15px;
          align-items: center;
          font-size: 14px;
          color: #666;
        }
        .run-date {
          color: #666;
        }
        .topic-selector {
          margin-bottom: 30px;
        }
        .topic-selector select {
          width: 100%;
          max-width: 800px;
          padding: 10px;
          font-size: 16px;
          border: 1px solid #ccc;
          border-radius: 4px;
          background-color: white;
        }
        .topic-layout-container {
          display: flex;
          flex-direction: row;
          gap: 20px;
        }
        .topic-text-content {
          flex-grow: 0;
          flex-shrink: 1;
          flex-basis: 520px;
        }
        .topic-content {
          background: #f9f9f9;
          padding: 20px;
          border-radius: 8px;
          line-height: 1.6;
        }
        .topic-content h3 {
          color: #333;
          margin-top: 20px;
          margin-bottom: 10px;
        }
        .topic-content h3:first-child {
          margin-top: 0;
        }
        .topic-content p {
          margin-bottom: 15px;
          color: #555;
        }
        .citations {
          color: #0066cc;
          font-size: 0.85em;
          margin-left: 2px;
        }
        .topic-comments-column {
          flex-grow: 1;
          flex-shrink: 1;
          flex-basis: 0%;
          min-width: 400px;
        }
        .loading {
          text-align: center;
          padding: 20px;
          color: #666;
        }
        
        /* Responsive stacking for smaller screens */
        @media (max-width: 992px) {
          .topic-layout-container {
            flex-direction: column;
          }
          
          .topic-text-content,
          .topic-comments-column {
            flex-basis: auto;
            width: 100%;
          }
          
          .topic-comments-column {
            margin-top: 30px;
          }
        }
      `}</style>
      
      {/* Run Information Header */}
      <div className="run-info-header">
        <h3>Narrative Summaries</h3>
      </div>
      
      <TopicSelector 
        sections={sections}
        selectedTopic={selectedTopic}
        onTopicChange={handleTopicChange}
        loading={contentLoading}
      />

      {contentLoading && (
        <div className="loading">Loading topic report...</div>
      )}

      {!contentLoading && renderContent()}
            </div>
            );
          }}
        </TopicSectionsBuilder>
      )}
    </TopicDataProvider>
  );
};

export default TopicReport;