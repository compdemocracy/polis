import React, { useEffect, useState } from "react";
import TopicItem from "./TopicItem";
import { getFilteredTopics } from "../utils/topicFiltering";

const ScrollableTopicsGrid = ({ 
  topicData,
  selections,
  onToggleSelection,
  clusterGroups,
  hierarchyAnalysis 
}) => {
  const [visibleLayers, setVisibleLayers] = useState(new Set());

  if (!topicData || !hierarchyAnalysis) return null;

  const runKeys = Object.keys(topicData.runs);
  const firstRun = topicData.runs[runKeys[0]];
  
  if (!firstRun.topics_by_layer) return null;

  // Get the two coarsest layers (highest numbers)
  // sortedLayers is ordered from highest to lowest (e.g., [7, 6, 5, 4, 3, 2, 1, 0])
  const sortedLayers = [...hierarchyAnalysis.layers].sort((a, b) => b - a);
  const coarsestLayer = sortedLayers[0]; // e.g., 7
  const secondCoarsestLayer = sortedLayers[1]; // e.g., 6

  // CRITICAL FEATURE: Cascading Auto-population
  // ================================================================
  // EVERY LAYER DRIVES THE NEXT LEVEL OF DETAIL!
  // 
  // DESIGN PHILOSOPHY:
  // This creates an infinitely explorable space where each selection
  // opens up new, more specific possibilities. It's like zooming into
  // a fractal - the deeper you go, the more detail you discover.
  // 
  // HOW IT WORKS:
  // 1. Start with the two coarsest layers visible
  // 2. Select from layer 2 → reveals nearby topics in layer 1
  // 3. Select from layer 1 → reveals nearby topics in layer 0
  // 4. And so on... each selection cascades down to finer layers
  // 
  // THE CASCADE EFFECT:
  // - Layer 3 (coarsest): Always visible as a safety net
  // - Layer 2: Always visible, first driver of specificity
  // - Layer 1: Appears when Layer 2 has selections
  // - Layer 0: Appears when Layer 1 has selections
  // - Future layers: Continue the pattern...
  // 
  // SPATIAL PROXIMITY RULES:
  // - We use UMAP coordinates to find "nearby" topics
  // - Distance threshold gets tighter as you go deeper (more selective)
  // - This ensures relevance increases with depth
  // 
  // USER EXPERIENCE:
  // - Feels like having a conversation that gets more specific
  // - Never overwhelming - only shows what's relevant
  // - Creates a sense of discovery and exploration
  // - Users can stop at any level when they've found what they want
  // 
  // IMPLEMENTATION NOTE:
  // We track which layers should be visible based on selections
  // in their parent layers. This creates a dependency chain where
  // each layer's visibility depends on selections in the layer above.
  // ================================================================

  useEffect(() => {
    if (!firstRun || !firstRun.topics_by_layer) return;
    
    const newVisibleLayers = new Set();
    
    // Build a map of selections by layer
    const selectionsByLayer = new Map();
    
    // Categorize all selections by their layer
    Array.from(selections).forEach(topicKey => {
      // Find which layer this topic belongs to
      for (const layerId of sortedLayers) {
        const topic = Object.values(firstRun.topics_by_layer[layerId] || {})
          .find(t => t.topic_key === topicKey);
        if (topic) {
          if (!selectionsByLayer.has(layerId)) {
            selectionsByLayer.set(layerId, new Set());
          }
          selectionsByLayer.get(layerId).add(topicKey);
          break;
        }
      }
    });

    // For each layer, check if its parent layer has selections
    // Note: sortedLayers is ordered from coarsest to finest (e.g., [2, 1, 0])
    sortedLayers.forEach((layerId, index) => {
      if (index < 2) return; // Skip the first two layers (always visible)
      
      const parentLayer = sortedLayers[index - 1]; // Parent is the previous in the array
      
      if (selectionsByLayer.has(parentLayer)) {
        // Parent layer has selections, this layer should be visible
        newVisibleLayers.add(layerId);
      }
    });

    setVisibleLayers(newVisibleLayers);
  }, [selections, sortedLayers.join(','), !!firstRun]); // Stable dependencies

  const renderLayerTopics = (layerId, layerLabel, parentLayerId = null) => {
    const allTopics = firstRun.topics_by_layer[layerId];
    if (!allTopics) return null;

    let topicEntries;
    
    if (parentLayerId !== null) {
      // This is a dynamically shown layer - filter by proximity to parent selections
      const selectionsByLayer = new Map();
      
      // Get selections from the parent layer
      Array.from(selections).forEach(topicKey => {
        const topic = Object.values(firstRun.topics_by_layer[parentLayerId] || {})
          .find(t => t.topic_key === topicKey);
        if (topic) {
          if (!selectionsByLayer.has(parentLayerId)) {
            selectionsByLayer.set(parentLayerId, new Set());
          }
          selectionsByLayer.get(parentLayerId).add(topicKey);
        }
      });

      if (selectionsByLayer.size === 0) return null;

      // Get filtered topics based on proximity
      const filteredTopics = getFilteredTopics(
        allTopics, 
        layerId, 
        hierarchyAnalysis, 
        selectionsByLayer, 
        clusterGroups
      );

      // Apply distance threshold that gets tighter as we go deeper
      const layerDepth = sortedLayers.indexOf(layerId);
      const distanceThreshold = 3.0 - (layerDepth * 0.5); // 3.0, 2.5, 2.0, 1.5...
      
      topicEntries = filteredTopics.filter(entry => 
        entry.proximityScore !== null && entry.proximityScore < Math.max(distanceThreshold, 1.0)
      );

      if (topicEntries.length === 0) return null;
    } else {
      // This is a static layer - show all topics
      topicEntries = Object.entries(allTopics).map(([clusterId, topic]) => ({
        clusterId,
        topic,
        proximityScore: null,
        source: 'all'
      }));
    }

    return (
      <React.Fragment key={layerId}>
        {layerLabel && (
          <div className="layer-divider">
            {layerLabel}
          </div>
        )}
        {topicEntries.map(entry => (
          <TopicItem
            key={entry.topic.topic_key}
            entry={entry}
            layerId={layerId}
            isSelected={selections.has(entry.topic.topic_key)}
            onToggleSelection={onToggleSelection}
            clusterGroups={clusterGroups}
          />
        ))}
      </React.Fragment>
    );
  };

  // Determine layer labels based on depth
  const getLayerLabel = (layerId, index) => {
    if (index === 0) return null; // Coarsest layer has no label
    if (index === 1) return "More Specific Topics";
    if (index === 2) return "SUPER SPECIFIC TOPICS";
    return null; // No labels for deeper layers
  };

  return (
    <div className="topics-scroll-container">
      <div className="topics-grid">
        {/* Always show the two coarsest layers */}
        {renderLayerTopics(coarsestLayer, null)}
        {secondCoarsestLayer !== undefined && 
          renderLayerTopics(secondCoarsestLayer, "More Specific Topics")}
        
        {/* Show additional layers based on selections in parent layers */}
        {sortedLayers.slice(2).map((layerId, index) => {
          if (!visibleLayers.has(layerId)) return null;
          
          const parentLayer = sortedLayers[index + 1]; // Parent is the previous in sorted order
          return renderLayerTopics(
            layerId, 
            getLayerLabel(layerId, index + 2),
            parentLayer
          );
        })}
      </div>
    </div>
  );
};

export default ScrollableTopicsGrid;