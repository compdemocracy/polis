import { scaleLinear } from '@visx/scale'
import concaveman from 'concaveman'
import { useMemo } from 'react'
import type { PCAData } from '../../api/types'
import { CONCAVITY, LENGTH_THRESHOLD, xMax, yMax } from './constants'
import type { BaseCluster, GroupVoteInfo, Hull, StatementWithType, UserPosition } from './types'
import { selectTopConsensusItems } from './utils'

/**
 * Calculate concave hull for a set of points.
 * Returns a closed concave hull polyline or null if not enough points.
 */
function calculateConcaveHull(
  points: [number, number][],
  concavity: number,
  lengthThreshold: number
): [number, number][] | null {
  if (points.length < 3) return null

  const result = concaveman(points, concavity, lengthThreshold)

  if (result.length === 0) {
    return null
  }

  return result as [number, number][]
}

export function useVisualizationData(
  data: PCAData,
  selectedGroup: number | null,
  isConsensusSelected: boolean,
  selectedStatementTid: number | null,
  userPid: number | null
) {
  // Transform the data into a more usable format
  const baseClusters: BaseCluster[] = useMemo(() => {
    const groupClusters = data['group-clusters']

    // Create a map of base cluster ID to group ID
    const clusterToGroup = new Map<number, number>()
    groupClusters.forEach((groupCluster) => {
      groupCluster.members.forEach((memberId) => {
        clusterToGroup.set(memberId, groupCluster.id)
      })
    })

    // Transform base clusters
    const baseClustersData = data['base-clusters']
    return baseClustersData.id.map((id, index) => ({
      id,
      x: baseClustersData.x[index],
      y: baseClustersData.y[index],
      count: baseClustersData.count[index],
      groupId: clusterToGroup.get(id) ?? -1,
      members: baseClustersData.members ? baseClustersData.members[index] : []
    }))
  }, [data])

  // Calculate data bounds for scales
  const xExtent = useMemo(() => {
    const xValues = baseClusters.map((d) => d.x)
    return [Math.min(...xValues), Math.max(...xValues)] as [number, number]
  }, [baseClusters])

  const yExtent = useMemo(() => {
    const yValues = baseClusters.map((d) => d.y)
    return [Math.min(...yValues), Math.max(...yValues)] as [number, number]
  }, [baseClusters])

  // Scales with some padding
  const xScale = useMemo(() => {
    const [min, max] = xExtent
    const padding = (max - min) * 0.1
    return scaleLinear<number>({
      domain: [min - padding, max + padding],
      range: [0, xMax]
    })
  }, [xExtent])

  const yScale = useMemo(() => {
    const [min, max] = yExtent
    const padding = (max - min) * 0.1
    return scaleLinear<number>({
      domain: [min - padding, max + padding],
      range: [0, yMax] // Negative values render upward from origin
    })
  }, [yExtent])

  // Calculate concave hulls for each group
  const hulls: Hull[] = useMemo(() => {
    const groupClusters = data['group-clusters']

    return groupClusters.map((groupCluster) => {
      const groupBaseClusters = baseClusters.filter(
        (cluster) => cluster.groupId === groupCluster.id
      )
      const points = groupBaseClusters.map(
        (cluster) => [xScale(cluster.x), yScale(cluster.y)] as [number, number]
      )
      const participantCount = groupBaseClusters.reduce((sum, cluster) => sum + cluster.count, 0)
      const center = groupCluster.center
        ? ([xScale(groupCluster.center[0]), yScale(groupCluster.center[1])] as [number, number])
        : undefined

      const hull = calculateConcaveHull(points, CONCAVITY, LENGTH_THRESHOLD)
      return { groupId: groupCluster.id, hull, points, participantCount, center }
    })
  }, [data, baseClusters, xScale, yScale])

  // Calculate origin line positions
  const originX = useMemo(() => xScale(0), [xScale])
  const originY = useMemo(() => yScale(0), [yScale])

  // Find user's cluster position
  const userPosition: UserPosition | null = useMemo(() => {
    if (userPid === null || userPid < 0) return null

    const userCluster = baseClusters.find((cluster) => cluster.members.includes(userPid))
    if (!userCluster) return null

    return {
      x: xScale(userCluster.x),
      y: yScale(userCluster.y)
    }
  }, [userPid, baseClusters, xScale, yScale])

  // Extract statements based on current context (consensus or group repness)
  const statements: StatementWithType[] = useMemo(() => {
    if (isConsensusSelected) {
      // Use group-aware-consensus data
      if (data['group-aware-consensus']) {
        const consensusScores = data['group-aware-consensus']
        const selectedTids = selectTopConsensusItems(consensusScores)

        const resultStatements: StatementWithType[] = []

        selectedTids.forEach((tidStr) => {
          const tid = parseInt(tidStr, 10)

          // Calculate stats from group-votes
          let totalAgree = 0
          let totalDisagree = 0

          if (data['group-votes']) {
            Object.values(data['group-votes']).forEach((groupVotes) => {
              const votes = groupVotes.votes[tidStr]
              if (votes) {
                totalAgree += votes.A
                totalDisagree += votes.D
              }
            })
          }

          const totalVotes = totalAgree + totalDisagree
          if (totalVotes > 0) {
            const pAgree = totalAgree / totalVotes
            const pDisagree = totalDisagree / totalVotes

            if (pAgree >= pDisagree) {
              resultStatements.push({
                tid,
                pSuccess: pAgree,
                type: 'agree'
              })
            } else {
              resultStatements.push({
                tid,
                pSuccess: pDisagree,
                type: 'disagree'
              })
            }
          }
        })

        // Sort by pSuccess descending, then by TID ascending
        return resultStatements.sort((a, b) => {
          const pSuccessDiff = b.pSuccess - a.pSuccess
          if (pSuccessDiff !== 0) return pSuccessDiff
          return a.tid - b.tid
        })
      }
    } else if (selectedGroup !== null && data.repness) {
      // Extract repness statements for selected group
      const groupRepness = data.repness[selectedGroup.toString()]
      if (!groupRepness) return []

      return groupRepness
        .map((item) => ({
          tid: item.tid,
          pSuccess: item['p-success'],
          type: item['repful-for'] as 'agree' | 'disagree'
        }))
        .sort((a, b) => {
          const pSuccessDiff = b.pSuccess - a.pSuccess
          if (pSuccessDiff !== 0) return pSuccessDiff
          return a.tid - b.tid
        })
    }

    return []
  }, [isConsensusSelected, selectedGroup, data])

  // Extract vote data for each group for the selected statement
  const groupVoteData: GroupVoteInfo[] = useMemo(() => {
    if (!selectedStatementTid || !data['group-votes']) return []

    const tidString = selectedStatementTid.toString()
    const voteData: GroupVoteInfo[] = []

    Object.entries(data['group-votes']).forEach(([groupIdStr, groupVotes]) => {
      const groupId = parseInt(groupIdStr, 10)
      const votes = groupVotes.votes[tidString]
      if (votes) {
        const total = votes.A + votes.D + votes.S
        voteData.push({
          groupId,
          agree: votes.A,
          disagree: votes.D,
          skip: votes.S,
          total
        })
      }
    })

    return voteData
  }, [selectedStatementTid, data])

  return {
    baseClusters,
    hulls,
    originX,
    originY,
    userPosition,
    statements,
    groupVoteData
  }
}
