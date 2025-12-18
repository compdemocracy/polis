import CheckmarkIcon from '../../icons/CheckmarkIcon'
import type { TopicEntry, UmapPoint } from '../types'
import { cleanTopicDisplayName } from '../utils/topicUtils'

interface TopicItemProps {
  entry: TopicEntry
  layerId: number
  isSelected: boolean
  onToggleSelection: (topicKey: string) => void
  clusterGroups: Record<number, Map<string, UmapPoint[]>>
  isBanked?: boolean
}

const TopicItem = ({
  entry,
  layerId,
  isSelected,
  onToggleSelection,
  isBanked = false
}: TopicItemProps) => {
  const { clusterId, topic } = entry
  const topicKey = topic.topic_key
  const displayName = cleanTopicDisplayName(topic.topic_name, layerId, clusterId)

  return (
    <div
      className={`topic-item ${
        isBanked ? 'banked-brick' : isSelected ? 'selected brick' : 'unselected'
      }`}
      onClick={isBanked ? undefined : () => onToggleSelection(topicKey)}
      role={isBanked ? undefined : 'button'}
      tabIndex={isBanked ? undefined : 0}
      onKeyDown={
        isBanked
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggleSelection(topicKey)
              }
            }
      }
      aria-pressed={isBanked ? undefined : isSelected}
      aria-disabled={isBanked}
    >
      <div className="topic-content">
        <span className="topic-text">{displayName}</span>
        {isSelected && <CheckmarkIcon size={20} className="topic-checkmark" />}
      </div>
    </div>
  )
}

export default TopicItem
