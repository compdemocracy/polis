import React, { useState, useEffect, useRef } from "react";
import net from "../../util/net";
import { useReportId } from "../framework/useReportId";
import CommentList from "../lists/commentList.jsx";

const TopicPrioritize = ({ math, comments, conversation, ptptCount, formatTid, voteColors }) => {
  const { report_id } = useReportId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [topicData, setTopicData] = useState(null);
  const [hierarchyAnalysis, setHierarchyAnalysis] = useState(null);
  const [currentLayer, setCurrentLayer] = useState(null); // Will be set to highest available layer
  const [topicPriorities, setTopicPriorities] = useState(new Map()); // Store topic priorities
  const [selectedTopics, setSelectedTopics] = useState(new Set()); // Track selected topics for filtering
  const [umapData, setUmapData] = useState(null); // UMAP coordinates for spatial filtering
  const [clusterGroups, setClusterGroups] = useState({}); // Points grouped by layer and cluster
  const [spatialMode, setSpatialMode] = useState('subset'); // 'subset' or 'sort'

  useEffect(() => {
    if (!report_id) return;

    setLoading(true);
    // Fetch topic data from Delphi endpoint (same as CommentsReport)
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("TopicMod topics response:", response);

        if (response && response.status === "success") {
          if (response.runs && Object.keys(response.runs).length > 0) {
            setTopicData(response);
            analyzeHierarchy(response);
            // Fetch UMAP data for spatial filtering
            fetchUMAPData();
          } else {
            setError("No LLM topic data available yet. Run Delphi analysis first.");
          }
        } else {
          setError("Failed to retrieve topic data");
        }

        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching topic data:", err);
        setError("Failed to connect to the topicMod endpoint");
        setLoading(false);
      });
  }, [report_id]);

  // Fetch UMAP coordinates for spatial filtering
  const fetchUMAPData = async () => {
    try {
      const conversationId = conversation?.conversation_id || report_id;
      console.log("Fetching UMAP data for spatial filtering...");
      
      const response = await fetch(`/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`);
      const data = await response.json();
      
      if (data.status === "success" && data.proximity_data) {
        console.log(`Loaded ${data.proximity_data.length} UMAP points for spatial filtering`);
        setUmapData(data.proximity_data);
        
        // Group points by layer and cluster
        const groups = groupPointsByLayer(data.proximity_data);
        setClusterGroups(groups);
        
        console.log("UMAP cluster groups:", groups);
      } else {
        console.log("No UMAP data available for spatial filtering");
      }
    } catch (err) {
      console.error("Error fetching UMAP data:", err);
    }
  };

  // Analyze if topics actually contain each other hierarchically
  const analyzeHierarchy = (data) => {
    // Get the first (most recent) run
    const runKeys = Object.keys(data.runs);
    if (runKeys.length === 0) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: "No runs data" });
      return;
    }

    const firstRun = data.runs[runKeys[0]];
    if (!firstRun.topics_by_layer) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: "No topics_by_layer data in run" });
      return;
    }

    const layers = Object.keys(firstRun.topics_by_layer).map(k => parseInt(k)).sort((a, b) => a - b);
    console.log("Analyzing layers:", layers);
    
    // Set current layer to the highest available layer if not set
    if (currentLayer === null && layers.length > 0) {
      const maxLayer = Math.max(...layers);
      setCurrentLayer(maxLayer);
      console.log(`Setting current layer to highest available: ${maxLayer}`);
    }

    // For now, let's investigate what the data structure looks like
    const analysis = {
      hasHierarchy: false, // We'll determine this
      layers: layers,
      layerCounts: {},
      sampleTopics: {},
      totalComments: 0,
      structure: "unknown", // Will be "flat", "hierarchical", or "mixed"
      runInfo: {
        model_name: firstRun.model_name,
        created_at: firstRun.created_at,
        job_uuid: firstRun.job_uuid
      }
    };

    layers.forEach(layerId => {
      const topics = firstRun.topics_by_layer[layerId];
      analysis.layerCounts[layerId] = Object.keys(topics).length;
      
      // Take first few topics as samples
      analysis.sampleTopics[layerId] = Object.values(topics).slice(0, 3).map(topic => ({
        name: topic.topic_name,
        key: topic.topic_key,
        cluster_id: topic.cluster_id,
        model_name: topic.model_name
      }));
    });

    // Simple heuristic: if we have multiple layers with different counts,
    // it suggests some hierarchical structure
    const counts = Object.values(analysis.layerCounts);
    const hasVariedCounts = Math.max(...counts) !== Math.min(...counts);
    
    if (hasVariedCounts && layers.length > 1) {
      analysis.hasHierarchy = true;
      analysis.structure = "hierarchical";
      analysis.reason = `Found ${layers.length} layers with varying topic counts: ${counts.join(", ")}`;
    } else if (layers.length === 1) {
      analysis.structure = "flat";
      analysis.reason = "Only one layer found - flat structure";
    } else {
      analysis.structure = "unclear";
      analysis.reason = "Multiple layers but similar counts - unclear hierarchy";
    }

    console.log("Hierarchy analysis:", analysis);
    setHierarchyAnalysis(analysis);
  };

  // Set topic priority with cycling
  const cyclePriority = (topicKey) => {
    const currentPriority = topicPriorities.get(topicKey) || 'low';
    let nextPriority;
    
    switch (currentPriority) {
      case 'low': nextPriority = 'medium'; break;
      case 'medium': nextPriority = 'high'; break;
      case 'high': nextPriority = 'critical'; break; // spam
      case 'critical': nextPriority = 'low'; break; // back to start
      default: nextPriority = 'medium';
    }
    
    const newPriorities = new Map(topicPriorities);
    newPriorities.set(topicKey, nextPriority);
    setTopicPriorities(newPriorities);
    console.log(`Topic ${topicKey} cycled to ${nextPriority} - spatial filtering will update`);
    
    // Force re-render of current layer to apply spatial filtering
    setTimeout(() => {
      console.log("Priority change complete, spatial filtering active");
    }, 100);
  };

  // === SPATIAL MATH FUNCTIONS ===
  
  // Calculate cluster centroid in UMAP space
  const calculateClusterCentroid = (clusterPoints) => {
    if (!clusterPoints || clusterPoints.length === 0) return null;
    const centroidX = clusterPoints.reduce((sum, p) => sum + p.umap_x, 0) / clusterPoints.length;
    const centroidY = clusterPoints.reduce((sum, p) => sum + p.umap_y, 0) / clusterPoints.length;
    return { x: centroidX, y: centroidY };
  };

  // Calculate Euclidean distance between two points
  const calculateDistance = (point1, point2) => {
    return Math.sqrt(
      Math.pow(point1.x - point2.x, 2) + 
      Math.pow(point1.y - point2.y, 2)
    );
  };

  // === DENSITY COMPUTATION FUNCTIONS ===

  /**
   * Calculates Gaussian kernel density at a specific point
   */
  const calculateGaussianKernelDensity = (x, y, points, radius = 25, sigma = null) => {
    if (!sigma) {
      sigma = radius / 3; // Default sigma is radius/3
    }
    
    let density = 0;
    
    points.forEach(point => {
      const distance = Math.sqrt((x - point.umap_x) ** 2 + (y - point.umap_y) ** 2);
      
      if (distance <= radius) {
        density += Math.exp(-(distance ** 2) / (2 * sigma ** 2));
      }
    });
    
    return density;
  };

  /**
   * Computes density surface over a grid using Gaussian kernels
   */
  const computeGridDensitySurface = (points, bounds, gridSize = 4, radius = 25, densityThreshold = 0.1) => {
    const densityMap = new Map();
    const sigma = radius / 3;
    
    // Calculate density at grid points
    for (let x = bounds.minX; x < bounds.maxX; x += gridSize) {
      for (let y = bounds.minY; y < bounds.maxY; y += gridSize) {
        let density = 0;
        const gridKey = `${x},${y}`;
        
        points.forEach(point => {
          const distance = Math.sqrt((x - point.umap_x) ** 2 + (y - point.umap_y) ** 2);
          
          if (distance <= radius) {
            density += Math.exp(-(distance ** 2) / (2 * sigma ** 2));
          }
        });
        
        if (density > densityThreshold) {
          densityMap.set(gridKey, density);
        }
      }
    }
    
    return densityMap;
  };

  /**
   * Calculates bounds for a set of points
   */
  const calculatePointBounds = (points, margin = 20) => {
    const xValues = points.map(p => p.umap_x);
    const yValues = points.map(p => p.umap_y);
    
    return {
      minX: Math.min(...xValues) - margin,
      maxX: Math.max(...xValues) + margin,
      minY: Math.min(...yValues) - margin,
      maxY: Math.max(...yValues) + margin
    };
  };

  /**
   * Finds maximum density value in a density map
   */
  const findMaxDensity = (densityMap) => {
    let maxDensity = 0;
    densityMap.forEach(density => {
      if (density > maxDensity) {
        maxDensity = density;
      }
    });
    return maxDensity;
  };

  /**
   * Complete density analysis for a cluster of points
   */
  const analyzeDensity = (points, options = {}) => {
    const {
      gridSize = 4,
      radius = 25,
      densityThreshold = 0.1,
      margin = 20
    } = options;
    
    if (points.length < 2) {
      return null;
    }
    
    // Calculate bounds
    const bounds = calculatePointBounds(points, margin);
    
    // Compute density surface
    const densityMap = computeGridDensitySurface(points, bounds, gridSize, radius, densityThreshold);
    
    if (densityMap.size === 0) {
      return null;
    }
    
    // Find maximum density
    const maxDensity = findMaxDensity(densityMap);
    
    // Calculate centroid
    const centroid = calculateClusterCentroid(points);
    
    return {
      bounds,
      densityMap,
      maxDensity,
      centroid,
      pointCount: points.length
    };
  };

  // Group UMAP points by layer and cluster
  const groupPointsByLayer = (data) => {
    const groups = {};
    
    for (let layer = 0; layer <= 3; layer++) {
      groups[layer] = new Map();
    }
    
    data.forEach(point => {
      Object.entries(point.clusters || {}).forEach(([layerId, clusterId]) => {
        const layer = parseInt(layerId);
        const key = `${layer}_${clusterId}`;
        
        if (!groups[layer].has(key)) {
          groups[layer].set(key, []);
        }
        
        groups[layer].get(key).push({
          comment_id: point.comment_id,
          cluster_id: clusterId,
          layer: layer,
          umap_x: point.umap_x,
          umap_y: point.umap_y,
          weight: point.weight || 1
        });
      });
    });
    
    return groups;
  };

  /**
   * Calculate density overlap between two clusters
   */
  const calculateDensityOverlap = (densityMap1, densityMap2) => {
    let overlapScore = 0;
    let commonGridPoints = 0;
    let totalGridPoints = 0;
    
    // Find maximum densities for normalization
    const maxDensity1 = findMaxDensity(densityMap1);
    const maxDensity2 = findMaxDensity(densityMap2);
    const maxDensity = Math.max(maxDensity1, maxDensity2);
    
    // Check overlap at each grid point where both clusters have density
    densityMap1.forEach((density1, gridKey) => {
      totalGridPoints++;
      if (densityMap2.has(gridKey)) {
        const density2 = densityMap2.get(gridKey);
        // Overlap is the minimum of the two normalized densities
        const normalizedDensity1 = density1 / maxDensity;
        const normalizedDensity2 = density2 / maxDensity;
        overlapScore += Math.min(normalizedDensity1, normalizedDensity2);
        commonGridPoints++;
      }
    });
    
    // Also check points that exist in map2 but not map1
    densityMap2.forEach((density2, gridKey) => {
      if (!densityMap1.has(gridKey)) {
        totalGridPoints++;
      }
    });
    
    // Return overlap as proportion of total possible overlap
    return commonGridPoints > 0 ? overlapScore / commonGridPoints : 0;
  };

  /**
   * Find nearby topics using density-based proximity
   */
  const findNearbyTopicsDensity = (sourceClusters, targetLayerGroups, options = {}) => {
    const {
      overlapThreshold = 0.1,
      fallbackDistance = 0.5,
      useDensity = true
    } = options;
    
    console.log(`🧮 Computing density-based proximity with threshold ${overlapThreshold}`);
    const startTime = performance.now();
    
    const nearbyTopics = new Set();
    let densityComputations = 0;
    let fallbackComputations = 0;
    let logCounter = 0;
    
    sourceClusters.forEach((sourcePoints, sourceKey) => {
      if (!sourcePoints || sourcePoints.length === 0) return;
      
      // Compute density surface for source cluster
      const sourceDensityAnalysis = useDensity ? analyzeDensity(sourcePoints) : null;
      
      if (sourceDensityAnalysis) {
        densityComputations++;
        
        // Check overlap with each target cluster
        targetLayerGroups.forEach((targetPoints, targetKey) => {
          if (!targetPoints || targetPoints.length === 0) return;
          
          const targetDensityAnalysis = analyzeDensity(targetPoints);
          
          if (targetDensityAnalysis) {
            const overlapScore = calculateDensityOverlap(
              sourceDensityAnalysis.densityMap, 
              targetDensityAnalysis.densityMap
            );
            
            // Debug: Show density map details for first few comparisons
            if (logCounter < 3) {
              console.log(`🔍 DENSITY DEBUG: ${sourceKey} has ${sourceDensityAnalysis.densityMap.size} grid points, ${targetKey} has ${targetDensityAnalysis.densityMap.size} grid points`);
              console.log(`🔍 DENSITY DEBUG: ${sourceKey} bounds:`, sourceDensityAnalysis.bounds);
              console.log(`🔍 DENSITY DEBUG: ${targetKey} bounds:`, targetDensityAnalysis.bounds);
              console.log(`🔍 DENSITY DEBUG: ${sourceKey} max density: ${sourceDensityAnalysis.maxDensity.toFixed(3)}`);
              console.log(`🔍 DENSITY DEBUG: ${targetKey} max density: ${targetDensityAnalysis.maxDensity.toFixed(3)}`);
            }
            
            if (overlapScore > overlapThreshold) {
              nearbyTopics.add(targetKey);
              if (logCounter < 10) {
                console.log(`✅ Density overlap: ${sourceKey} → ${targetKey} (score: ${overlapScore.toFixed(3)})`);
              }
            } else {
              if (logCounter < 10) {
                console.log(`❌ Low overlap: ${sourceKey} → ${targetKey} (score: ${overlapScore.toFixed(3)}, threshold: ${overlapThreshold})`);
              }
            }
            logCounter++;
          }
        });
      } else {
        // Fallback to centroid-based distance
        fallbackComputations++;
        const sourceCentroid = calculateClusterCentroid(sourcePoints);
        
        if (sourceCentroid) {
          targetLayerGroups.forEach((targetPoints, targetKey) => {
            const targetCentroid = calculateClusterCentroid(targetPoints);
            if (targetCentroid) {
              const distance = calculateDistance(sourceCentroid, targetCentroid);
              if (distance <= fallbackDistance) {
                nearbyTopics.add(targetKey);
                console.log(`⚡ Fallback distance: ${sourceKey} → ${targetKey} (distance: ${distance.toFixed(3)})`);
              }
            }
          });
        }
      }
    });
    
    const elapsed = performance.now() - startTime;
    console.log(`🧮 Density computation complete: ${elapsed.toFixed(1)}ms, ${densityComputations} density, ${fallbackComputations} fallback`);
    
    return nearbyTopics;
  };

  // Legacy function for backward compatibility
  const findNearbyTopics = (sourceCentroids, targetLayerGroups, maxDistance = 0.5) => {
    const nearbyTopics = new Set();
    
    sourceCentroids.forEach(sourceCentroid => {
      targetLayerGroups.forEach((points, clusterKey) => {
        const targetCentroid = calculateClusterCentroid(points);
        if (targetCentroid) {
          const distance = calculateDistance(sourceCentroid, targetCentroid);
          if (distance <= maxDistance) {
            nearbyTopics.add(clusterKey);
          }
        }
      });
    });
    
    return nearbyTopics;
  };

  // Toggle topic selection for filtering
  const toggleTopicSelection = (topicKey) => {
    const newSelected = new Set(selectedTopics);
    if (newSelected.has(topicKey)) {
      newSelected.delete(topicKey);
    } else {
      newSelected.add(topicKey);
    }
    setSelectedTopics(newSelected);
  };

  // Get priority color
  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'low': return '#d6d8db';
      case 'medium': return '#e2e6ea';
      case 'high': return '#d1d5db';
      case 'critical': return '#f0a7ab';
      default: return '#e9ecef';
    }
  };

  // Get priority indicator
  const getPriorityIndicator = (priority) => {
    switch (priority) {
      case 'low': return '· LOW';
      case 'medium': return '•• MEDIUM';
      case 'high': return '••• HIGH';
      case 'critical': return '🗑 SPAM/TRASH';
      default: return '· LOW';
    }
  };

  // Get comment count for a cluster
  const getCommentCount = (layerId, clusterId) => {
    const clusterKey = `${layerId}_${clusterId}`;
    const points = clusterGroups[layerId]?.get(clusterKey);
    return points ? points.length : 0;
  };


  // Get filtered/sorted topics based on spatial proximity
  const getFilteredTopics = (allTopics, layerId) => {
    // For highest layer (coarsest), show all topics
    const maxLayer = hierarchyAnalysis ? Math.max(...hierarchyAnalysis.layers) : layerId;
    if (layerId === maxLayer || !clusterGroups[layerId] || !umapData) {
      return Object.entries(allTopics).map(([clusterId, topic]) => ({
        clusterId,
        topic,
        proximityScore: null
      }));
    }

    // For other layers, filter based on spatial proximity to higher priority topics
    const higherLayerId = layerId + 1;
    const higherLayerTopics = topicData?.runs[Object.keys(topicData.runs)[0]]?.topics_by_layer[higherLayerId];
    
    if (!higherLayerTopics || !clusterGroups[higherLayerId]) {
      return Object.entries(allTopics).map(([clusterId, topic]) => ({
        clusterId,
        topic,
        proximityScore: null
      }));
    }

    // Find HIGH and MEDIUM priority clusters in the higher layer
    const priorityClusters = new Map();
    Object.entries(higherLayerTopics).forEach(([clusterId, topic]) => {
      const priority = topicPriorities.get(topic.topic_key);
      if (priority === 'high' || priority === 'medium') {
        const clusterKey = `${higherLayerId}_${clusterId}`;
        const points = clusterGroups[higherLayerId].get(clusterKey);
        if (points && points.length > 0) {
          priorityClusters.set(clusterKey, points);
        }
      }
    });

    // If no high priority topics, show all
    if (priorityClusters.size === 0) {
      return Object.entries(allTopics).map(([clusterId, topic]) => ({
        clusterId,
        topic,
        proximityScore: null
      }));
    }

    console.log(`🎯 Layer ${layerId}: Found ${priorityClusters.size} priority clusters in Layer ${higherLayerId}`);

    // Find nearby topics using simple centroid distance with adaptive thresholds
    const getAdaptiveDistance = (layer) => {
      switch (layer) {
        case 0: return 1.5; // Very lenient for finest layer
        case 1: return 1.2; // Lenient for fine layer  
        case 2: return 0.8; // Moderate for mid layer
        default: return 0.5; // Standard for coarse layer
      }
    };
    
    const adaptiveDistance = getAdaptiveDistance(layerId);
    console.log(`🔧 Layer ${layerId}: Using adaptive distance ${adaptiveDistance}`);
    
    // Calculate centroids of priority clusters
    const priorityCentroids = [];
    priorityClusters.forEach((points, clusterKey) => {
      const centroid = calculateClusterCentroid(points);
      if (centroid) {
        priorityCentroids.push(centroid);
      }
    });
    
    // Calculate proximity scores for all topics
    const topicsWithProximity = Object.entries(allTopics).map(([clusterId, topic]) => {
      const clusterKey = `${layerId}_${clusterId}`;
      const targetPoints = clusterGroups[layerId].get(clusterKey);
      
      let minProximity = Infinity;
      let closestCluster = null;
      if (targetPoints && targetPoints.length > 0) {
        const targetCentroid = calculateClusterCentroid(targetPoints);
        if (targetCentroid) {
          // Track which priority cluster is closest
          Array.from(priorityClusters.keys()).forEach(sourceKey => {
            const sourcePoints = priorityClusters.get(sourceKey);
            const sourceCentroid = calculateClusterCentroid(sourcePoints);
            if (sourceCentroid) {
              const distance = calculateDistance(sourceCentroid, targetCentroid);
              if (distance < minProximity) {
                minProximity = distance;
                closestCluster = sourceKey;
              }
            }
          });
        }
      }
      
      return {
        clusterId,
        topic,
        proximityScore: minProximity === Infinity ? null : minProximity,
        closestCluster: closestCluster
      };
    });

    if (spatialMode === 'subset') {
      // Filter mode: only show topics within threshold
      const filteredTopics = topicsWithProximity.filter(item => 
        item.proximityScore !== null && item.proximityScore <= adaptiveDistance
      );
      console.log(`Layer ${layerId}: Filtered from ${Object.keys(allTopics).length} to ${filteredTopics.length} topics based on spatial proximity`);
      return filteredTopics;
    } else {
      // Sort mode: show all topics sorted by proximity
      const sortedTopics = topicsWithProximity.sort((a, b) => {
        if (a.proximityScore === null && b.proximityScore === null) return 0;
        if (a.proximityScore === null) return 1;
        if (b.proximityScore === null) return -1;
        return a.proximityScore - b.proximityScore;
      });
      console.log(`Layer ${layerId}: Sorted ${Object.keys(allTopics).length} topics by spatial proximity`);
      return sortedTopics;
    }
  };

  // Render dense priority selection for current layer
  const renderPriorityLayer = () => {
    if (!topicData || !topicData.runs || !hierarchyAnalysis) {
      return <div className="no-data">No topic data available</div>;
    }

    const runKeys = Object.keys(topicData.runs);
    const firstRun = topicData.runs[runKeys[0]];
    
    if (!firstRun.topics_by_layer || !firstRun.topics_by_layer[currentLayer]) {
      return <div className="no-data">No topics found for layer {currentLayer}</div>;
    }

    const allTopics = firstRun.topics_by_layer[currentLayer];
    const topicEntries = getFilteredTopics(allTopics, currentLayer);
    
    return (
      <div className="priority-layer">
        <div className="layer-header">
          <h2>Layer {currentLayer} Topic Prioritization</h2>
          <div className="layer-subtitle">
            {topicEntries.length} topics{currentLayer < Math.max(...hierarchyAnalysis.layers) ? ` (${spatialMode === 'subset' ? 'filtered' : 'sorted'})` : ''} • Click to prioritize: LOW → MEDIUM → HIGH → SPAM/TRASH
          </div>
        </div>
        
        <div className="topics-grid">
          {topicEntries.map((entry) => {
            const { clusterId, topic, proximityScore, closestCluster } = entry;
            const topicKey = topic.topic_key;
            const currentPriority = topicPriorities.get(topicKey) || 'low'; // Default to 'low'
            const isSelected = selectedTopics.has(topicKey);
            
            // Clean topic name
            let displayName = topic.topic_name;
            const layerClusterPrefix = `${currentLayer}_${clusterId}`;
            if (displayName && displayName.startsWith(layerClusterPrefix)) {
              displayName = displayName.substring(layerClusterPrefix.length).replace(/^:\s*/, '');
            }
            
            return (
              <div 
                key={topicKey} 
                className={`topic-item ${currentPriority}`}
                onClick={() => cyclePriority(topicKey)}
              >
                <div className="topic-content">
                  <div className="topic-header-row">
                    <span className="topic-id">
                      {currentLayer}_{clusterId}
                      {proximityScore !== null && closestCluster && (
                        <span className="proximity-score"> (d: {proximityScore.toFixed(2)} from {closestCluster})</span>
                      )}
                      <span className="comment-count"> ({getCommentCount(currentLayer, clusterId)} comments)</span>
                    </span>
                    <div className="priority-options">
                      {['low', 'medium', 'high', 'critical'].map(priority => (
                        <span 
                          key={priority}
                          className={`priority-option ${currentPriority === priority ? 'active' : ''}`}
                        >
                          {priority === 'low' ? 'LOW' : 
                           priority === 'medium' ? 'MEDIUM' : 
                           priority === 'high' ? 'HIGH' : 
                           'SPAM/TRASH'}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="topic-text">{displayName || `Topic ${clusterId}`}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render layer navigation
  const renderLayerNavigation = () => {
    if (!hierarchyAnalysis) return null;

    return (
      <div className="layer-navigation">
        <div className="filtering-mode-toggle">
          <button
            className={`mode-button ${spatialMode === 'sort' ? 'active' : ''}`}
            onClick={() => setSpatialMode('sort')}
          >
            Always show all topics
          </button>
          <button
            className={`mode-button ${spatialMode === 'subset' ? 'active' : ''}`}
            onClick={() => setSpatialMode('subset')}
          >
            Remove less relevant topics as I rank/prioritize
          </button>
        </div>
        
        <div className="layer-tabs">
          {hierarchyAnalysis.layers.slice().reverse().map(layerId => (
            <button
              key={layerId}
              className={`layer-tab ${currentLayer === layerId ? 'active' : ''}`}
              onClick={() => setCurrentLayer(layerId)}
            >
              <div className="tab-number">L{layerId}</div>
              <div className="tab-label">
                {layerId === Math.max(...hierarchyAnalysis.layers) ? 'Coarsest' : layerId === Math.min(...hierarchyAnalysis.layers) ? 'Finest' : 'Mid'}
              </div>
              <div className="tab-count">{hierarchyAnalysis.layerCounts[layerId]}</div>
            </button>
          ))}
        </div>
        
        {selectedTopics.size > 0 && (
          <div className="selection-summary">
            <div className="selected-count">{selectedTopics.size} topics selected for filtering</div>
            <button 
              className="clear-selection"
              onClick={() => setSelectedTopics(new Set())}
            >
              Clear Selection
            </button>
          </div>
        )}
      </div>
    );
  };

  // Render compact hierarchy analysis (moved to bottom)
  const renderCompactAnalysis = () => {
    if (!hierarchyAnalysis) return null;

    return (
      <div className="compact-analysis">
        <h4>Topic Structure Overview</h4>
        <div className="analysis-summary">
          <span className="structure-type">{hierarchyAnalysis.structure.toUpperCase()}</span>
          <span className="layer-breakdown">
            {hierarchyAnalysis.layers.map(layerId => 
              `L${layerId}:${hierarchyAnalysis.layerCounts[layerId]}`
            ).join(' • ')}
          </span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="topic-prioritize">
        <h1>Topic Prioritize</h1>
        <div className="loading">Loading topic data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="topic-prioritize">
        <h1>Topic Prioritize</h1>
        <div className="error-message">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="topic-prioritize">
      {renderLayerNavigation()}
      
      <div className="main-content">
        {renderPriorityLayer()}
      </div>


      <style jsx>{`
        .topic-prioritize {
          padding: 10px;
          max-width: 100%;
          margin: 0 auto;
          background: #f8f9fa;
          min-height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }


        .layer-navigation {
          background: white;
          border-radius: 8px;
          padding: 10px;
          margin-bottom: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .filtering-mode-toggle {
          margin-bottom: 12px;
          display: flex;
          gap: 8px;
          background: #f8f9fa;
          padding: 8px;
          border-radius: 6px;
          border: 1px solid #e9ecef;
        }

        .mode-button {
          padding: 8px 12px;
          border: 1px solid #dee2e6;
          border-radius: 4px;
          background: white;
          color: #6c757d;
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 0.2s ease, color 0.2s ease;
          text-align: center;
        }

        .mode-button:hover {
          background: #f8f9fa;
        }

        .mode-button.active {
          background: #6c757d;
          color: white;
        }


        .layer-tabs {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .layer-tab {
          flex: 1;
          min-width: 80px;
          background: #f8f9fa;
          border: 2px solid #e9ecef;
          border-radius: 8px;
          padding: 10px 8px;
          cursor: pointer;
          text-align: center;
          transition: all 0.2s ease;
        }

        .layer-tab.active {
          background: #6c757d;
          border-color: #6c757d;
          color: white;
        }

        .layer-tab:hover {
          border-color: #6c757d;
          background: #f8f9fa;
        }

        .tab-number {
          font-weight: 700;
          font-size: 1.1rem;
        }

        .tab-label {
          font-size: 0.75rem;
          margin: 2px 0;
        }

        .tab-count {
          font-size: 0.8rem;
          opacity: 0.8;
        }

        .selection-summary {
          margin-top: 15px;
          padding: 10px;
          background: #e3f2fd;
          border-radius: 6px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .selected-count {
          font-size: 0.9rem;
          color: #1e7dff;
          font-weight: 500;
        }

        .clear-selection {
          background: #ff4757;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.8rem;
        }

        .main-content {
          margin-bottom: 8px;
        }

        .priority-layer {
          background: white;
          border-radius: 8px;
          padding: 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .layer-header h2 {
          margin: 0 0 3px 0;
          color: #333;
          font-size: 1.2rem;
        }

        .layer-subtitle {
          color: #666;
          font-size: 0.85rem;
          margin-bottom: 12px;
        }

        .topics-grid {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        @media (min-width: 1200px) {
          .topics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 8px;
          }
        }

        .topic-item {
          background: white;
          border-left: 6px solid #e9ecef;
          padding: 8px 12px;
          cursor: pointer;
          transition: all 0.2s ease;
          margin-bottom: 2px;
        }

        .topic-item:hover {
          background: #f8f9fa;
        }

        .topic-item.low {
          border-left-color: #dee2e6;
        }

        .topic-item.medium {
          border-left-color: #6c757d;
        }

        .topic-item.high {
          border-left-color: #343a40;
        }

        .topic-item.critical {
          border-left-color: #dc3545;
        }

        .topic-content {
          width: 100%;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
        }

        .topic-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 4px;
        }

        .topic-id {
          color: #6c757d;
          font-size: 0.8rem;
          font-weight: 600;
          letter-spacing: -0.01em;
          min-width: 40px;
        }

        .proximity-score {
          color: #6c757d;
          font-size: 0.7rem;
          font-weight: 400;
        }

        .comment-count {
          color: #6c757d;
          font-size: 0.7rem;
          font-weight: 400;
        }

        .priority-options {
          display: flex;
          gap: 6px;
        }

        .priority-option {
          font-size: 0.65rem;
          color: #dee2e6;
          font-weight: 500;
          padding: 1px 3px;
          border-radius: 2px;
          transition: all 0.15s ease;
          letter-spacing: 0.01em;
        }

        .priority-option.active {
          font-weight: 700;
        }

        .priority-option:nth-child(1).active {
          background: #f8f9fa;
          color: #adb5bd;
        }

        .priority-option:nth-child(2).active {
          background: #6c757d;
          color: white;
        }

        .priority-option:nth-child(3).active {
          background: #343a40;
          color: white;
        }

        .priority-option:nth-child(4).active {
          background: #dc3545;
          color: white;
        }

        .topic-text {
          color: #212529;
          font-size: 1.1rem;
          line-height: 1.3;
          font-weight: 500;
          margin: 0;
          letter-spacing: -0.01em;
        }


        .no-data {
          text-align: center;
          padding: 40px;
          color: #666;
          font-style: italic;
        }

        .loading, .error-message {
          text-align: center;
          padding: 40px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .error-message {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
        }

        .loading {
          font-size: 1.1rem;
          color: #666;
        }

        /* Mobile responsiveness */
        @media (max-width: 768px) {
          .topics-grid {
            grid-template-columns: 1fr;
          }
          
          .layer-tabs {
            justify-content: center;
          }
          
          .layer-tab {
            min-width: 70px;
          }
          
          .compact-header h1 {
            font-size: 1.5rem;
          }
          
          .analysis-summary {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
          }
        }
      `}</style>
    </div>
  );
};

export default TopicPrioritize;