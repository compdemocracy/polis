import React, { useEffect, useState } from "react";
import { useTopicData } from "./hooks/useTopicData";
import { extractArchetypalComments } from "./utils/archetypeExtraction";
import LayerHeader from "./components/LayerHeader";
import ScrollableTopicsGrid from "./components/ScrollableTopicsGrid";
import TopicAgendaStyles from "./components/TopicAgendaStyles";
import PolisNet from "../../lib/net";
import { getConversationToken } from "../../lib/auth";

const TopicAgenda = ({ conversation_id, requiresInviteCode = false }) => {
  const [loadWidget, setLoadWidget] = useState(false);
  const [selections, setSelections] = useState(new Set());
  const [commentMap, setCommentMap] = useState(new Map());
  const [comments, setComments] = useState([]);
  const [reportData, setReportData] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [err, setError] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [inviteCodeRequired, setInviteCodeRequired] = useState(requiresInviteCode);

  const {
    loading,
    error,
    topicData,
    hierarchyAnalysis,
    clusterGroups,
    fetchUMAPData
  } = useTopicData(reportData?.report_id, loadWidget);

  useEffect(() => {
    const token = getConversationToken(conversation_id);
    if (token && token.token) {
      setInviteCodeRequired(false);
    }
    const cb1 = () => setInviteCodeRequired(false);
    const cb2 = () => setInviteCodeRequired(false);
    window.addEventListener('invite-code-submitted', cb1);
    window.addEventListener('login-code-submitted', cb2);
    return () => {
      window.removeEventListener('invite-code-submitted', cb1);
      window.removeEventListener('login-code-submitted', cb2);
    };
  }, [conversation_id]);

  useEffect(() => {
    const f = async () => {
      // Check if topic prioritization is available for this conversation
      try {
        const topicPrioritizeResponse = await PolisNet.polisGet(
          '/participation/topicPrioritize',
          { conversation_id }
        );
        
        if (topicPrioritizeResponse) {
          const topicPrioritizeData = topicPrioritizeResponse;
          console.log('Topic prioritize check:', topicPrioritizeData);
          
          if (topicPrioritizeData.has_report && topicPrioritizeData.report_id) {
            setReportData({
              report_id: topicPrioritizeData.report_id,
              conversation_id: topicPrioritizeData.conversation_id
            });
            // Also fetch full convo with PCA (large query)
            const convoFetcher = await PolisNet.polisGet('/participationInit', { conversation_id, includePCA: true });
            if (convoFetcher) {
              setConversation(convoFetcher);
            }
            
            // Also fetch comments for the TopicAgenda
            // Use the original zinvite for the comments API, not the numeric conversation_id
            const commentsResponse = await PolisNet.polisGet(
              '/comments',
              { conversation_id, moderation: 'true', include_voting_patterns: 'true' }
            );
            
            if (commentsResponse) {
              const cd = commentsResponse;
              console.log(`Found ${cd.length} comments for topic prioritization`);
              setComments(cd);
            }
          }
        }
      } catch (err) {
        console.error("Failed to check topic prioritization availability:", err);
      }
    }
    if (loadWidget) {
      f();
    }
  }, [loadWidget]);

  // Build comment map for easy lookup
  useEffect(() => {
    if (comments && comments.length > 0 && loadWidget) {
      const map = new Map();
      comments.forEach(comment => {
        // Store by both tid (as number) and as string for flexibility
        map.set(comment.tid, comment.txt);
        map.set(String(comment.tid), comment.txt);
      });
      setCommentMap(map);
      console.log(`Built comment map with ${map.size / 2} comments`);
    }
  }, [comments, loadWidget]);

  // Fetch UMAP data when topic data is loaded
  useEffect(() => {
    if (topicData && conversation && loadWidget) {
      fetchUMAPData(conversation_id);
    }
  }, [topicData, conversation, fetchUMAPData, loadWidget]);

  // Load previous selections when component mounts
  useEffect(() => {
    if (conversation && conversation.conversation_id) {
      loadPreviousSelections();
    }
  }, [conversation, loadWidget]);

  useEffect(() => {
    const checkForData = async () => {
      try {
        const topicPrioritizeResponse = await PolisNet.polisGet(
          '/participation/topicPrioritize',
          { conversation_id }
        );
        
        if (topicPrioritizeResponse) {
          const topicPrioritizeData = topicPrioritizeResponse;
          if (topicPrioritizeData.has_report && topicPrioritizeData.report_id) {
            PolisNet.polisGet('/delphi', { report_id: topicPrioritizeData.report_id })
              .then((response) => {
                if (response && response.status === "success") {
                  if (response.runs && Object.keys(response.runs).length > 0) {
                    // do nothing
                  } else {
                    setError("No LLM topic data available yet. Run Delphi analysis first.");
                  }
                } else {
                  setError("Failed to retrieve topic data");
                }
    
                setIsLoading(false);
              })
              .catch((err) => {
                console.error("Error fetching topic data:", err);
                setError("Failed to connect to the topicMod endpoint");
                setIsLoading(false);
              });
          } else {
            setError("Failed to retrieve topic data");
          }
        }
      } catch (error) {
        setError("Failed to retrieve topic data");
      } finally {
        setIsLoading(false);
      }
    };
    checkForData();
  }, []);

  const loadPreviousSelections = async () => {
    try {
      const result = await PolisNet.polisGet(
        '/topicAgenda/selections',
        { conversation_id: conversation.conversation_id }
      );
      if (result.status === 'success' && result.data) {
        const storedSelections = new Set();
        result.data.archetypal_selections.forEach((selection) => {
          storedSelections.add(selection.topic_key);
        });
        setSelections(storedSelections);
        console.log('Loaded previous selections:', Array.from(storedSelections));
      }
    } catch (error) {
      console.error('Error loading previous selections:', error);
    }
  };

  const toggleTopicSelection = (topicKey) => {
    const newSelections = new Set(selections);
    if (newSelections.has(topicKey)) {
      newSelections.delete(topicKey);
    } else {
      newSelections.add(topicKey);
    }
    setSelections(newSelections);
  };

  const handleDone = async () => {
    try {
      // Convert topic selections to archetypal comments
      console.log("Selected topics:", Array.from(selections));
      
      // Extract archetypal comments from selections
      const archetypes = extractArchetypalComments(selections, topicData, clusterGroups, commentMap);
      console.log("Extracted archetypes:", archetypes);
      
      // Log in a more readable format
      console.log("\n=== SELECTED ARCHETYPAL COMMENTS ===");
      archetypes.forEach(group => {
        console.log(`\nTopic: Layer ${group.layerId}, Cluster ${group.clusterId}`);
        group.archetypes.forEach((archetype, i) => {
          console.log(`  ${i + 1}. "${archetype.text}" (ID: ${archetype.commentId})`);
        });
      });
      console.log("=====================================\n");
      
      // Transform to API format
      const apiSelections = archetypes.map(group => ({
        layer_id: group.layerId,
        cluster_id: group.clusterId,
        topic_key: group.topicKey,
        archetypal_comments: group.archetypes.map(a => ({
          comment_id: a.commentId,
          comment_text: a.text,
          coordinates: a.coordinates,
          distance_to_centroid: a.distance
        }))
      }));
      
      // Send to API (token storage handled centrally in PolisNet)
      const result = await PolisNet.polisPost(
        '/topicAgenda/selections',
        {
          conversation_id: conversation.conversation_id,
          selections: apiSelections,
        }
      );
      
      if (result.status === 'success') {
        console.log('Topic agenda selections saved successfully:', result.data);
        // TODO: Show success UI feedback
      } else {
        console.error('Failed to save selections:', result.message);
        // TODO: Show error UI feedback
      }
      
    } catch (error) {
      console.error('Error saving topic agenda selections:', error);
      // TODO: Show error UI feedback
    }
  };

  if (isLoading || err || inviteCodeRequired) {
    return null;
  }

  if (!isLoading && err) {
    return null;
  }

  if (!loadWidget && !isLoading && !err) {
    return (
      <div 
        style={{ 
          height: '195px', 
          border: '1px solid #e0e0e0', 
          borderRadius: '8px',
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          backgroundColor: '#f9f9f9'
        }}
      >
        <button 
          onClick={() => setLoadWidget(true)}
          style={{ 
            padding: '12px 24px', 
            fontSize: '16px',
            cursor: 'pointer',
            border: '1px solid #ccc',
            borderRadius: '4px'
          }}
        >
          Select Topics
        </button>
      </div>
    );
  }


  // Render conditionally after all hooks are called
  let content = null;

  if (error) {
    content = (
      <div className="topic-agenda-widget">
        <div className="error-message">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  } else if (comments.length > 0 && Object.keys(reportData).length > 0) {
    content = (
      <div className="topic-agenda-widget">
        <div className="current-layer">
          <LayerHeader />
          
          <ScrollableTopicsGrid
            topicData={topicData}
            selections={selections}
            onToggleSelection={toggleTopicSelection}
            clusterGroups={clusterGroups}
            hierarchyAnalysis={hierarchyAnalysis}
          />
          
          <div className="done-button-container">
            <button 
              className="done-button"
              onClick={handleDone}
              disabled={selections.size === 0}
            >
              Done ({selections.size} selected)
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Always return the same component structure
  if (!content) return null;

  return (
    <div className="topic-agenda">
      {content}
      <TopicAgendaStyles />
    </div>
  );

};

export default TopicAgenda;