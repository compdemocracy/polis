import React from "react";
import { getCommentCount, cleanTopicDisplayName } from "../utils/topicUtils";

const TopicItem = ({ 
  entry, 
  layerId, 
  isSelected, 
  onToggleSelection, 
  clusterGroups,
  isBanked = false 
}) => {
  const { clusterId, topic, proximityScore, closestBankedTopic } = entry;
  const topicKey = topic.topic_key;
  const commentCount = getCommentCount(layerId, clusterId, clusterGroups);
  const displayName = cleanTopicDisplayName(topic.topic_name, layerId, clusterId);

  return (
    <div 
      className={`topic-item ${
        isBanked ? 'banked-brick' : 
        isSelected ? 'selected brick' : 'unselected'
      }`}
      onClick={isBanked ? undefined : () => onToggleSelection(topicKey)}
    >
      <div className="topic-content">
        <span className="topic-text">{displayName}</span>
        {isSelected && (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="topic-checkmark">
            <circle cx="10" cy="10" r="10" fill="#03a9f4"/>
            <path d="M6 10L9 13L14 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>
    </div>
  );
};

export default TopicItem;