import React, { useEffect, useState } from "react";
import { useReportId } from "../framework/useReportId";
import { useTopicData } from "./hooks/useTopicData";
import { extractArchetypalComments, serializeArchetypes } from "./utils/archetypeExtraction";
import LayerHeader from "./components/LayerHeader";
import ScrollableTopicsGrid from "./components/ScrollableTopicsGrid";
import TopicAgendaStyles from "./components/TopicAgendaStyles";

const TopicAgenda = ({ conversation, comments }) => {
  const { report_id } = useReportId();
  const {
    loading,
    error,
    topicData,
    hierarchyAnalysis,
    clusterGroups,
    fetchUMAPData
  } = useTopicData(report_id);
  
  const [selections, setSelections] = useState(new Set());
  const [commentMap, setCommentMap] = useState(new Map());

  // Build comment map for easy lookup
  useEffect(() => {
    if (comments && comments.length > 0) {
      const map = new Map();
      comments.forEach(comment => {
        // Store by both tid (as number) and as string for flexibility
        map.set(comment.tid, comment.txt);
        map.set(String(comment.tid), comment.txt);
      });
      setCommentMap(map);
      console.log(`Built comment map with ${map.size / 2} comments`);
    }
  }, [comments]);

  // Fetch UMAP data when topic data is loaded
  useEffect(() => {
    if (topicData && conversation) {
      fetchUMAPData(conversation);
    }
  }, [topicData, conversation, fetchUMAPData]);

  // Load previous selections when component mounts
  useEffect(() => {
    if (conversation && conversation.conversation_id) {
      loadPreviousSelections();
    }
  }, [conversation]);

  const loadPreviousSelections = async () => {
    try {
      const response = await fetch(`/api/v3/topicAgenda/selections?conversation_id=${conversation.conversation_id}`, {
        method: 'GET',
        credentials: 'include'
      });
      
      const result = await response.json();
      
      if (result.status === 'success' && result.data) {
        // Convert stored selections back to topic keys
        const storedSelections = new Set();
        result.data.archetypal_selections.forEach(selection => {
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
      
      // Send to API
      const response = await fetch('/api/v3/topicAgenda/selections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: conversation.conversation_id,
          selections: apiSelections
        }),
        credentials: 'include'
      });
      
      const result = await response.json();
      
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

  if (loading) {
    return (
      <div className="topic-agenda">
        <div className="topic-agenda-widget">
          <div className="loading">Loading topic data...</div>
        </div>
        <TopicAgendaStyles />
      </div>
    );
  }

  if (error) {
    return (
      <div className="topic-agenda">
        <div className="topic-agenda-widget">
          <div className="error-message">
            <h3>Error</h3>
            <p>{error}</p>
          </div>
        </div>
        <TopicAgendaStyles />
      </div>
    );
  }

  return (
    <div className="topic-agenda">
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
      <TopicAgendaStyles />
    </div>
  );
};

export default TopicAgenda;