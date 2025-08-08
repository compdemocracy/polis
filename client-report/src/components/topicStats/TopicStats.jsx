import React, { useState, useEffect } from "react";
import net from "../../util/net";
import { useReportId } from "../framework/useReportId";
import Heading from "../framework/heading.jsx";
import Footer from "../framework/Footer.jsx";
import CollectiveStatementModal from "./CollectiveStatementModal.jsx";
import BeeswarmModal from "./BeeswarmModal.jsx";
import AllCommentsModal from "./AllCommentsModal.jsx";
import LayerDistributionModal from "./LayerDistributionModal.jsx";
import TopicOverviewScatterplot from "./visualizations/TopicOverviewScatterplot.jsx";
import TopicTables from "./visualizations/TopicTables.jsx";
import TopicPage from "../topicPage/TopicPage.jsx";

const TopicStats = ({ conversation, report_id: propsReportId, math, comments, ptptCount, formatTid, voteColors }) => {
  const { report_id } = useReportId(propsReportId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topicsData, setTopicsData] = useState(null);
  const [statsData, setStatsData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [scatterModalOpen, setScatterModalOpen] = useState(false);
  const [beeswarmModalOpen, setBeeswarmModalOpen] = useState(false);
  const [layerModalOpen, setLayerModalOpen] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [selectedLayer, setSelectedLayer] = useState(null);
  // Removed showTopicPage and selectedTopicKey state - now using URL routing
  
  // Calculate metrics from comments data
  const calculateMetricsFromComments = (commentTids, allComments) => {
    if (!commentTids || !allComments) return null;
    
    // Create a map for quick lookup
    const commentMap = {};
    allComments.forEach(c => {
      commentMap[c.tid] = c;
    });
    
    let totalVotes = 0;
    let totalAgree = 0;
    let totalDisagree = 0;
    let totalPass = 0;
    let consensusSum = 0;
    let divisiveSum = 0;
    let commentCount = 0;
    
    commentTids.forEach(tid => {
      const comment = commentMap[tid];
      if (!comment) return;
      
      commentCount++;
      const agreeCount = comment.agree_count || 0;
      const disagreeCount = comment.disagree_count || 0;
      const passCount = comment.pass_count || 0;
      const voteCount = agreeCount + disagreeCount + passCount;
      
      totalVotes += voteCount;
      totalAgree += agreeCount;
      totalDisagree += disagreeCount;
      totalPass += passCount;
      
      // Calculate per-comment consensus
      const activeVotes = agreeCount + disagreeCount;
      if (activeVotes > 0) {
        const agreeRate = agreeCount / activeVotes;
        const disagreeRate = disagreeCount / activeVotes;
        const consensus = Math.max(agreeRate, disagreeRate);
        consensusSum += consensus * voteCount;
        
        // Divisiveness: how evenly split the votes are
        const divisiveness = 1 - Math.abs(agreeRate - disagreeRate);
        divisiveSum += divisiveness * voteCount;
      }
    });
    
    return {
      comment_count: commentCount,
      total_votes: totalVotes,
      consensus: totalVotes > 0 ? consensusSum / totalVotes : 0,
      divisiveness: totalVotes > 0 ? divisiveSum / totalVotes : 0,
      agree_votes: totalAgree,
      disagree_votes: totalDisagree,
      pass_votes: totalPass,
      vote_density: commentCount > 0 ? totalVotes / commentCount : 0,
    };
  };
  


  useEffect(() => {
    if (!report_id) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fetch topics from Delphi endpoint
        const topicsResponse = await net.polisGet("/api/v3/delphi", {
          report_id: report_id,
        });
        
        // Fetch topic statistics
        const statsResponse = await net.polisGet("/api/v3/topicStats", {
          report_id: report_id,
        });
        
        if (topicsResponse.status === "success") {
          setTopicsData(topicsResponse.runs);
        }
        
        if (statsResponse.status === "success" && comments) {
          // Calculate metrics client-side using comments data
          const enrichedStats = {};
          Object.entries(statsResponse.stats).forEach(([topicKey, stats]) => {
            const metrics = calculateMetricsFromComments(stats.comment_tids, comments);
            enrichedStats[topicKey] = {
              ...stats,
              ...metrics,
              comment_tids: stats.comment_tids
            };
          });
          setStatsData(enrichedStats);
        }
        
        setLoading(false);
      } catch (err) {
        console.error("Error fetching topic stats:", err);
        setError(err.message || "Failed to load topic statistics");
        setLoading(false);
      }
    };

    fetchData();
  }, [report_id, comments]);

  if (loading) {
    return (
      <div style={{ margin: "0px 10px", maxWidth: "1200px", padding: "20px" }}>
        <Heading conversation={conversation} />
        <div style={{ marginTop: 40 }}>
          <p>Loading topic statistics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ margin: "0px 10px", maxWidth: "1200px", padding: "20px" }}>
        <Heading conversation={conversation} />
        <div style={{ marginTop: 40 }}>
          <p>Error: {error}</p>
        </div>
      </div>
    );
  }

  // Get the most recent run of topics
  const latestRunKey = Object.keys(topicsData || {}).sort().reverse()[0];
  const latestRun = topicsData?.[latestRunKey];

  return (
    <div style={{ margin: "0px 10px", maxWidth: "1200px", padding: "20px" }} data-testid="topic-stats">
      <Heading conversation={conversation} />
      <div style={{ marginTop: 40 }}>
        <h2>Topic Statistics</h2>
        
        {latestRun && (
          <div style={{ marginTop: 20 }}>
            <p>Model: {latestRun.model_name}</p>
            <p>Generated: {new Date(latestRun.created_at).toLocaleString()}</p>
            
            {/* Group-aware consensus scatterplot */}
            <TopicOverviewScatterplot 
              latestRun={latestRun}
              statsData={statsData}
              math={math}
              voteColors={voteColors}
              onTopicClick={(topic) => {
                window.location.href = `/topicStats/${report_id}/${topic.topic_key.replace(/#/g, '%23')}`;
              }}
            />
            
            
            <TopicTables 
              latestRun={latestRun}
              statsData={statsData}
              math={math}
              report_id={report_id}
              onTopicSelect={(topic) => {
                setSelectedTopic(topic);
                setModalOpen(true);
              }}
              onScatterplot={(topic) => {
                setSelectedTopic(topic);
                setScatterModalOpen(true);
              }}
              onBeeswarm={(topic) => {
                setSelectedTopic(topic);
                setBeeswarmModalOpen(true);
              }}
              onLayerDistribution={(layer) => {
                setSelectedLayer(layer);
                setLayerModalOpen(true);
              }}
              onViewTopic={(topic) => {
                window.location.href = `/topicStats/${report_id}/${topic.key.replace(/#/g, '%23')}`;
              }}
            />
          </div>
        )}
        
        <Footer />
      </div>
      
      <CollectiveStatementModal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedTopic(null);
        }}
        topicName={selectedTopic?.name}
        topicKey={selectedTopic?.key}
        reportId={report_id}
        conversation={conversation}
        math={math}
        comments={comments}
        ptptCount={ptptCount}
        formatTid={formatTid}
        voteColors={voteColors}
      />
      
      <AllCommentsModal
        isOpen={scatterModalOpen}
        onClose={() => {
          setScatterModalOpen(false);
          setSelectedTopic(null);
        }}
        topicName={selectedTopic?.name}
        topicKey={selectedTopic?.key}
        topicStats={selectedTopic ? statsData[selectedTopic.key] : null}
        comments={comments}
        math={math}
        conversation={conversation}
        ptptCount={ptptCount}
        formatTid={formatTid}
        voteColors={voteColors}
      />
      
      <BeeswarmModal
        isOpen={beeswarmModalOpen}
        onClose={() => {
          setBeeswarmModalOpen(false);
          setSelectedTopic(null);
        }}
        topicName={selectedTopic?.name}
        topicKey={selectedTopic?.key}
        topicStats={selectedTopic ? statsData[selectedTopic.key] : null}
        conversation={conversation}
        math={math}
        comments={comments}
        ptptCount={ptptCount}
        formatTid={formatTid}
        voteColors={voteColors}
      />
      
      <LayerDistributionModal
        isOpen={layerModalOpen}
        onClose={() => {
          setLayerModalOpen(false);
          setSelectedLayer(null);
        }}
        layerName={selectedLayer?.layerName}
        layerId={selectedLayer?.layerId}
        topics={selectedLayer?.topics}
        statsData={statsData}
        math={math}
        comments={comments}
      />
    </div>
  );
};

export default TopicStats;