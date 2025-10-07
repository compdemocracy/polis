import React, { useState, useEffect, useRef } from "react";
import net from "../../util/net";
import Heading from "../framework/heading.jsx";
import Footer from "../framework/Footer.jsx";
import CommentList from "../lists/commentList.jsx";
import * as globals from "../globals";

const CollectiveStatementsReport = ({ conversation, report_id, math, comments, ptptCount, formatTid, voteColors }) => {
  const [loading, setLoading] = useState(true);
  const [statements, setStatements] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const carouselRef = useRef(null);
  const containerRef = useRef(null);
  const [cardWidth, setCardWidth] = useState(1400); // Default width - wider for better content display
  const [cardHeight, setCardHeight] = useState('600px'); // Default height
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [touchStart, setTouchStart] = useState(null);
  const [touchEnd, setTouchEnd] = useState(null);

  // Minimum swipe distance (in px)
  const minSwipeDistance = 50;

  const onTouchStart = (e) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const onTouchMove = (e) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const onTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    if (isLeftSwipe) {
      handleNext();
    }
    if (isRightSwipe) {
      handlePrevious();
    }
  };

  // Check if embedded
  useEffect(() => {
    // Check if we're in an iframe
    const embedded = window.self !== window.top;
    setIsEmbedded(embedded);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        handlePrevious();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, statements.length]);

  useEffect(() => {
    const fetchStatements = async () => {
      try {
        setLoading(true);
        const response = await net.polisGet("/api/v3/collectiveStatement", {
          report_id: report_id
        });
        
        if (response.status === "success" && response.statements) {
          // Sort by created_at descending (most recent first)
          const sortedStatements = response.statements.sort((a, b) => 
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
          setStatements(sortedStatements);
        }
      } catch (err) {
        console.error("Error fetching collective statements:", err);
      } finally {
        setLoading(false);
      }
    };

    if (report_id) {
      fetchStatements();
    }
  }, [report_id]);

  // Update card width and height on resize
  useEffect(() => {
    const updateCardDimensions = () => {
      setWindowWidth(window.innerWidth);
      if (containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth;
        setCardWidth(Math.min(containerWidth * 0.9, 1600)); // 90% of container or max 1600px
        
        // Calculate available height
        const windowHeight = window.innerHeight;
        const containerTop = containerRef.current.getBoundingClientRect().top;
        const footerHeight = 80; // Approximate footer height
        const availableHeight = windowHeight - containerTop - footerHeight - 40; // Less padding needed now
        
        // On mobile (width < 768px), use fixed height. On desktop, use available space
        // Subtract extra space for scale (5% = 50px on a 1000px card)
        const scaleBuffer = 50;
        if (window.innerWidth < 768) {
          setCardHeight('600px');
        } else {
          setCardHeight(Math.max(600, availableHeight - scaleBuffer) + 'px'); // No max limit on desktop
        }
      }
    };

    updateCardDimensions();
    window.addEventListener('resize', updateCardDimensions);
    return () => window.removeEventListener('resize', updateCardDimensions);
  }, []);
  
  // Recalculate card dimensions when statements are loaded
  useEffect(() => {
    if (statements.length > 0 && containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      setCardWidth(Math.min(containerWidth * 0.9, 1600));
      
      // Recalculate height too
      const windowHeight = window.innerHeight;
      const containerTop = containerRef.current.getBoundingClientRect().top;
      const footerHeight = 80;
      const availableHeight = windowHeight - containerTop - footerHeight - 40;
      
      const scaleBuffer = 50;
      if (window.innerWidth < 768) {
        setCardHeight('600px');
      } else {
        setCardHeight(Math.max(600, availableHeight - scaleBuffer) + 'px'); // No max limit on desktop
      }
    }
  }, [statements]);

  const scrollToIndex = (index) => {
    if (index === currentIndex) return;
    
    setCurrentIndex(index);
  };

  const handlePrevious = () => {
    const newIndex = currentIndex > 0 ? currentIndex - 1 : statements.length - 1;
    scrollToIndex(newIndex);
  };

  const handleNext = () => {
    const newIndex = currentIndex < statements.length - 1 ? currentIndex + 1 : 0;
    scrollToIndex(newIndex);
  };

  // Extract citations from statement data
  const extractCitations = (statementData) => {
    const citations = [];
    if (statementData && statementData.paragraphs) {
      statementData.paragraphs.forEach((paragraph) => {
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
    return [...new Set(citations)];
  };

  const renderStatement = (statement, index) => {
    const uniqueCitations = extractCitations(statement.statement_data);
    const isActive = index === currentIndex;
    
    return (
      <div
        key={statement.zid_topic_jobid}
        style={{
          minWidth: window.innerWidth < 779 ? "100%" : (cardWidth || 1400) + "px",
          maxWidth: window.innerWidth < 779 ? "100%" : (cardWidth || 1400) + "px",
          marginRight: window.innerWidth < 779 ? 0 : "40px",
          opacity: window.innerWidth > 779 && (isActive ? 1 : 0.5),
          transform: window.innerWidth > 779 && (isActive ? "scale(1) translateY(0)" : "scale(0.95) translateY(0)"),
          transition: "all 0.3s ease",
          backgroundColor: "white",
          borderRadius: "12px",
          boxShadow: window.innerWidth > 779 && (isActive ? "0 10px 40px rgba(0, 0, 0, 0.15)" : "0 5px 20px rgba(0, 0, 0, 0.1)"),
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          height: "100%"
        }}
      >
        {/* Header */}
        <div style={{
          padding: "30px",
          borderBottom: "1px solid #e0e0e0",
          background: "linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)"
        }}>
          <h2 style={{ 
            margin: 0, 
            fontSize: "1.8em",
            color: "#333",
            marginBottom: "10px"
          }}>
            {statement.topic_name}
          </h2>
          <p style={{ 
            margin: 0, 
            color: "#666", 
            fontSize: "0.95em",
            fontStyle: "italic" 
          }}>
            Candidate Collective Statement
          </p>
          <p style={{ 
            margin: 0, 
            marginTop: "8px",
            fontSize: "0.85em", 
            color: "#888" 
          }}>
            Generated {new Date(statement.created_at).toLocaleDateString()} at {new Date(statement.created_at).toLocaleTimeString()}
            {statement.model && ` • ${statement.model.includes('claude') ? 'Claude Opus 4' : statement.model}`}
          </p>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: windowWidth < 992 ? "column" : "row",
          overflow: "scroll",
          height: cardHeight
        }}>
          {/* Statement Text */}
          <div style={{
            flex: windowWidth < 992 ? "0 0 auto" : "0 0 40%",
            padding: "30px",
            overflowY: "auto",
            borderRight: windowWidth < 992 ? "none" : "1px solid #e0e0e0",
            borderBottom: windowWidth < 992 ? "1px solid #e0e0e0" : "none",
            maxHeight: windowWidth < 992 ? "40%" : "none"
          }}>
            <h3 style={{ marginTop: 0, marginBottom: "20px", color: "#333" }}>Statement</h3>
            {statement.statement_data && statement.statement_data.paragraphs && 
              statement.statement_data.paragraphs.map((paragraph, idx) => (
                <div key={idx} style={{ marginBottom: "20px" }}>
                  {paragraph.title && (
                    <h4 style={{ marginTop: 0, marginBottom: "10px", color: "#444" }}>
                      {paragraph.title}
                    </h4>
                  )}
                  {paragraph.sentences && paragraph.sentences.map((sentence, sIdx) => (
                    <p key={sIdx} style={{ 
                      marginBottom: "10px", 
                      lineHeight: 1.6,
                      color: "#555"
                    }}>
                      {sentence.clauses && sentence.clauses.map((clause, cIdx) => (
                        <span key={cIdx}>
                          {clause.text}
                          {clause.citations && clause.citations.length > 0 && (
                            <sup style={{
                              color: "#007bff",
                              fontSize: "0.8em",
                              marginLeft: "2px"
                            }}>
                              [{clause.citations.join(", ")}]
                            </sup>
                          )}
                          {cIdx < sentence.clauses.length - 1 && " "}
                        </span>
                      ))}
                    </p>
                  ))}
                </div>
              ))
            }
          </div>

          {/* Cited Comments */}
          <div style={{
            flex: windowWidth < 992 ? "1 1 auto" : "0 0 60%",
            padding: "30px",
            overflowY: "scroll",
            width: "100%",
            overflowX: "visible",
            backgroundColor: "#fafafa",
            minHeight: 0
          }}>
            <h3 style={{ marginTop: 0, marginBottom: "20px", color: "#333" }}>
              Cited Comments ({uniqueCitations.length})
            </h3>
            {uniqueCitations.length > 0 ? (
              <div style={{
                display: windowWidth < 992 ? "flex" : "block",
                width: windowWidth < 992 ? "max-content" : "auto"
              }}>
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
            ) : (
              <p style={{ color: "#999", fontStyle: "italic" }}>No comments cited</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div style={{ 
        maxWidth: "100%", 
        margin: "0 auto",
        backgroundColor: "#f5f6fa",
        minHeight: "100vh"
      }}>
        {!isEmbedded && (
          <div style={{ padding: "20px" }}>
            <Heading conversation={conversation} />
          </div>
        )}
        <div style={{ 
          marginTop: 100, 
          textAlign: "center",
          padding: "40px"
        }}>
          <div style={{
            display: "inline-block",
            width: "50px",
            height: "50px",
            border: "3px solid #e0e0e0",
            borderTop: "3px solid #007bff",
            borderRadius: "50%",
            animation: "spin 1s linear infinite"
          }}></div>
          <p style={{ marginTop: "20px", color: "#666" }}>Loading collective statements...</p>
          <style>{`
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      </div>
    );
  }

  if (statements.length === 0) {
    return (
      <div style={{ maxWidth: "100%", margin: "0 auto", padding: "20px" }}>
        {!isEmbedded && <Heading conversation={conversation} />}
        <div style={{ marginTop: 40, textAlign: "center" }}>
          <p>No collective statements have been generated yet.</p>
        </div>
        {!isEmbedded && <Footer />}
      </div>
    );
  }

  return (
    <div style={{ 
      maxWidth: "100%", 
      margin: "0 auto",
      backgroundColor: "#f5f6fa",
      minHeight: "100vh"
    }}>
      {!isEmbedded && (
        <div style={{ padding: "20px" }}>
          <Heading conversation={conversation} />
        </div>
      )}
      
      <div style={{ 
        position: "relative",
        padding: "40px 0",
        overflow: "visible"
      }}>
        {window.innerWidth < 779 && (
          <div style={{
            textAlign: "center",
            marginBottom: "20px"
          }}>
            <div style={{
              color: "#666",
              fontSize: "0.9em",
              marginBottom: "10px"
            }}>
              {statements.length} statements
            </div>
          </div>
        )}
        {window.innerWidth > 779 && (
          <div style={{
            textAlign: "center",
            marginBottom: "20px"
          }}>
            <div style={{
              color: "#666",
              fontSize: "0.9em",
              marginBottom: "10px"
            }}>
              {currentIndex + 1} of {statements.length} statements
            </div>
            
            {/* Dots Indicator */}
              <div style={{
                display: "flex",
                justifyContent: "center",
                gap: "8px"
              }}>
                {statements.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => scrollToIndex(index)}
                    style={{
                      width: index === currentIndex ? "24px" : "8px",
                      height: "8px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: index === currentIndex ? "#007bff" : "#ccc",
                      cursor: "pointer",
                      transition: "all 0.3s ease",
                      padding: 0
                    }}
                  />
                ))}
              </div>
          </div>
        )}
        {/* Navigation Buttons */}
        {window.innerWidth > 779 && (
          <>
            <button
              onClick={handlePrevious}
              style={{
                position: "absolute",
                left: "20px",
                top: "200px", // Fixed position near top of cards
                zIndex: 10,
                width: "50px",
                height: "50px",
                borderRadius: "50%",
                border: "none",
                backgroundColor: "white",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
                color: "#333",
                transition: "all 0.2s ease"
              }}
              onMouseEnter={(e) => e.target.style.transform = "scale(1.1)"}
              onMouseLeave={(e) => e.target.style.transform = "scale(1)"}
            >
              ←
            </button>

            <button
              onClick={handleNext}
              style={{
                position: "absolute",
                right: "20px",
                top: "200px", // Fixed position near top of cards
                zIndex: 10,
                width: "50px",
                height: "50px",
                borderRadius: "50%",
                border: "none",
                backgroundColor: "white",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
                color: "#333",
                transition: "all 0.2s ease"
              }}
              onMouseEnter={(e) => e.target.style.transform = "scale(1.1)"}
              onMouseLeave={(e) => e.target.style.transform = "scale(1)"}
            >
              →
            </button>
          </>
        )}


        {/* Carousel Container */}
        <div 
          ref={containerRef}
          style={{
            overflow: "hidden",
            margin: window.innerWidth < 779 ? "0 auto" : "0 80px",
            position: "relative"
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div
            ref={carouselRef}
            style={{
              display: window.innerWidth > 779 ? "flex" : "block",
              transition: window.innerWidth > 779 ? "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : "none",
              transform: window.innerWidth > 779 ? `translateX(-${currentIndex * (cardWidth + 40)}px)` : "none",
            }}
          >
            {statements.map((statement, index) => renderStatement(statement, index))}
          </div>
        </div>
      </div>

      {!isEmbedded && (
        <div style={{ padding: "20px" }}>
          <Footer />
        </div>
      )}
    </div>
  );
};

export default CollectiveStatementsReport;