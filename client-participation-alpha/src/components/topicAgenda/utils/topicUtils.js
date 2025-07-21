// Calculate cluster centroid in UMAP space
export const calculateClusterCentroid = (clusterPoints) => {
  if (!clusterPoints || clusterPoints.length === 0) return null;
  const centroidX = clusterPoints.reduce((sum, p) => sum + p.umap_x, 0) / clusterPoints.length;
  const centroidY = clusterPoints.reduce((sum, p) => sum + p.umap_y, 0) / clusterPoints.length;
  return { x: centroidX, y: centroidY };
};

// Calculate Euclidean distance between two points
export const calculateDistance = (point1, point2) => {
  return Math.sqrt(
    Math.pow(point1.x - point2.x, 2) +
    Math.pow(point1.y - point2.y, 2)
  );
};

// Get comment count for a cluster
export const getCommentCount = (layerId, clusterId, clusterGroups) => {
  const clusterKey = `${layerId}_${clusterId}`;
  const points = clusterGroups[layerId]?.get(clusterKey);
  return points ? points.length : 0;
};

// Clean topic display name by removing layer/cluster prefix
export const cleanTopicDisplayName = (topicName, layerId, clusterId) => {
  if (!topicName) return `Topic ${clusterId}`;
  
  const layerClusterPrefix = `${layerId}_${clusterId}`;
  if (topicName.startsWith(layerClusterPrefix)) {
    return topicName.substring(layerClusterPrefix.length).replace(/^:\s*/, '');
  }
  return topicName;
};