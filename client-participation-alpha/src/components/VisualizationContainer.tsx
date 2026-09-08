import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchComments } from '../api/comments'
import { fetchPCAData, PCA_VISUALIZATION_KEYS } from '../api/pca'
import type { Comment, PCAData } from '../api/types'
import type { Translations } from '../strings/types'
import { PCAVisualization } from './visualization'
import { REFRESH_DELAY_MS } from './visualization/constants'

interface VisualizationContainerProps {
  conversation_id: string
  s: Translations
}

export default function VisualizationContainer({
  conversation_id,
  s
}: VisualizationContainerProps) {
  const [pcaData, setPcaData] = useState<PCAData | null>(null)
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The last math tick we applied, together with the conversation it came
  // from. A tick is a per-conversation generation counter, so conversation B's
  // tick 7 says nothing about conversation A's tick 7 — comparing them across
  // a switch would leave A's math on screen under B's id.
  const lastMathTick = useRef<{ conversationId: string; tick: number | undefined } | null>(null)
  // Monotonically increasing request generation. Every call to loadData takes
  // the next one and is only allowed to touch state while it still holds the
  // current one. Conversation identity is NOT sufficient for this: A -> B -> A
  // returns to the same id, so an id check would let the first A's late
  // response through to overwrite the second A's. Generations never repeat.
  const requestGeneration = useRef(0)
  const refetchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const loadData = useCallback(
    async (showLoadingState = true) => {
      // Taken before anything else, so even the empty-id early return
      // invalidates whatever was in flight.
      const generation = ++requestGeneration.current
      const conversationId = conversation_id

      if (!conversationId) {
        setLoading(false)
        setError('No conversation ID provided')
        return
      }

      try {
        if (showLoadingState) {
          setLoading(true)
        }
        setError(null)

        // Fetch both PCA data and comments in parallel
        const [pcaDataResult, commentsResult] = await Promise.all([
          fetchPCAData(conversationId, PCA_VISUALIZATION_KEYS),
          fetchComments(conversationId)
        ])

        if (requestGeneration.current !== generation) {
          // A newer request has been started since; this response is stale.
          return
        }

        // Comments do not depend on the math tick: submitting or editing a
        // statement changes this response while the tick stands still, so
        // they are applied unconditionally. Only the PCA state is guarded.
        setComments(commentsResult)

        const tick = pcaDataResult.math_tick
        const applied = lastMathTick.current
        if (
          tick !== undefined &&
          applied !== null &&
          applied.conversationId === conversationId &&
          applied.tick === tick
        ) {
          // Math hasn't been recalculated yet, the PCA data is the same
          return
        }

        lastMathTick.current = { conversationId, tick }
        setPcaData(pcaDataResult)
      } catch (err) {
        if (requestGeneration.current !== generation) {
          // A stale failure must not surface over a newer successful visit.
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to fetch data')
        console.error('Error fetching data:', err)
      } finally {
        // The spinner belongs to the in-flight sequence, not to the request
        // that turned it on. Whichever request is current when it finishes
        // settles it — including a background poll (showLoadingState false)
        // that superseded a pending initial load, which would otherwise leave
        // the spinner up with no request left to take it down. A stale request
        // still clears nothing.
        if (requestGeneration.current === generation) {
          setLoading(false)
        }
      }
    },
    [conversation_id]
  )

  // Initial load
  useEffect(() => {
    loadData()
    return () => {
      // Conversation change or unmount: whatever is in flight belongs to a
      // visit we have left, so retire its generation.
      requestGeneration.current += 1
    }
  }, [loadData])

  // Listen for vote/comment submissions and refetch after delay
  useEffect(() => {
    const handleDataChange = (e: Event) => {
      console.log('handleDataChange', (e as CustomEvent).detail)
      const detail = (e as CustomEvent).detail
      if (detail && detail.conversation_id === conversation_id) {
        // Clear any pending refetch
        if (refetchTimeoutRef.current) {
          clearTimeout(refetchTimeoutRef.current)
        }

        // Schedule refetch after 1 second delay
        refetchTimeoutRef.current = setTimeout(() => {
          loadData(false) // Don't show loading state for updates
        }, REFRESH_DELAY_MS)
      }
    }

    window.addEventListener('polis-vote-submitted', handleDataChange)
    window.addEventListener('polis-comment-submitted', handleDataChange)

    return () => {
      window.removeEventListener('polis-vote-submitted', handleDataChange)
      window.removeEventListener('polis-comment-submitted', handleDataChange)
      if (refetchTimeoutRef.current) {
        clearTimeout(refetchTimeoutRef.current)
      }
    }
  }, [conversation_id, loadData])

  if (loading) {
    return (
      <section
        className="section-card loading-state"
        style={{ textAlign: 'center', padding: '2rem' }}
      >
        <p>Loading visualization data...</p>
      </section>
    )
  }

  if (error) {
    return (
      <section
        className="section-card"
        style={{ textAlign: 'center', padding: '2rem', color: '#666' }}
      >
        <p>Visualization unavailable</p>
      </section>
    )
  }

  if (!pcaData) {
    return null
  }

  return (
    <div className="visualization-container">
      <PCAVisualization data={pcaData} comments={comments} conversationId={conversation_id} s={s} />
    </div>
  )
}
