import { calculateClusterCentroid, calculateDistance } from './topicUtils'
import type { UmapPoint } from '../types'
import type { TopicData } from '../../../api/types'
import type { ArchetypeGroup, SerializedAnchor, SerializedArchetypes } from '../types'

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
export const extractArchetypalComments = (
  selections: Set<string>,
  topicData: TopicData | null,
  clusterGroups: Record<number, Map<string, UmapPoint[]>>,
  commentMap: Map<string | number, string> = new Map()
): ArchetypeGroup[] => {
  const archetypeComments: ArchetypeGroup[] = []

  // Parse selections to extract layer and cluster info
  selections.forEach((topicKey) => {
    // Topic key formats:
    // Old: "4c5b018b-51ac-4a3e-9d41-6307a73ebf68#2#3"
    // New: "layer3_9"

    let layerId: number | undefined
    let clusterId: string | undefined

    if (topicKey.startsWith('layer')) {
      // New format: "layer3_9"
      const match = topicKey.match(/layer(\d+)_(\d+)/)
      if (match) {
        layerId = parseInt(match[1])
        clusterId = match[2]
      }
    } else {
      // Old format with # separators
      const parts = topicKey.split('#')
      if (parts.length >= 3) {
        layerId = parseInt(parts[parts.length - 2])
        clusterId = parts[parts.length - 1]
      }
    }

    if (layerId !== undefined && clusterId !== undefined) {
      // Find the cluster in clusterGroups
      const clusterKey = `${layerId}_${clusterId}`
      const clusterPoints = clusterGroups[layerId]?.get(clusterKey)

      if (clusterPoints && clusterPoints.length > 0) {
        // Strategy 1: Get comments closest to cluster centroid
        const centroid = calculateClusterCentroid(clusterPoints)

        if (centroid) {
          // Sort points by distance to centroid
          const sortedPoints = clusterPoints
            .map((point) => ({
              ...point,
              distanceToCentroid: calculateDistance({ x: point.umap_x, y: point.umap_y }, centroid)
            }))
            .sort((a, b) => a.distanceToCentroid - b.distanceToCentroid)

          // Take the top N most central comments as archetypes
          const numArchetypes = Math.min(3, sortedPoints.length)
          const archetypes = sortedPoints.slice(0, numArchetypes)

          archetypeComments.push({
            topicKey,
            layerId,
            clusterId,
            archetypes: archetypes.map((a) => {
              // Try to get comment text from the map (comment_id might be string or number)
              const commentId = a.comment_id
              if (commentId === undefined) {
                console.warn('Archetype comment has no comment_id', a)
                // Fallback or skip?
              }

              const commentText =
                (commentId !== undefined ? commentMap.get(commentId) : undefined) ||
                (commentId !== undefined
                  ? commentMap.get(parseInt(String(commentId)))
                  : undefined) ||
                (commentId !== undefined ? commentMap.get(String(commentId)) : undefined) ||
                a.comment_text ||
                `[Comment ${commentId}]`

              console.log(`Archetype comment ${commentId}: "${commentText}"`)
              return {
                commentId: commentId || 'unknown',
                text: commentText,
                distance: a.distanceToCentroid,
                coordinates: { x: a.umap_x, y: a.umap_y }
              }
            })
          })
        } else {
          console.log(`No cluster points found for ${clusterKey}`)
        }
      } else {
        console.log(`No cluster points found for layer ${layerId}, cluster ${clusterId}`)
      }
    }
  })

  return archetypeComments
}

/**
 * Convert archetypal comments to a format suitable for storage
 * This creates a stable representation that survives Delphi re-runs
 */
export const serializeArchetypes = (archetypeComments: ArchetypeGroup[]): SerializedArchetypes => {
  // Flatten to just comment IDs and their coordinates
  const stableAnchors: SerializedAnchor[] = []

  archetypeComments.forEach((group) => {
    group.archetypes.forEach((archetype) => {
      stableAnchors.push({
        commentId: archetype.commentId,
        text: archetype.text, // Include text for debugging
        coordinates: archetype.coordinates,
        sourceLayer: group.layerId,
        sourceCluster: group.clusterId
      })
    })
  })

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    anchors: stableAnchors,
    totalSelections: archetypeComments.length
  }
}
