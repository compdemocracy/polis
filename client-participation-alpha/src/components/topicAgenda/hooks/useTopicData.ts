import { useCallback, useEffect, useState } from 'react'
import { fetchDelphiTopicData, fetchTopicModProximity } from '../../../api/delphi'
import type { HierarchyAnalysis, Topic, TopicData } from '../../../api/types'
import type { UmapPoint } from '../types'

export const useTopicData = (reportId: string | null | undefined, load: boolean) => {
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [topicData, setTopicData] = useState<TopicData | null>(null)
  const [hierarchyAnalysis, setHierarchyAnalysis] = useState<HierarchyAnalysis | null>(null)
  const [umapData, setUmapData] = useState<UmapPoint[] | null>(null)
  const [clusterGroups, setClusterGroups] = useState<Record<number, Map<string, UmapPoint[]>>>({})

  const analyzeHierarchy = (data: TopicData) => {
    const runKeys = Object.keys(data.runs)
    if (runKeys.length === 0) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: 'No runs data' })
      return
    }

    const firstRun = data.runs[runKeys[0]]
    if (!firstRun.topics_by_layer) {
      setHierarchyAnalysis({ hasHierarchy: false, reason: 'No topics_by_layer data in run' })
      return
    }

    const layers = Object.keys(firstRun.topics_by_layer)
      .map((k) => parseInt(k))
      .sort((a, b) => a - b)
    console.log('Analyzing layers:', layers)

    const analysis: HierarchyAnalysis = {
      hasHierarchy: false,
      reason: '',
      layers: layers,
      layerCounts: {},
      sampleTopics: {},
      totalComments: 0,
      structure: 'unknown',
      runInfo: {
        model_name: firstRun.model_name,
        created_at: firstRun.created_at,
        job_uuid: firstRun.job_uuid
      }
    }

    layers.forEach((layerId) => {
      const topics = firstRun.topics_by_layer[String(layerId)]
      if (analysis.layerCounts) {
        analysis.layerCounts[layerId] = Object.keys(topics).length
      }

      if (analysis.sampleTopics) {
        analysis.sampleTopics[layerId] = Object.values(topics)
          .slice(0, 3)
          .map((topic: Topic) => ({
            name: topic.topic_name,
            key: topic.topic_key,
            cluster_id: topic.cluster_id,
            model_name: topic.model_name
          }))
      }
    })

    const counts = analysis.layerCounts ? Object.values(analysis.layerCounts) : []
    const hasVariedCounts = counts.length > 0 && Math.max(...counts) !== Math.min(...counts)

    if (hasVariedCounts && layers.length > 1) {
      analysis.hasHierarchy = true
      analysis.structure = 'hierarchical'
      analysis.reason = `Found ${layers.length} layers with varying topic counts: ${counts.join(
        ', '
      )}`
    } else if (layers.length === 1) {
      analysis.structure = 'flat'
      analysis.reason = 'Only one layer found - flat structure'
    } else {
      analysis.structure = 'unclear'
      analysis.reason = 'Multiple layers but similar counts - unclear hierarchy'
    }

    console.log('Hierarchy analysis:', analysis)
    setHierarchyAnalysis(analysis)
  }

  const groupPointsByLayer = (data: UmapPoint[]) => {
    const groups: Record<number, Map<string, UmapPoint[]>> = {}
    const allClusterIds = new Set()

    for (let layer = 0; layer <= 3; layer++) {
      groups[layer] = new Map()
    }

    data.forEach((point) => {
      Object.entries(point.clusters || {}).forEach(([layerId, clusterId]) => {
        const layer = parseInt(layerId)
        const key = `${layer}_${clusterId}`

        if (layer === 0) {
          allClusterIds.add(clusterId)
        }

        if (!groups[layer]) {
          groups[layer] = new Map()
        }

        if (!groups[layer].has(key)) {
          groups[layer].set(key, [])
        }

        groups[layer].get(key)!.push({
          ...point,
          cluster_id: clusterId as string,
          layer: layer
        })
      })
    })

    return groups
  }

  const fetchUMAPData = useCallback(
    async (conversationId: string) => {
      try {
        console.log('Fetching UMAP data for spatial filtering...')

        const data = (await fetchTopicModProximity(conversationId, 'all')) as {
          status: string
          proximity_data: UmapPoint[]
        }

        if (data.status === 'success' && data.proximity_data) {
          console.log(`Loaded ${data.proximity_data.length} UMAP points for spatial filtering`)
          setUmapData(data.proximity_data)

          const groups = groupPointsByLayer(data.proximity_data)
          setClusterGroups(groups)

          console.log('UMAP cluster groups:', groups)
        } else {
          console.log('No UMAP data available for spatial filtering')
        }
      } catch (err) {
        console.error('Error fetching UMAP data:', err)
      }
    },
    [reportId]
  )

  useEffect(() => {
    if (!reportId || load === false) return

    const loadTopicData = async () => {
      setLoading(true)
      try {
        const response = await fetchDelphiTopicData(reportId)
        console.log('TopicAgenda topics response:', response)

        if (!response || response.status !== 'success') {
          setError('Failed to retrieve topic data')
          return
        }

        if (!response.runs || Object.keys(response.runs).length === 0) {
          setError('No LLM topic data available yet. Run Delphi analysis first.')
          return
        }

        setTopicData(response)
        analyzeHierarchy(response)
      } catch (err) {
        console.error('Error fetching topic data:', err)
        setError('Failed to connect to the topicMod endpoint')
      } finally {
        setLoading(false)
      }
    }

    loadTopicData()
  }, [reportId, load])

  return {
    loading,
    error,
    topicData,
    hierarchyAnalysis,
    umapData,
    clusterGroups,
    fetchUMAPData
  }
}
