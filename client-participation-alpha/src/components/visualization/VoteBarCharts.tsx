import { Group } from '@visx/group'
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
        if (!voteInfo || voteInfo.total === 0) return null

        const barWidth = 60 // Total width of the bar chart
        const barHeight = 8
        const barOffsetY = 20 // Position below the label

        // Calculate proportions
        const agreeRatio = voteInfo.agree / voteInfo.total
        const disagreeRatio = voteInfo.disagree / voteInfo.total
        const skipRatio = voteInfo.skip / voteInfo.total

        // Calculate segment widths
        const agreeWidth = agreeRatio * barWidth
        const disagreeWidth = disagreeRatio * barWidth
        const skipWidth = skipRatio * barWidth

        // Starting position
        const startX = -barWidth / 2
        const agreeX = startX
        const disagreeX = startX + agreeWidth
        const skipX = startX + agreeWidth + disagreeWidth

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

            {/* Skip segment (gray/neutral) */}
            {skipWidth > 0 && (
              <rect
                x={skipX}
                y={-barHeight / 2}
                width={skipWidth}
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
