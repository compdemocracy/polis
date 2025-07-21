import { calculateClusterCentroid, calculateDistance } from './topicUtils';

// Get filtered topics for current layer based on spatial proximity to banked topics
export const getFilteredTopics = (allTopics, layerId, hierarchyAnalysis, bankedTopics, clusterGroups) => {
  const maxLayer = hierarchyAnalysis ? Math.max(...hierarchyAnalysis.layers) : layerId;

  if (layerId === maxLayer || bankedTopics.size === 0) {
    return Object.entries(allTopics).map(([clusterId, topic]) => ({
      clusterId,
      topic,
      proximityScore: null,
      source: 'all'
    }));
  }

  // For subsequent layers, filter based on proximity to banked topics
  const higherLayerId = layerId + 1;
  const bankedFromHigherLayer = bankedTopics.get(higherLayerId);

  if (!bankedFromHigherLayer || !clusterGroups[higherLayerId] || !clusterGroups[layerId]) {
    return Object.entries(allTopics).map(([clusterId, topic]) => ({
      clusterId,
      topic,
      proximityScore: null,
      source: 'all'
    }));
  }

  // Calculate proximity to banked topics
  const adaptiveDistance = 4.0;

  const topicsWithProximity = Object.entries(allTopics).map(([clusterId, topic]) => {
    const clusterKey = `${layerId}_${clusterId}`;
    const targetPoints = clusterGroups[layerId].get(clusterKey);

    let minProximity = Infinity;
    let closestBankedTopic = null;

    if (targetPoints && targetPoints.length > 0) {
      const targetCentroid = calculateClusterCentroid(targetPoints);
      if (targetCentroid) {
        // Check distance to each banked topic
        bankedFromHigherLayer.forEach(bankedTopicKey => {
          // Extract cluster info from topic key
          let bankedClusterId;
          if (bankedTopicKey.includes('#')) {
            // Format: "2_uuid#2#6" -> clusterId = "6"
            const parts = bankedTopicKey.split('#');
            bankedClusterId = parts[parts.length - 1];
          } else if (bankedTopicKey.includes('_')) {
            // Format: "2_6" -> clusterId = "6"
            const parts = bankedTopicKey.split('_');
            bankedClusterId = parts[parts.length - 1];
          }

          const bankedClusterKey = `${higherLayerId}_${bankedClusterId}`;
          const bankedPoints = clusterGroups[higherLayerId].get(bankedClusterKey);

          if (bankedPoints && bankedPoints.length > 0) {
            const bankedCentroid = calculateClusterCentroid(bankedPoints);
            if (bankedCentroid) {
              const distance = calculateDistance(targetCentroid, bankedCentroid);
              if (distance < minProximity) {
                minProximity = distance;
                closestBankedTopic = bankedClusterKey;
              }
            }
          }
        });
      }
    }

    const finalScore = minProximity === Infinity ? null : minProximity;

    return {
      clusterId,
      topic,
      proximityScore: finalScore,
      closestBankedTopic: closestBankedTopic,
      source: (minProximity !== Infinity && minProximity <= adaptiveDistance) ? 'close' : 'far'
    };
  });

  // For coarsest and second coarsest layers: show all topics, just sort by proximity
  // For finest layers: apply the proximity filtering and hide nulls
  let filteredTopics;
  if (layerId === maxLayer - 1) {
    // Second coarsest layer: show all topics
    filteredTopics = topicsWithProximity;
  } else {
    // Finest layers: apply proximity filtering and hide topics without distance data
    filteredTopics = topicsWithProximity.filter(item =>
      item.source === 'close'
    );
  }

  // Sort by proximity score (closest first, then nulls at end)
  const sortedTopics = filteredTopics.sort((a, b) => {
    if (a.proximityScore === null && b.proximityScore === null) return 0;
    if (a.proximityScore === null) return 1;
    if (b.proximityScore === null) return -1;
    return a.proximityScore - b.proximityScore;
  });

  return sortedTopics;
};