import { Group } from '@visx/group'
import { motion } from 'motion/react'
import type { UserPosition } from './types'

interface UserPositionIndicatorProps {
  userPosition: UserPosition
}

export function UserPositionIndicator({ userPosition }: UserPositionIndicatorProps) {
  return (
    <Group>
      <defs>
        <pattern
          id="user-profile-pattern"
          x="0"
          y="0"
          width="1"
          height="1"
          patternContentUnits="objectBoundingBox"
        >
          <image
            x="0"
            y="0"
            width="1"
            height="1"
            // Use a relative URL so it works when app is mounted at /alpha/ behind nginx
            xlinkHref="anonProfile.svg"
            preserveAspectRatio="xMidYMid slice"
          />
        </pattern>
        <filter id="grayscale-filter">
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <motion.circle
        cx={userPosition.x}
        cy={userPosition.y}
        r={13}
        fill="none"
        stroke="#03a9f4"
        strokeWidth={4}
        initial={false}
        animate={{
          cx: userPosition.x,
          cy: userPosition.y
        }}
        transition={{
          duration: 0.8,
          ease: 'easeInOut'
        }}
      />
      <motion.circle
        cx={userPosition.x}
        cy={userPosition.y}
        r={11}
        fill="url(#user-profile-pattern)"
        filter="url(#grayscale-filter)"
        initial={false}
        animate={{
          cx: userPosition.x,
          cy: userPosition.y
        }}
        transition={{
          duration: 0.8,
          ease: 'easeInOut'
        }}
      />
    </Group>
  )
}
