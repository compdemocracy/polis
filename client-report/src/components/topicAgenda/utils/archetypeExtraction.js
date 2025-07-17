import { calculateClusterCentroid, calculateDistance } from './topicUtils';

/**
 * Extract archetypal comments from topic selections
 * These serve as stable anchor points across Delphi runs
 * 
 * STRATEGY:
 * 1. For each selected topic, find its cluster in UMAP space
 * 2. Identify the most representative comments (archetypes)
 * 3. Return comment IDs that persist across topic model updates
 * 
 * WHY THIS MATTERS:
 * - Topic names/clusters change between Delphi runs
 * - But the underlying comments remain stable
 * - By storing comment IDs instead of topic IDs, we maintain consistency
 * - These archetypal comments represent what users actually care about
 */
export const extractArchetypalComments = (selections, topicData, clusterGroups, commentMap = new Map()) => {
  const archetypeComments = [];
  
  // Parse selections to extract layer and cluster info
  selections.forEach(topicKey => {
    // Topic key formats:
    // Old: "4c5b018b-51ac-4a3e-9d41-6307a73ebf68#2#3"
    // New: "layer3_9"
    
    let layerId, clusterId;
    
    if (topicKey.startsWith('layer')) {
      // New format: "layer3_9"
      const match = topicKey.match(/layer(\d+)_(\d+)/);
      if (match) {
        layerId = parseInt(match[1]);
        clusterId = match[2];
      }
    } else {
      // Old format with # separators
      const parts = topicKey.split('#');
      if (parts.length >= 3) {
        layerId = parseInt(parts[parts.length - 2]);
        clusterId = parts[parts.length - 1];
      }
    }
    
    if (layerId !== undefined && clusterId !== undefined) {
      
      // Find the cluster in clusterGroups
      const clusterKey = `${layerId}_${clusterId}`;
      const clusterPoints = clusterGroups[layerId]?.get(clusterKey);
      
      if (clusterPoints && clusterPoints.length > 0) {
        // Strategy 1: Get comments closest to cluster centroid
        const centroid = calculateClusterCentroid(clusterPoints);
        
        if (centroid) {
          // Sort points by distance to centroid
          const sortedPoints = clusterPoints
            .map(point => ({
              ...point,
              distanceToCentroid: calculateDistance(
                { x: point.umap_x, y: point.umap_y },
                centroid
              )
            }))
            .sort((a, b) => a.distanceToCentroid - b.distanceToCentroid);
          
          // Take the top N most central comments as archetypes
          const numArchetypes = Math.min(3, sortedPoints.length);
          const archetypes = sortedPoints.slice(0, numArchetypes);
          
          archetypeComments.push({
            topicKey,
            layerId,
            clusterId,
            archetypes: archetypes.map(a => {
              // Try to get comment text from the map (comment_id might be string or number)
              const commentText = commentMap.get(a.comment_id) || 
                                commentMap.get(parseInt(a.comment_id)) ||
                                commentMap.get(String(a.comment_id)) ||
                                a.comment_text || 
                                `[Comment ${a.comment_id}]`;
              console.log(`Archetype comment ${a.comment_id}: "${commentText}"`);
              return {
                commentId: a.comment_id,
                text: commentText,
                distance: a.distanceToCentroid,
                coordinates: { x: a.umap_x, y: a.umap_y }
              };
            })
          });
        } else {
          console.log(`No cluster points found for ${clusterKey}`);
        }
      } else {
        console.log(`No cluster points found for layer ${layerId}, cluster ${clusterId}`);
      }
    }
  });
  
  return archetypeComments;
};

/**
 * Convert archetypal comments to a format suitable for storage
 * This creates a stable representation that survives Delphi re-runs
 */
export const serializeArchetypes = (archetypeComments) => {
  // Flatten to just comment IDs and their coordinates
  const stableAnchors = [];
  
  archetypeComments.forEach(group => {
    group.archetypes.forEach(archetype => {
      stableAnchors.push({
        commentId: archetype.commentId,
        text: archetype.text, // Include text for debugging
        coordinates: archetype.coordinates,
        sourceLayer: group.layerId,
        sourceCluster: group.clusterId
      });
    });
  });
  
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    anchors: stableAnchors,
    totalSelections: archetypeComments.length
  };
};