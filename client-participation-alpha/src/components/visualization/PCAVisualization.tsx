import { Group } from '@visx/group'
import { useEffect, useMemo, useState } from 'react'
import type { Comment, PCAData } from '../../api/types'
import { getConversationToken } from '../../lib/auth'
import type { Translations } from '../../strings/types'
import { GroupHulls } from './GroupHulls'
import { GroupLabels } from './GroupLabels'
import { StatementInfo } from './StatementInfo'
import { UserPositionIndicator } from './UserPositionIndicator'
import { VisualizationControls } from './VisualizationControls'
import { VoteBarCharts } from './VoteBarCharts'
import { height, margin, width, xMax, yMax } from './constants'
import type { SelectedStatement, StatementContext, StatementWithType } from './types'
import { useVisualizationData } from './useVisualizationData'

interface PCAVisualizationProps {
  data: PCAData
  comments?: Comment[] | null
  conversationId?: string
  s: Translations
}

export default function PCAVisualization({
  data,
  comments,
  conversationId,
  s
}: PCAVisualizationProps) {
  const [isConsensusSelected, setisConsensusSelected] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null)
  const [selectedStatement, setSelectedStatement] = useState<SelectedStatement | null>(null)
  const [userPid, setUserPid] = useState<number | null>(null)

  // Get current user's PID
  useEffect(() => {
    const updatePid = () => {
      if (conversationId) {
        const token = getConversationToken(conversationId)
        if (token && typeof token.pid === 'number' && token.pid >= 0) {
          setUserPid(token.pid)
        } else {
          // PID is -1 or invalid - user hasn't voted yet, so they don't have a position on the PCA
          setUserPid(null)
        }
      }
    }

    updatePid()

    const handleTokenUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && detail.conversation_id === conversationId) {
        updatePid()
      }
    }

    window.addEventListener('polis-token-update', handleTokenUpdate)
    return () => window.removeEventListener('polis-token-update', handleTokenUpdate)
  }, [conversationId])

  // Use custom hook to process all visualization data
  const { hulls, originX, originY, userPosition, statements, groupVoteData } = useVisualizationData(
    data,
    selectedGroup,
    isConsensusSelected,
    selectedStatement?.tid ?? null,
    userPid
  )

  // Find the comment text for the selected statement
  const selectedComment = useMemo(() => {
    if (!selectedStatement || !comments) return null
    return comments.find((c) => c.tid === selectedStatement.tid) ?? null
  }, [selectedStatement, comments])

  // Handler for consensus toggle
  const handleConsensusToggle = () => {
    const newValue = !isConsensusSelected
    setisConsensusSelected(newValue)
    if (newValue) {
      setSelectedGroup(null) // Clear group selection when consensus is selected
    }
    setSelectedStatement(null) // Reset selected statement
  }

  // Handler for group selection
  const handleGroupSelect = (groupId: number | null) => {
    setSelectedGroup(groupId)
    if (groupId !== null) {
      setisConsensusSelected(false) // Clear consensus selection when group is selected
    }
    setSelectedStatement(null) // Reset selected statement
  }

  // Handler for statement selection
  const handleStatementSelect = (
    statement: StatementWithType | null,
    context: StatementContext
  ) => {
    if (statement === null) {
      setSelectedStatement(null)
    } else {
      setSelectedStatement({
        ...statement,
        context
      })
    }
  }

  return (
    <section className="section-card">
      <h2>{s.opinionGroups}</h2>
      <svg
        width={width}
        height={height}
        style={{ maxWidth: '100%', height: 'auto' }}
        viewBox={`0 0 ${width} ${height}`}
      >
        <Group left={margin.left} top={margin.top}>
          {/* Origin lines */}
          {originX >= 0 && originX <= xMax && (
            <line
              x1={originX}
              y1={0}
              x2={originX}
              y2={yMax}
              stroke="var(--color-axis-line)"
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          )}
          {originY >= 0 && originY <= yMax && (
            <line
              x1={0}
              y1={originY}
              x2={xMax}
              y2={originY}
              stroke="var(--color-axis-line)"
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          )}

          {/* Group hull polygons (animated) */}
          <GroupHulls hulls={hulls} selectedGroup={selectedGroup} />

          {/* User position indicator */}
          {userPosition && <UserPositionIndicator userPosition={userPosition} />}

          {/* Group labels (rendered above shapes) */}
          <GroupLabels hulls={hulls} selectedGroup={selectedGroup} userPosition={userPosition} />

          {/* Horizontal bar charts for selected statement votes */}
          {selectedStatement && <VoteBarCharts hulls={hulls} groupVoteData={groupVoteData} />}
        </Group>
      </svg>

      {/* Controls */}
      <VisualizationControls
        isConsensusSelected={isConsensusSelected}
        selectedGroup={selectedGroup}
        hulls={hulls}
        statements={statements}
        selectedStatement={selectedStatement}
        onConsensusToggle={handleConsensusToggle}
        onGroupSelect={handleGroupSelect}
        onStatementSelect={handleStatementSelect}
        s={s}
      />

      {/* Statement info */}
      {(isConsensusSelected || selectedGroup !== null) && selectedStatement && (
        <StatementInfo
          selectedStatement={selectedStatement}
          selectedComment={selectedComment}
          s={s}
        />
      )}
    </section>
  )
}
