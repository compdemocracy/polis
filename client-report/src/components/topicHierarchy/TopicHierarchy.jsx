import React, { useState, useEffect, useRef } from "react";
import { useReportId } from "../framework/useReportId";
import { select, selectAll, mouse as d3Mouse } from "d3-selection";
import { scaleLinear, scaleOrdinal } from "d3-scale";
import { extent } from "d3-array";
import { polygonHull } from "d3-polygon";
import { hierarchy, pack } from "d3-hierarchy";

const TopicHierarchy = ({ conversation }) => {
  const { report_id } = useReportId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hierarchyData, setHierarchyData] = useState(null);
  const [umapData, setUmapData] = useState(null);
  const [layerVisibility, setLayerVisibility] = useState({
    0: true,
    1: true,
    2: true,
    3: true
  });
  const [visualizationType, setVisualizationType] = useState('hulls'); // 'density' or 'hulls'
  const [densityLayerVisibility, setDensityLayerVisibility] = useState({
    0: false,
    1: false,
    2: false,
    3: true  // Only layer 3 by default
  });
  const [topicNames, setTopicNames] = useState(new Map());
  const circlePackRef = useRef(null);
  const umapRef = useRef(null);
  const densityRef = useRef(null);

  useEffect(() => {
    if (!report_id) return;
    fetchHierarchyData();
  }, [report_id]);

  // Fetch hierarchical cluster structure from DynamoDB (from TopicPrioritize.jsx - working version)
  const fetchHierarchyData = async () => {
    try {
      // Use the zinvite from conversation data instead of report_id
      const conversationId = conversation?.conversation_id || report_id;
      const response = await fetch(`/api/v3/topicMod/hierarchy?conversation_id=${conversationId}`);
      const data = await response.json();
      
      if (data.status === "success" && data.hierarchy) {
        setHierarchyData(data);
        console.log("Hierarchy data loaded successfully:", data);
        console.log("Setting hierarchyData state with:", data);
        
        // Also fetch topic names for better labeling
        try {
          const topicsResponse = await fetch(`/api/v3/topicMod/topics?conversation_id=${conversationId}`);
          const topicsData = await topicsResponse.json();
          
          if (topicsData.status === "success" && topicsData.topics_by_layer) {
            // Create topic name lookup map from topics_by_layer
            const topicNameMap = new Map();
            Object.entries(topicsData.topics_by_layer).forEach(([layer, topics]) => {
              topics.forEach(topic => {
                const key = `layer${layer}_${topic.cluster_id}`;
                topicNameMap.set(key, topic.topic_name);
              });
            });
            
            // Store topic names in state for density visualization
            setTopicNames(topicNameMap);
            
            // Add topic names to hierarchy
            const addTopicNames = (node) => {
              const key = `layer${node.layer}_${node.clusterId}`;
              if (topicNameMap.has(key)) {
                node.topic_name = topicNameMap.get(key);
              }
              if (node.children) {
                node.children.forEach(addTopicNames);
              }
            };
            
            addTopicNames(data.hierarchy);
          }
        } catch (topicErr) {
          console.log("Could not fetch topic names, proceeding without them:", topicErr);
        }
        
        // Fetch UMAP data for all clusters
        await fetchUMAPData(conversationId);
      } else {
        console.log("No hierarchy data available:", data.message);
        setError("No hierarchy data available");
      }
      setLoading(false);
    } catch (err) {
      console.error("Error fetching hierarchy data:", err);
      setError("Failed to load hierarchy data");
      setLoading(false);
    }
  };

  // Fetch UMAP coordinates for ALL comments
  const fetchUMAPData = async (conversationId) => {
    try {
      console.log("Fetching ALL UMAP coordinates...");
      const response = await fetch(`/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`);
      const data = await response.json();
      
      console.log("CLIENT DEBUG: UMAP response received with", data.proximity_data?.length, "items");
      console.log("CLIENT DEBUG: Response status:", data.status);
      console.log("CLIENT DEBUG: Response message:", data.message);
      
      // Log first few items in detail
      if (data.proximity_data && data.proximity_data.length > 0) {
        console.log("CLIENT DEBUG: First 3 data points:", data.proximity_data.slice(0, 3));
        
        // Check structure of first item
        const firstItem = data.proximity_data[0];
        console.log("CLIENT DEBUG: First item structure:");
        console.log("  - comment_id:", firstItem.comment_id);
        console.log("  - umap_x:", firstItem.umap_x);
        console.log("  - umap_y:", firstItem.umap_y);
        console.log("  - clusters:", firstItem.clusters);
        console.log("  - clusters type:", typeof firstItem.clusters);
        console.log("  - clusters keys:", Object.keys(firstItem.clusters || {}));
      }
      
      if (data.status === "success" && data.proximity_data) {
        // Debug: Check cluster assignments
        const samplePoints = data.proximity_data.slice(0, 5);
        console.log("Sample points with clusters:", samplePoints.map(p => ({
          comment_id: p.comment_id,
          clusters: p.clusters,
          cluster_keys: Object.keys(p.clusters || {}),
          cluster_count: Object.keys(p.clusters || {}).length,
          raw_point: p // Show the whole point structure
        })));
        
        // Count how many points have cluster assignments
        const pointsWithClusters = data.proximity_data.filter(p => Object.keys(p.clusters || {}).length > 0);
        console.log(`Points with cluster assignments: ${pointsWithClusters.length} / ${data.proximity_data.length}`);
        
        if (pointsWithClusters.length === 0) {
          console.log("No cluster assignments found! Using raw coordinates and assigning all to layer 0");
          // Fallback: show all points as layer 0 if no cluster assignments
          const fallbackData = data.proximity_data.map(point => ({
            comment_id: point.comment_id,
            cluster_id: 0,
            layer: 0,
            umap_x: point.umap_x,
            umap_y: point.umap_y,
            weight: point.weight
          }));
          console.log("Fallback data:", fallbackData.length, "points");
          console.log("Sample fallback point:", fallbackData[0]);
          setUmapData(fallbackData);
          return;
        }
        
        // Process the data to create points for each layer based on cluster assignments
        const processedData = [];
        
        data.proximity_data.forEach(point => {
          // Create a point for each layer where this comment has a cluster assignment
          Object.entries(point.clusters || {}).forEach(([layerId, clusterId]) => {
            processedData.push({
              comment_id: point.comment_id,
              cluster_id: clusterId,
              layer: parseInt(layerId),
              umap_x: point.umap_x,
              umap_y: point.umap_y,
              weight: point.weight
            });
          });
        });
        
        console.log("UMAP data loaded:", processedData.length, "layer-comment assignments");
        console.log("Raw comments:", data.proximity_data.length);
        console.log("Sample processed point:", processedData[0]);
        setUmapData(processedData);
      } else {
        console.log("No UMAP data:", data.message);
        setUmapData([]);
      }
    } catch (err) {
      console.error("Error fetching UMAP data:", err);
    }
  };

  // Toggle layer visibility
  const toggleLayerVisibility = (layerId) => {
    setLayerVisibility(prev => ({
      ...prev,
      [layerId]: !prev[layerId]
    }));
  };

  // Toggle density layer visibility
  const toggleDensityLayerVisibility = (layerId) => {
    setDensityLayerVisibility(prev => ({
      ...prev,
      [layerId]: !prev[layerId]
    }));
  };

  // Create UMAP spatial visualization with Canvas for performance
  const createUMAPVisualization = () => {
    if (!umapData || !umapRef.current) return;
    
    if (umapData.length === 0) {
      console.log("No UMAP data to visualize");
      return;
    }

    console.log("Creating Canvas UMAP visualization with", umapData.length, "points");

    // Generate colors similar to datamapplot's approach
    const generateClusterColor = (clusterId, layer) => {
      // Use a color palette similar to datamapplot
      const baseColors = [
        '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', 
        '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#ff9999', '#66b3ff',
        '#99ff99', '#ffcc99', '#ff99cc', '#c2c2f0', '#ffb3e6', '#c2f0c2',
        '#ffd9b3', '#b3b3ff', '#ffb3b3', '#b3ffb3', '#ffccb3', '#ccb3ff'
      ];
      
      // Ensure we have valid inputs
      if (typeof clusterId !== 'number' || typeof layer !== 'number') {
        return '#999999'; // Default gray color
      }
      
      // Create a deterministic color based on cluster ID
      const colorIndex = (clusterId * 7 + layer * 3) % baseColors.length;
      return baseColors[colorIndex];
    };

    // Clear previous visualization
    umapRef.current.innerHTML = '';

    const size = 800; // Square canvas
    const width = size;
    const height = size;
    const margin = { top: 20, right: 20, bottom: 20, left: 20 };

    // Create canvas
    const canvas = select(umapRef.current)
      .append("canvas")
      .attr("width", width)
      .attr("height", height)
      .style("width", "100%")
      .style("height", "auto")
      .style("border", "1px solid #ddd");

    const context = canvas.node().getContext("2d");
    
    // Enable high DPI
    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.attr("width", width * devicePixelRatio)
          .attr("height", height * devicePixelRatio);
    context.scale(devicePixelRatio, devicePixelRatio);

    // Create scales
    const xExtent = extent(umapData, d => d.umap_x);
    const yExtent = extent(umapData, d => d.umap_y);
    
    console.log("UMAP data extents:", { xExtent, yExtent });
    
    const xScale = scaleLinear()
      .domain(xExtent)
      .range([margin.left, width - margin.right]);
    
    const yScale = scaleLinear()
      .domain(yExtent)
      .range([height - margin.bottom, margin.top]);

    // Clear canvas
    context.clearRect(0, 0, width, height);

    // Get unique raw comment coordinates (without layer duplicates)
    const uniqueComments = new Map();
    umapData.forEach(point => {
      const key = `${point.comment_id}`;
      if (!uniqueComments.has(key)) {
        uniqueComments.set(key, {
          comment_id: point.comment_id,
          umap_x: point.umap_x,
          umap_y: point.umap_y,
          clusters_by_layer: {}
        });
      }
      uniqueComments.get(key).clusters_by_layer[point.layer] = point.cluster_id;
    });

    const uniquePoints = Array.from(uniqueComments.values());
    console.log(`Drawing ${uniquePoints.length} unique comments with cluster assignments for each layer`);

    // Group points by cluster for each layer to draw hulls
    const clusterGroups = {};
    for (let layer = 0; layer <= 3; layer++) {
      clusterGroups[layer] = new Map();
      
      uniquePoints.forEach(point => {
        const clusterId = point.clusters_by_layer[layer];
        if (clusterId !== undefined) {
          const key = `L${layer}C${clusterId}`;
          if (!clusterGroups[layer].has(key)) {
            clusterGroups[layer].set(key, []);
          }
          clusterGroups[layer].get(key).push(point);
        }
      });
    }
    
    // Debug: Show cluster distribution
    for (let layer = 0; layer <= 3; layer++) {
      const clusters = clusterGroups[layer];
      console.log(`Layer ${layer}: ${clusters.size} clusters`);
      
      // Show first few clusters and their sizes
      let count = 0;
      clusters.forEach((points, clusterKey) => {
        if (count < 3) {
          console.log(`  ${clusterKey}: ${points.length} points`);
          count++;
        }
      });
    }

    // Draw convex hulls for each individual cluster in each layer
    const layerColors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4"];
    const layerAlphas = [0.1, 0.15, 0.2, 0.25]; // Different opacities to show containment
    const layerLineWidths = [0.5, 1, 1.5, 2]; // Different line weights

    // Draw hulls from coarsest to finest (3 → 0) so finer hulls appear on top
    for (let layer = 3; layer >= 0; layer--) {
      // Skip this layer if it's not visible
      if (!layerVisibility[layer]) continue;
      
      const clusters = clusterGroups[layer];
      
      console.log(`Drawing ${clusters.size} individual cluster hulls for Layer ${layer}`);
      
      clusters.forEach((points, clusterKey) => {
        if (points.length < 3) return; // Need at least 3 points for hull
        
        const hullPoints = points.map(p => [xScale(p.umap_x), yScale(p.umap_y)]);
        const hull = polygonHull(hullPoints);
        
        if (hull && hull.length > 2) {
          context.beginPath();
          context.moveTo(hull[0][0], hull[0][1]);
          for (let i = 1; i < hull.length; i++) {
            context.lineTo(hull[i][0], hull[i][1]);
          }
          context.closePath();
          
          // Fill hull with layer color and alpha
          context.fillStyle = layerColors[layer];
          context.globalAlpha = layerAlphas[layer];
          context.fill();
          
          // Stroke hull with layer color and line width
          context.strokeStyle = layerColors[layer];
          context.globalAlpha = 0.7;
          context.lineWidth = layerLineWidths[layer];
          context.stroke();
        }
      });
    }

    // Reset alpha for points
    context.globalAlpha = 1.0;

    // Draw all points in neutral color since they belong to multiple clusters
    uniquePoints.forEach(point => {
      const x = xScale(point.umap_x);
      const y = yScale(point.umap_y);
      
      context.beginPath();
      context.arc(x, y, 1.5, 0, 2 * Math.PI);
      context.fillStyle = "#333";
      context.globalAlpha = 0.7;
      context.fill();
    });

    // Add legend with toggle controls outside the canvas
    const containerDiv = select(umapRef.current);
    const legendDiv = containerDiv
      .append("div")
      .style("margin-top", "20px")
      .style("background", "rgba(255,255,255,0.95)")
      .style("padding", "15px")
      .style("border-radius", "8px")
      .style("box-shadow", "0 4px 8px rgba(0,0,0,0.2)")
      .style("font-size", "13px")
      .style("border", "1px solid #ddd")
      .style("max-width", "300px");

    legendDiv.append("div")
      .style("font-weight", "bold")
      .style("margin-bottom", "10px")
      .style("font-size", "14px")
      .style("color", "#333")
      .text("Hull Layer Controls");

    [3, 2, 1, 0].forEach((layer, i) => { // Show from coarsest to finest
      const item = legendDiv.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("margin", "6px 0")
        .style("padding", "3px")
        .style("border-radius", "4px")
        .style("background", layerVisibility[layer] ? "rgba(0,0,0,0.02)" : "rgba(0,0,0,0.05)")
        .style("cursor", "pointer")
        .on("click", () => {
          toggleLayerVisibility(layer);
        });
      
      // Checkbox indicator
      const layerColors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4"];
      const checkbox = item.append("div")
        .style("width", "16px")
        .style("height", "16px")
        .style("border", "2px solid #ccc")
        .style("border-radius", "3px")
        .style("margin-right", "8px")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("background", layerVisibility[layer] ? layerColors[layer] : "white")
        .style("border-color", layerColors[layer]);
      
      if (layerVisibility[layer]) {
        checkbox.append("div")
          .style("width", "8px")
          .style("height", "8px")
          .style("background", "white")
          .style("border-radius", "1px");
      }
      
      // Color indicator showing colors for this layer
      const colorBox = item.append("div")
        .style("width", "20px")
        .style("height", "12px")
        .style("background", layerColors[layer])
        .style("opacity", layerVisibility[layer] ? "0.8" : "0.3")
        .style("border", "1px solid #ccc")
        .style("margin-right", "8px")
        .style("border-radius", "2px");
      
      // Label
      item.append("span")
        .style("color", layerVisibility[layer] ? "#333" : "#999")
        .style("font-weight", layerVisibility[layer] ? "500" : "normal")
        .text(`Layer ${layer} ${layer === 0 ? '(Finest)' : layer === 3 ? '(Coarsest)' : ''}`);
    });

    // Add basic interactivity with mouse tracking
    canvas.on("mousemove", function() {
      const mousePos = d3Mouse(this);
      const x = mousePos[0];
      const y = mousePos[1];
      
      // Convert back to data coordinates
      const dataX = xScale.invert(x);
      const dataY = yScale.invert(y);
      
      // Find closest point (simple implementation)
      let closestPoint = null;
      let minDistance = Infinity;
      
      umapData.forEach(point => {
        const distance = Math.sqrt(
          Math.pow(point.umap_x - dataX, 2) + 
          Math.pow(point.umap_y - dataY, 2)
        );
        if (distance < minDistance && distance < 1.0) { // Within reasonable distance
          minDistance = distance;
          closestPoint = point;
        }
      });
      
      // Update cursor
      canvas.style("cursor", closestPoint ? "pointer" : "default");
    });

    console.log("Canvas UMAP visualization rendered successfully");
  };

  // Create separate density visualization
  const createDensityVisualization = () => {
    if (!umapData || !densityRef.current) return;
    
    if (umapData.length === 0) {
      console.log("No UMAP data to visualize");
      return;
    }

    console.log("Creating Canvas density visualization with", umapData.length, "points");

    // Generate colors similar to datamapplot's approach
    const generateClusterColor = (clusterId, layer) => {
      const baseColors = [
        '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', 
        '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#ff9999', '#66b3ff',
        '#99ff99', '#ffcc99', '#ff99cc', '#c2c2f0', '#ffb3e6', '#c2f0c2',
        '#ffd9b3', '#b3b3ff', '#ffb3b3', '#b3ffb3', '#ffccb3', '#ccb3ff'
      ];
      
      if (typeof clusterId !== 'number' || typeof layer !== 'number') {
        return '#999999';
      }
      
      const colorIndex = (clusterId * 7 + layer * 3) % baseColors.length;
      return baseColors[colorIndex];
    };

    // Clear previous visualization
    densityRef.current.innerHTML = '';

    const size = 800;
    const width = size;
    const height = size;
    const margin = { top: 20, right: 20, bottom: 20, left: 20 };

    // Create canvas
    const canvas = select(densityRef.current)
      .append("canvas")
      .attr("width", width)
      .attr("height", height)
      .style("width", "100%")
      .style("height", "auto")
      .style("border", "1px solid #ddd");

    const context = canvas.node().getContext("2d");
    
    // Enable high DPI
    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.attr("width", width * devicePixelRatio)
          .attr("height", height * devicePixelRatio);
    context.scale(devicePixelRatio, devicePixelRatio);

    // Create scales
    const xExtent = extent(umapData, d => d.umap_x);
    const yExtent = extent(umapData, d => d.umap_y);
    
    const xScale = scaleLinear()
      .domain(xExtent)
      .range([margin.left, width - margin.right]);
    
    const yScale = scaleLinear()
      .domain(yExtent)
      .range([height - margin.bottom, margin.top]);

    // Clear canvas
    context.clearRect(0, 0, width, height);

    // Get unique raw comment coordinates
    const uniqueComments = new Map();
    umapData.forEach(point => {
      const key = `${point.comment_id}`;
      if (!uniqueComments.has(key)) {
        uniqueComments.set(key, {
          comment_id: point.comment_id,
          umap_x: point.umap_x,
          umap_y: point.umap_y,
          clusters_by_layer: {}
        });
      }
      uniqueComments.get(key).clusters_by_layer[point.layer] = point.cluster_id;
    });

    const uniquePoints = Array.from(uniqueComments.values());

    // Group points by cluster for each layer
    const clusterGroups = {};
    for (let layer = 0; layer <= 3; layer++) {
      clusterGroups[layer] = new Map();
      
      uniquePoints.forEach(point => {
        const clusterId = point.clusters_by_layer[layer];
        if (clusterId !== undefined) {
          const key = `L${layer}C${clusterId}`;
          if (!clusterGroups[layer].has(key)) {
            clusterGroups[layer].set(key, []);
          }
          clusterGroups[layer].get(key).push(point);
        }
      });
    }

    // Create 2D density plots only for visible layers
    const densityRadius = 25;
    const gridSize = 4;
    
    // Draw density from coarsest to finest (3 → 0) so finer densities appear on top
    for (let layer = 3; layer >= 0; layer--) {
      // Skip this layer if it's not visible
      if (!densityLayerVisibility[layer]) continue;
      
      const clusters = clusterGroups[layer];
      
      console.log(`Drawing density plots for ${clusters.size} clusters in Layer ${layer}`);
      
      clusters.forEach((points, clusterKey) => {
        if (points.length < 2) return;
        
        const clusterIdMatch = clusterKey.match(/C(\d+)/);
        const clusterId = clusterIdMatch ? parseInt(clusterIdMatch[1]) : 0;
        const clusterColor = generateClusterColor(clusterId, layer);
        
        if (!clusterColor || typeof clusterColor !== 'string') {
          console.warn(`Invalid color generated for cluster ${clusterKey}`);
          return;
        }
        
        // Create density map for this cluster
        const densityMap = new Map();
        
        // Calculate density at grid points
        for (let x = margin.left; x < width - margin.right; x += gridSize) {
          for (let y = margin.top; y < height - margin.bottom; y += gridSize) {
            let density = 0;
            const gridKey = `${x},${y}`;
            
            points.forEach(point => {
              const px = xScale(point.umap_x);
              const py = yScale(point.umap_y);
              const distance = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
              
              if (distance <= densityRadius) {
                density += Math.exp(-(distance ** 2) / (2 * (densityRadius / 3) ** 2));
              }
            });
            
            if (density > 0.1) {
              densityMap.set(gridKey, density);
            }
          }
        }
        
        // Draw contour lines instead of filled density
        const maxDensity = Math.max(...densityMap.values());
        if (maxDensity > 0) {
          // Create contour levels (like topographic lines)
          const contourLevels = [0.2, 0.4, 0.6, 0.8].map(level => level * maxDensity);
          
          contourLevels.forEach((level, levelIndex) => {
            // Find grid points at this density level
            const contourPoints = [];
            densityMap.forEach((density, gridKey) => {
              if (Math.abs(density - level) < maxDensity * 0.1) { // Within 10% of level
                const [x, y] = gridKey.split(',').map(Number);
                contourPoints.push([x, y]);
              }
            });
            
            // Draw contour lines
            if (contourPoints.length > 2) {
              try {
                const hull = d3.polygonHull(contourPoints);
                if (hull && hull.length > 2) {
                  context.beginPath();
                  context.moveTo(hull[0][0], hull[0][1]);
                  for (let i = 1; i < hull.length; i++) {
                    context.lineTo(hull[i][0], hull[i][1]);
                  }
                  context.closePath();
                  
                  // Draw contour line
                  context.strokeStyle = clusterColor;
                  context.lineWidth = 2 - (levelIndex * 0.3); // Thicker lines for higher density
                  context.globalAlpha = 0.6;
                  context.stroke();
                  
                  // Light fill for the innermost contour
                  if (levelIndex === contourLevels.length - 1) {
                    const hex = clusterColor.replace('#', '');
                    const r = parseInt(hex.substr(0, 2), 16);
                    const g = parseInt(hex.substr(2, 2), 16);
                    const b = parseInt(hex.substr(4, 2), 16);
                    context.fillStyle = `rgba(${r}, ${g}, ${b}, 0.1)`;
                    context.fill();
                  }
                }
              } catch (error) {
                console.error(`Error drawing contour for ${clusterKey}:`, error);
              }
            }
          });
        }
      });
    }

    // Reset alpha for points
    context.globalAlpha = 1.0;

    // Draw all points with lighter color
    uniquePoints.forEach(point => {
      const x = xScale(point.umap_x);
      const y = yScale(point.umap_y);
      
      context.beginPath();
      context.arc(x, y, 1, 0, 2 * Math.PI);
      context.fillStyle = "#ccc"; // Much lighter gray
      context.globalAlpha = 0.5; // More transparent
      context.fill();
    });

    // Get topic name from the stored topic names map
    const getTopicName = (layer, clusterId) => {
      const key = `layer${layer}_${clusterId}`;
      return topicNames.get(key) || null;
    };

    // Draw topic names at cluster centroids
    context.globalAlpha = 1.0;
    context.font = "5px Arial"; // Even smaller font
    context.textAlign = "center";
    context.textBaseline = "middle";
    
    for (let layer = 3; layer >= 0; layer--) {
      if (!densityLayerVisibility[layer]) continue;
      
      const clusters = clusterGroups[layer];
      
      clusters.forEach((points, clusterKey) => {
        if (points.length < 2) return;
        
        // Calculate centroid
        const centroidX = points.reduce((sum, p) => sum + xScale(p.umap_x), 0) / points.length;
        const centroidY = points.reduce((sum, p) => sum + yScale(p.umap_y), 0) / points.length;
        
        // Get cluster ID and topic name
        const clusterIdMatch = clusterKey.match(/C(\d+)/);
        const clusterId = clusterIdMatch ? parseInt(clusterIdMatch[1]) : 0;
        const topicName = getTopicName(layer, clusterId);
        
        // Format: "3_7: Transportation" or just the topic name if it doesn't already include the layer_cluster
        let label;
        if (topicName) {
          // Check if topic name already includes the layer_cluster format
          const layerClusterPrefix = `${layer}_${clusterId}`;
          if (topicName.startsWith(layerClusterPrefix)) {
            label = topicName; // Already formatted
          } else {
            label = `${layerClusterPrefix}: ${topicName}`;
          }
        } else {
          label = `${layer}_${clusterId}`;
        }
        
        // Draw text with subtle background for readability
        const textMetrics = context.measureText(label);
        const padding = 1; // Much smaller padding
        const bgWidth = textMetrics.width + (padding * 2);
        const bgHeight = 6; // Much smaller height for tiny font
        
        // Draw very subtle background
        context.fillStyle = "rgba(255, 255, 255, 0.1)"; // Much more transparent
        context.fillRect(
          centroidX - bgWidth/2, 
          centroidY - bgHeight/2, 
          bgWidth, 
          bgHeight
        );
        
        // Draw text with white stroke outline
        context.lineWidth = 1; // Thinner stroke for tiny text
        context.strokeStyle = "white";
        context.strokeText(label, centroidX, centroidY);
        
        // Draw text fill
        context.fillStyle = "#333";
        context.fillText(label, centroidX, centroidY);
      });
    }

    // Add legend for density visualization
    const legendDiv = select(densityRef.current)
      .append("div")
      .style("margin-top", "20px")
      .style("background", "rgba(255,255,255,0.95)")
      .style("padding", "15px")
      .style("border-radius", "8px")
      .style("box-shadow", "0 4px 8px rgba(0,0,0,0.2)")
      .style("font-size", "13px")
      .style("border", "1px solid #ddd")
      .style("max-width", "300px");

    legendDiv.append("div")
      .style("font-weight", "bold")
      .style("margin-bottom", "10px")
      .style("font-size", "14px")
      .style("color", "#333")
      .text("Density Layer Controls");

    [3, 2, 1, 0].forEach((layer, i) => {
      const item = legendDiv.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("margin", "6px 0")
        .style("padding", "3px")
        .style("border-radius", "4px")
        .style("background", densityLayerVisibility[layer] ? "rgba(0,0,0,0.02)" : "rgba(0,0,0,0.05)")
        .style("cursor", "pointer")
        .on("click", () => {
          toggleDensityLayerVisibility(layer);
        });
      
      // Checkbox indicator
      const checkbox = item.append("div")
        .style("width", "16px")
        .style("height", "16px")
        .style("border", "2px solid #ccc")
        .style("border-radius", "3px")
        .style("margin-right", "8px")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("background", densityLayerVisibility[layer] ? generateClusterColor(0, layer) : "white")
        .style("border-color", generateClusterColor(0, layer));
      
      if (densityLayerVisibility[layer]) {
        checkbox.append("div")
          .style("width", "8px")
          .style("height", "8px")
          .style("background", "white")
          .style("border-radius", "1px");
      }
      
      // Color indicator
      const colorBox = item.append("div")
        .style("width", "20px")
        .style("height", "12px")
        .style("background", `linear-gradient(45deg, ${generateClusterColor(0, layer)}, ${generateClusterColor(1, layer)}, ${generateClusterColor(2, layer)})`)
        .style("opacity", densityLayerVisibility[layer] ? "0.8" : "0.3")
        .style("border", "1px solid #ccc")
        .style("margin-right", "8px")
        .style("border-radius", "2px");
      
      // Label
      item.append("span")
        .style("color", densityLayerVisibility[layer] ? "#333" : "#999")
        .style("font-weight", densityLayerVisibility[layer] ? "500" : "normal")
        .text(`Layer ${layer} ${layer === 0 ? '(Finest)' : layer === 3 ? '(Coarsest)' : ''}`);
    });

    console.log("Canvas density visualization rendered successfully");
  };

  // Create D3.js circle pack visualization (from TopicPrioritize.jsx - working version)
  const createCirclePack = () => {
    if (!hierarchyData || !circlePackRef.current) return;

    // Clear previous visualization
    select(circlePackRef.current).selectAll("*").remove();

    const width = 800;
    const height = 600;

    // Create SVG
    const svg = select(circlePackRef.current)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("style", "border: 1px solid #ccc; border-radius: 8px;");

    // Create hierarchy from data
    const hierarchyRoot = hierarchy(hierarchyData.hierarchy)
      .sum(d => d.size || 1)  // Use cluster size for circle size
      .sort((a, b) => b.value - a.value);

    // Create pack layout
    const packLayout = pack()
      .size([width - 20, height - 20])
      .padding(3);

    const nodes = packLayout(hierarchyRoot);

    // Color scale by layer
    const colorScale = scaleOrdinal()
      .domain([0, 1, 2, 3])
      .range(["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4"]);

    // Create groups for each node
    const nodeGroups = svg.selectAll("g")
      .data(nodes.descendants())
      .enter()
      .append("g")
      .attr("transform", d => `translate(${d.x + 10},${d.y + 10})`);

    // Add circles
    nodeGroups.append("circle")
      .attr("r", d => d.r)
      .attr("fill", d => {
        if (d.depth === 0) return "#f8f9fa"; // Root
        return colorScale(d.data.layer);
      })
      .attr("stroke", d => d.depth === 0 ? "#dee2e6" : "#343a40")
      .attr("stroke-width", d => d.depth === 0 ? 2 : 1)
      .attr("fill-opacity", d => d.depth === 0 ? 0.1 : 0.7)
      .style("cursor", "pointer")
      .on("click", function(event, d) {
        if (d.data.layer !== undefined) {
          console.log("Clicked cluster:", d.data);
          // setSelectedLayer(d.data.layer); // Comment out if this state doesn't exist in TopicHierarchy
        }
      });

    // Add text labels for larger circles
    nodeGroups.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.3em")
      .attr("font-size", d => Math.min(d.r / 4, 12))
      .attr("fill", "#343a40")
      .attr("font-weight", "bold")
      .style("pointer-events", "none")
      .text(d => {
        if (d.depth === 0) return "Topics";
        if (d.r < 20) return ""; // Hide text for very small circles
        return `L${d.data.layer} C${d.data.clusterId}`;
      });

    // Add size labels for larger circles
    nodeGroups.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "1.5em")
      .attr("font-size", d => Math.min(d.r / 6, 10))
      .attr("fill", "#6c757d")
      .style("pointer-events", "none")
      .text(d => {
        if (d.depth === 0 || d.r < 25) return "";
        return `${d.data.size} comments`;
      });

    // Add legend
    const legend = svg.append("g")
      .attr("transform", `translate(${width - 150}, 20)`);

    legend.append("text")
      .attr("font-weight", "bold")
      .attr("font-size", "14")
      .text("Layers");

    const legendItems = legend.selectAll(".legend-item")
      .data([
        { layer: 0, label: "Layer 0 (Finest)", color: "#ff6b6b" },
        { layer: 1, label: "Layer 1", color: "#4ecdc4" },
        { layer: 2, label: "Layer 2", color: "#45b7d1" },
        { layer: 3, label: "Layer 3 (Coarsest)", color: "#96ceb4" }
      ])
      .enter()
      .append("g")
      .attr("class", "legend-item")
      .attr("transform", (d, i) => `translate(0, ${20 + i * 20})`);

    legendItems.append("circle")
      .attr("r", 8)
      .attr("fill", d => d.color)
      .attr("fill-opacity", 0.7);

    legendItems.append("text")
      .attr("x", 15)
      .attr("dy", "0.3em")
      .attr("font-size", "12")
      .text(d => d.label);
  };

  // Effect to create circle pack when hierarchy data is available and DOM is ready
  useEffect(() => {
    console.log("Circle pack useEffect triggered:", {
      hierarchyData: !!hierarchyData,
      hierarchyDataStructure: hierarchyData ? Object.keys(hierarchyData) : null,
      refCurrent: !!circlePackRef.current
    });
    
    const tryCreateCirclePack = () => {
      if (hierarchyData && circlePackRef.current) {
        console.log("Attempting to create circle pack...");
        createCirclePack();
        return true;
      }
      console.log("Circle pack creation failed:", {
        hierarchyData: !!hierarchyData,
        refCurrent: !!circlePackRef.current
      });
      return false;
    };

    if (hierarchyData) {
      // Try immediately
      if (!tryCreateCirclePack()) {
        // If that fails, try with a delay
        const timer = setTimeout(() => {
          if (!tryCreateCirclePack()) {
            console.log("Circle pack: ref still not available after timeout");
          }
        }, 300);
        
        return () => clearTimeout(timer);
      }
    }
  }, [hierarchyData]);

  // Effect to create UMAP visualization when data is available
  useEffect(() => {
    if (umapData) {
      createUMAPVisualization();
    }
  }, [umapData]);

  // Effect to re-render UMAP visualization when layer visibility changes
  useEffect(() => {
    if (umapData) {
      createUMAPVisualization();
    }
  }, [layerVisibility]);

  // Effect to create density visualization when data is available
  useEffect(() => {
    if (umapData) {
      createDensityVisualization();
    }
  }, [umapData, topicNames]);

  // Effect to re-render density visualization when density layer visibility changes
  useEffect(() => {
    if (umapData) {
      createDensityVisualization();
    }
  }, [densityLayerVisibility]);

  if (loading) {
    return (
      <div className="topic-hierarchy">
        <h1>Topic Hierarchy</h1>
        <div className="loading">Loading hierarchical topic data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="topic-hierarchy">
        <h1>Topic Hierarchy</h1>
        <div className="error-message">
          <h3>Error</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="topic-hierarchy">
      <div className="header">
        <h1>Topic Hierarchy</h1>
        <div className="subtitle">
          Interactive circle pack visualization of hierarchical topic clusters
        </div>
        <div className="report-info">Report ID: {report_id}</div>
      </div>

      <div className="visualization-container">
        {/* Density Visualization - First */}
        <div className="density-card">
          <h3>Topic Spatial Distribution - Contours</h3>
          <p>UMAP projection with topographic contour lines showing cluster density (Layer 3 coarsest by default)</p>
          <div ref={densityRef} className="density-visualization"></div>
        </div>
        
        {/* UMAP Spatial Visualization */}
        <div className="umap-card">
          <h3>Topic Spatial Distribution - Hulls</h3>
          <p>UMAP projection showing semantic neighborhoods with convex hulls around clusters</p>
          <div ref={umapRef} className="umap-visualization"></div>
        </div>
        
        {/* Circle Pack Visualization */}
        <div className="circle-pack-card">
          <h3>Topic Hierarchy</h3>
          <p>Nested circle pack showing hierarchical topic containment relationships</p>
          <div ref={circlePackRef} className="circle-pack-visualization"></div>
        </div>
      </div>

      <style>{`
        .topic-hierarchy {
          padding: 20px;
          max-width: 100%;
          margin: 0 auto;
          background: #f8f9fa;
          min-height: 100vh;
        }

        .header {
          text-align: center;
          border-bottom: 1px solid #dee2e6;
          margin-bottom: 30px;
          padding-bottom: 20px;
          background: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .header h1 {
          margin: 0 0 10px 0;
          color: #1e7dff;
          font-size: 2.5rem;
        }

        .subtitle {
          color: #666;
          margin-bottom: 10px;
          font-size: 1.1rem;
        }

        .report-info {
          font-size: 0.9em;
          color: #888;
        }

        .visualization-container {
          display: flex;
          flex-direction: column;
          gap: 30px;
        }

        .umap-card, .density-card, .circle-pack-card {
          background: white;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          padding: 20px;
          overflow: hidden;
        }

        .umap-card h3, .density-card h3, .circle-pack-card h3 {
          margin: 0 0 10px 0;
          color: #1e7dff;
          font-size: 1.5rem;
        }

        .umap-card p, .density-card p, .circle-pack-card p {
          margin: 0 0 20px 0;
          color: #666;
          font-size: 1rem;
        }

        .umap-visualization, .density-visualization, .circle-pack-visualization {
          width: 100%;
          height: auto;
          min-height: 600px;
          position: relative;
        }

        .loading, .error-message {
          text-align: center;
          padding: 60px 40px;
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .error-message {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
        }

        .loading {
          font-size: 1.2rem;
          color: #666;
        }
      `}</style>
    </div>
  );
};

export default TopicHierarchy;