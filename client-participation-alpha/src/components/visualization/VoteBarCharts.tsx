import { Group } from '@visx/group'
import { voteShares } from '../../api/voteCounts'
import { VOTE_BAR_WIDTH } from './constants'
import type { GroupVoteInfo, Hull } from './types'

interface VoteBarChartsProps {
  hulls: Hull[]
  groupVoteData: GroupVoteInfo[]
}

export function VoteBarCharts({ hulls, groupVoteData }: VoteBarChartsProps) {
  if (groupVoteData.length === 0) return null

  return (
    <>
      {hulls.map(({ groupId, center }) => {
        if (!center) return null

        const voteInfo = groupVoteData.find((v) => v.groupId === groupId)
        if (!voteInfo || voteInfo.seen === 0) return null

        const barWidth = VOTE_BAR_WIDTH
        const barHeight = 8
        const barOffsetY = 20 // Position below the label

        // Calculate proportions
        const { agree: agreeRatio, disagree: disagreeRatio, pass: passRatio } = voteShares(voteInfo)

        // Calculate segment widths
        const agreeWidth = agreeRatio * barWidth
        const disagreeWidth = disagreeRatio * barWidth
        const passWidth = passRatio * barWidth

        // Starting position
        const startX = -barWidth / 2
        const agreeX = startX
        const disagreeX = startX + agreeWidth
        const passX = startX + agreeWidth + disagreeWidth

        return (
          <Group
            key={`group-votes-${groupId}`}
            left={center[0]}
            top={center[1] - 8 + barOffsetY}
            pointerEvents="none"
          >
            {/* Agree segment (green) */}
            {agreeWidth > 0 && (
              <rect
                x={agreeX}
                y={-barHeight / 2}
                width={agreeWidth}
                height={barHeight}
                fill="#10b981"
              />
            )}

            {/* Disagree segment (red) */}
            {disagreeWidth > 0 && (
              <rect
                x={disagreeX}
                y={-barHeight / 2}
                width={disagreeWidth}
                height={barHeight}
                fill="#ef4444"
              />
            )}

            {/* Pass segment (gray/neutral) */}
            {passWidth > 0 && (
              <rect
                x={passX}
                y={-barHeight / 2}
                width={passWidth}
                height={barHeight}
                fill="#9ca3af"
                fillOpacity={0.5}
              />
            )}
          </Group>
        )
      })}
    </>
  )
}
