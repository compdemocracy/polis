import { motion } from 'motion/react'
import { groupColors } from './constants'
import type { Hull } from './types'

interface GroupHullsProps {
  hulls: Hull[]
  selectedGroup: number | null
}

export function GroupHulls({ hulls, selectedGroup }: GroupHullsProps) {
  return (
    <>
      {hulls.map(({ groupId, hull, points }) => {
        const baseColor = groupColors[groupId] ?? '#e0e0e0'
        const isSelected = selectedGroup === groupId

        // Darker when selected, base gray when not
        const color = isSelected ? '#555555' : baseColor

        const groupKey = `group-${groupId}`

        if (hull) {
          const pathString = `M${hull.map((point: number[]) => point.join(',')).join('L')}Z`
          return (
            <motion.path
              key={`${groupKey}-hull`}
              d={pathString}
              fill={color}
              fillOpacity={isSelected ? 0.35 : 0.2}
              stroke={color}
              strokeWidth={isSelected ? 4 : 2}
              strokeOpacity={isSelected ? 1 : 1}
              initial={false}
              animate={{
                d: pathString,
                fill: color,
                fillOpacity: isSelected ? 0.35 : 0.2,
                strokeWidth: isSelected ? 3 : 2
              }}
              transition={{
                duration: 0.8,
                ease: 'easeInOut'
              }}
            />
          )
        }

        if (points.length === 2) {
          return (
            <motion.line
              key={`${groupKey}-line`}
              x1={points[0][0]}
              y1={points[0][1]}
              x2={points[1][0]}
              y2={points[1][1]}
              stroke={color}
              strokeWidth={isSelected ? 4 : 2}
              strokeLinecap="round"
              initial={false}
              animate={{
                x1: points[0][0],
                y1: points[0][1],
                x2: points[1][0],
                y2: points[1][1],
                stroke: color,
                strokeWidth: isSelected ? 3 : 2
              }}
              transition={{ duration: 0.8, ease: 'easeInOut' }}
            />
          )
        }

        return null
      })}
    </>
  )
}
