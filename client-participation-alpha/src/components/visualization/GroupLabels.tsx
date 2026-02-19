import { Group } from '@visx/group'
import { motion } from 'motion/react'
import GroupIcon from '../icons/GroupIcon'
import { groupLetters } from './constants'
import type { Hull, UserPosition } from './types'

interface GroupLabelsProps {
  hulls: Hull[]
  selectedGroup: number | null
  userPosition: UserPosition | null
}

export function GroupLabels({ hulls, selectedGroup, userPosition }: GroupLabelsProps) {
  return (
    <>
      {hulls.map(({ groupId, participantCount, center }) => {
        if (!center || participantCount <= 0) return null

        const isSelected = selectedGroup === groupId
        const labelLetter = groupLetters[groupId] ?? ''
        const iconSize = 16
        let labelOffsetX = 0
        let labelOffsetY = 28
        const padding = 6

        // Adjust label position to avoid obscuring user circle
        if (userPosition) {
          // User indicator dimensions (radius + stroke)
          const userRadius = 17

          // Estimate label dimensions for collision detection
          const letterWidth = 8
          const numberWidth = participantCount.toString().length * 12
          const contentWidth = letterWidth + iconSize + numberWidth + 12
          const labelWidth = contentWidth + padding * 2
          const labelHeight = iconSize + padding * 2

          // Default label position (above hull center)
          const defaultLabelX = center[0]
          const defaultLabelY = center[1] - labelOffsetY

          // Calculate distance from label center to user position
          const dx = defaultLabelX - userPosition.x
          const dy = defaultLabelY - userPosition.y
          const dist = Math.hypot(dx, dy)

          // Check if label and user indicator overlap
          // Minimum safe distance = user radius + half label diagonal + small buffer
          const labelDiagonal = Math.hypot(labelWidth, labelHeight)
          const minSafeDistance = userRadius + labelDiagonal / 2 + 8

          if (dist < minSafeDistance) {
            // Calculate displacement vector (direction away from user)
            const angle = Math.atan2(dy, dx)
            const displacement = minSafeDistance - dist

            // Push label away from user position
            labelOffsetX += Math.cos(angle) * displacement
            labelOffsetY += Math.sin(angle) * displacement
          }
        }
        const cornerRadius = 6
        const textStyle = {
          fill: isSelected ? '#ffffff' : 'currentColor',
          fontSize: 12,
          fontWeight: 600
        } as const

        // Calculate content positions (relative to center)
        const letterX = -(iconSize / 2) - 6 // Right edge of letter (textAnchor="end")
        const iconX = -iconSize / 2
        const numberX = iconSize / 2 + 4

        // Estimate label dimensions
        const letterWidth = 8
        const numberWidth = participantCount.toString().length * 12
        const contentLeft = letterX - letterWidth // Left edge of letter
        const contentRight = numberX + numberWidth // Right edge of number
        const contentWidth = contentRight - contentLeft
        const labelWidth = contentWidth + padding * 2
        const labelHeight = iconSize + padding * 2

        // Position rectangle so content is centered within it
        const labelX = contentLeft - padding
        const labelY = -(labelHeight / 2)

        // Calculate offset to center the content group
        const contentCenterX = (contentLeft + contentRight) / 2

        const finalLeft = center[0] - contentCenterX + labelOffsetX
        const finalTop = center[1] - labelOffsetY

        return (
          <Group key={`group-label-${groupId}`} pointerEvents="none">
            <motion.g
              initial={false}
              animate={{
                transform: `translate(${finalLeft}px, ${finalTop}px)`
              }}
              transition={{
                duration: 0.4,
                ease: 'easeOut'
              }}
              style={{ color: isSelected ? '#ffffff' : 'var(--color-text)' }}
            >
              {/* Background rectangle */}
              <rect
                x={labelX}
                y={labelY}
                width={labelWidth}
                height={labelHeight}
                rx={cornerRadius}
                ry={cornerRadius}
                fill={isSelected ? '#03a9f4' : 'var(--color-surface)'}
                stroke={isSelected ? '#03a9f4' : 'var(--color-border)'}
                strokeWidth={1}
              />
              <text x={letterX} y={iconSize / 2 - 4} textAnchor="end" {...textStyle}>
                {labelLetter}
              </text>
              <g transform={`translate(${iconX}, ${-iconSize / 2})`}>
                <GroupIcon size={iconSize} fill={isSelected ? '#ffffff' : undefined} />
              </g>
              <text x={numberX} y={iconSize / 2 - 4} textAnchor="start" {...textStyle}>
                {participantCount}
              </text>
            </motion.g>
          </Group>
        )
      })}
    </>
  )
}
