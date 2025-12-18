import React, { useMemo } from 'react'
import type { HierarchyAnalysis, TopicData } from '../../../api/types'
import type { Translations } from '../../../strings/types'
import type { TopicEntry, UmapPoint } from '../types'
import { getFilteredTopics } from '../utils/topicFiltering'
import TopicItem from './TopicItem'

interface ScrollableTopicsGridProps {
  topicData: TopicData | null
  selections: Set<string>
  onToggleSelection: (topicKey: string) => void
  clusterGroups: Record<number, Map<string, UmapPoint[]>>
  hierarchyAnalysis: HierarchyAnalysis | null
  s: Translations
}

const ScrollableTopicsGrid = ({
  topicData,
  selections,
  onToggleSelection,
  clusterGroups,
  hierarchyAnalysis,
  s
}: ScrollableTopicsGridProps) => {
  // visibleLayers is now derived state via useMemo

  // Extract data with safe defaults to avoid early returns after hooks
  const runKeys = topicData ? Object.keys(topicData.runs) : []
  const firstRun = runKeys.length > 0 ? topicData!.runs[runKeys[0]] : null
  const topicsByLayer = firstRun?.topics_by_layer
  // Fix: layers in HierarchyAnalysis is optional, but we need an array here
  const layers = useMemo(() => hierarchyAnalysis?.layers || [], [hierarchyAnalysis])

  // Get the two coarsest layers (highest numbers)
  // sortedLayers is ordered from highest to lowest (e.g., [7, 6, 5, 4, 3, 2, 1, 0])
  const sortedLayers = useMemo(() => [...layers].sort((a, b) => b - a), [layers])
  const coarsestLayer = sortedLayers[0] // e.g., 7
  const secondCoarsestLayer = sortedLayers[1] // e.g., 6

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

  const visibleLayers = useMemo(() => {
    if (!firstRun || !topicsByLayer) return new Set<number>()

    const newVisibleLayers = new Set<number>()

    // Build a map of selections by layer
    const selectionsByLayer = new Map<number, Set<string>>()

    // Categorize all selections by their layer
    Array.from(selections).forEach((topicKey) => {
      // Find which layer this topic belongs to
      for (const layerId of sortedLayers) {
        const topic = Object.values(topicsByLayer[String(layerId)] || {}).find(
          (t) => t.topic_key === topicKey
        )
        if (topic) {
          if (!selectionsByLayer.has(layerId)) {
            selectionsByLayer.set(layerId, new Set())
          }
          selectionsByLayer.get(layerId)!.add(topicKey)
          break
        }
      }
    })

    // For each layer, check if its parent layer has selections
    // Note: sortedLayers is ordered from coarsest to finest (e.g., [2, 1, 0])
    sortedLayers.forEach((layerId, index) => {
      if (index < 2) return // Skip the first two layers (always visible)

      const parentLayer = sortedLayers[index - 1] // Parent is the previous in sorted order

      if (selectionsByLayer.has(parentLayer)) {
        // Parent layer has selections, this layer should be visible
        newVisibleLayers.add(layerId)
      }
    })

    return newVisibleLayers
  }, [selections, sortedLayers, firstRun, topicsByLayer])

  const renderLayerTopics = (
    layerId: number,
    layerLabel: string | null,
    parentLayerId: number | null = null
  ) => {
    const allTopics = topicsByLayer?.[String(layerId)]
    if (!allTopics) return null

    let topicEntries: TopicEntry[]

    if (parentLayerId !== null) {
      // This is a dynamically shown layer - filter by proximity to parent selections
      const selectionsByLayer = new Map<number, Set<string>>()

      // Get selections from the parent layer
      Array.from(selections).forEach((topicKey) => {
        const topic = Object.values(topicsByLayer[String(parentLayerId)] || {}).find(
          (t) => t.topic_key === topicKey
        )
        if (topic) {
          if (!selectionsByLayer.has(parentLayerId)) {
            selectionsByLayer.set(parentLayerId, new Set())
          }
          selectionsByLayer.get(parentLayerId)!.add(topicKey)
        }
      })

      if (selectionsByLayer.size === 0) return null

      // Prepare hierarchy analysis for getFilteredTopics
      // It expects { layers: number[] } | null, but hierarchyAnalysis.layers is number[] | undefined
      // We can safely construct a compatible object if hierarchyAnalysis exists
      const safeHierarchyAnalysis = hierarchyAnalysis
        ? { ...hierarchyAnalysis, layers: hierarchyAnalysis.layers || [] }
        : null

      // Get filtered topics based on proximity
      const filteredTopics = getFilteredTopics(
        allTopics,
        layerId,
        safeHierarchyAnalysis,
        selectionsByLayer,
        clusterGroups
      )

      // Apply distance threshold that gets tighter as we go deeper
      const layerDepth = sortedLayers.indexOf(layerId)
      const distanceThreshold = 3.0 - layerDepth * 0.5 // 3.0, 2.5, 2.0, 1.5...

      topicEntries = filteredTopics
        .filter(
          (entry) =>
            entry.proximityScore !== null && entry.proximityScore < Math.max(distanceThreshold, 1.0)
        )
        .map((entry) => ({
          clusterId: entry.clusterId,
          topic: entry.topic as TopicEntry['topic'], // Assert that topic shape matches
          proximityScore: entry.proximityScore,
          closestBankedTopic: entry.closestBankedTopic
        }))

      if (topicEntries.length === 0) return null
    } else {
      // This is a static layer - show all topics
      topicEntries = Object.entries(allTopics).map(([clusterId, topic]) => ({
        clusterId,
        topic,
        proximityScore: null,
        closestBankedTopic: null
      }))
    }

    return (
      <React.Fragment key={layerId}>
        {layerLabel && <div className="layer-divider">{layerLabel}</div>}
        {topicEntries.map((entry) => (
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
    )
  }

  // Determine layer labels based on depth
  const getLayerLabel = (layerId: number, index: number) => {
    if (index === 0) return null // Coarsest layer has no label
    if (index === 1) return s.moreSpecificTopics
    if (index === 2) return s.superSpecificTopics
    return null // No labels for deeper layers
  }

  // Return early after all hooks have been called
  if (!topicData || !hierarchyAnalysis || !topicsByLayer) {
    return null
  }

  return (
    <div className="topics-scroll-container">
      <div className="topics-grid">
        {/* Always show the two coarsest layers */}
        {renderLayerTopics(coarsestLayer, null)}
        {secondCoarsestLayer !== undefined &&
          renderLayerTopics(secondCoarsestLayer, s.moreSpecificTopics)}

        {/* Show additional layers based on selections in parent layers */}
        {sortedLayers.slice(2).map((layerId, index) => {
          if (!visibleLayers.has(layerId)) return null

          const parentLayer = sortedLayers[index + 1] // Parent is the previous in sorted order
          return renderLayerTopics(layerId, getLayerLabel(layerId, index + 2), parentLayer)
        })}
      </div>
    </div>
  )
}

export default ScrollableTopicsGrid
