import { useCallback, useEffect, useState } from 'react'
import { fetchComments } from '../../api/comments'
import { fetchDelphiReport } from '../../api/delphi'
import { fetchParticipationInit } from '../../api/participation'
import {
  fetchTopicAgendaSelections,
  fetchTopicPrioritize,
  saveTopicAgendaSelections
} from '../../api/topicAgenda'
import { getConversationToken } from '../../lib/auth'
import type { Translations } from '../../strings/types'
import LayerHeader from './components/LayerHeader'
import ScrollableTopicsGrid from './components/ScrollableTopicsGrid'
import TopicAgendaStyles from './components/TopicAgendaStyles'
import { useTopicData } from './hooks/useTopicData'
import type { TopicAgendaComment as Comment, ReportData, TopicAgendaProps } from './types'
import { extractArchetypalComments } from './utils/archetypeExtraction'

const TopicAgenda = ({
  conversation_id,
  requiresInviteCode = false,
  s = {} as Translations
}: TopicAgendaProps) => {
  const [loadWidget, setLoadWidget] = useState<boolean>(false)
  const [selections, setSelections] = useState<Set<string>>(new Set())
  const [commentMap, setCommentMap] = useState<Map<string | number, string>>(new Map())
  const [comments, setComments] = useState<Comment[]>([])
  const [reportData, setReportData] = useState<ReportData>({})
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [err, setError] = useState<string | null>(null)
  const [conversation, setConversation] = useState<unknown>(null)
  const [inviteCodeRequired, setInviteCodeRequired] = useState<boolean>(requiresInviteCode)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const [submissionSuccess, setSubmissionSuccess] = useState<boolean>(false)

  const { error, topicData, hierarchyAnalysis, clusterGroups, fetchUMAPData } = useTopicData(
    reportData?.report_id,
    loadWidget
  )

  useEffect(() => {
    const token = getConversationToken(conversation_id)
    if (token && token.token) {
      setInviteCodeRequired(false)
    }
    const cb1 = () => setInviteCodeRequired(false)
    const cb2 = () => setInviteCodeRequired(false)
    window.addEventListener('invite-code-submitted', cb1)
    window.addEventListener('login-code-submitted', cb2)
    return () => {
      window.removeEventListener('invite-code-submitted', cb1)
      window.removeEventListener('login-code-submitted', cb2)
    }
  }, [conversation_id])

  useEffect(() => {
    const checkTopicPrioritize = async () => {
      // Check if topic prioritization is available for this conversation
      try {
        const topicPrioritizeResponse = await fetchTopicPrioritize(conversation_id)

        if (topicPrioritizeResponse) {
          const topicPrioritizeData = topicPrioritizeResponse
          console.log('Topic prioritize check:', topicPrioritizeData)

          if (topicPrioritizeData.has_report && topicPrioritizeData.report_id) {
            setReportData({
              report_id: topicPrioritizeData.report_id,
              conversation_id: topicPrioritizeData.conversation_id
            })
            // Also fetch full convo with PCA (large query)
            const convoFetcher = await fetchParticipationInit(conversation_id, {
              includePCA: true
            })
            if (convoFetcher) {
              setConversation(convoFetcher)
            }

            // Also fetch comments for the TopicAgenda
            // Use the original zinvite for the comments API, not the numeric conversation_id
            const commentsResponse = await fetchComments(conversation_id, {
              moderation: true,
              include_voting_patterns: true
            })

            if (commentsResponse) {
              const cd = commentsResponse as unknown as Comment[]
              console.log(`Found ${cd.length} comments for topic prioritization`)
              setComments(cd)
            }
          }
        }
      } catch (err) {
        console.error('Failed to check topic prioritization availability:', err)
      }
    }
    if (loadWidget) {
      checkTopicPrioritize()
    }
  }, [loadWidget, conversation_id])

  // Build comment map for easy lookup
  useEffect(() => {
    if (comments && comments.length > 0 && loadWidget) {
      const map = new Map<string | number, string>()
      comments.forEach((comment) => {
        // Store by both tid (as number) and as string for flexibility
        map.set(comment.tid, comment.txt)
        map.set(String(comment.tid), comment.txt)
      })
      setCommentMap(map)
      console.log(`Built comment map with ${map.size / 2} comments`)
    }
  }, [comments, loadWidget])

  // Fetch UMAP data when topic data is loaded
  useEffect(() => {
    if (topicData && conversation && loadWidget) {
      fetchUMAPData(conversation_id)
    }
  }, [topicData, conversation, fetchUMAPData, loadWidget, conversation_id])

  const loadPreviousSelections = useCallback(async () => {
    try {
      const result = await fetchTopicAgendaSelections(conversation_id)
      if (result.status === 'success' && result.data) {
        const storedSelections = new Set<string>()
        result.data.archetypal_selections.forEach((selection: { topic_key: string }) => {
          storedSelections.add(selection.topic_key)
        })
        setSelections(storedSelections)
        console.log('Loaded previous selections:', Array.from(storedSelections))
      }
    } catch (error) {
      console.error('Error loading previous selections:', error)
    }
  }, [conversation_id])

  // Load previous selections when widget loads
  useEffect(() => {
    if (loadWidget && conversation_id) {
      loadPreviousSelections()
    }
  }, [conversation_id, loadWidget, loadPreviousSelections])

  useEffect(() => {
    const checkForData = async () => {
      try {
        const topicPrioritizeResponse = await fetchTopicPrioritize(conversation_id)

        if (!topicPrioritizeResponse?.has_report || !topicPrioritizeResponse.report_id) {
          setError('Failed to retrieve topic data')
          return
        }

        const delphiResponse = await fetchDelphiReport(topicPrioritizeResponse.report_id)

        if (!delphiResponse || delphiResponse.status !== 'success') {
          setError('Failed to retrieve topic data')
          return
        }

        if (!delphiResponse.runs || Object.keys(delphiResponse.runs).length === 0) {
          setError('No LLM topic data available yet. Run Delphi analysis first.')
        }
      } catch (err) {
        console.error('Error fetching topic data:', err)
        setError('Failed to connect to the topicMod endpoint')
      } finally {
        setIsLoading(false)
      }
    }
    checkForData()
  }, [conversation_id])

  const toggleTopicSelection = (topicKey: string) => {
    const newSelections = new Set(selections)
    if (newSelections.has(topicKey)) {
      newSelections.delete(topicKey)
    } else {
      newSelections.add(topicKey)
    }
    setSelections(newSelections)
  }

  const handleDone = async () => {
    setSubmissionError(null)
    setSubmissionSuccess(false)

    try {
      // Convert topic selections to archetypal comments
      console.log('Selected topics:', Array.from(selections))

      // Extract archetypal comments from selections
      const archetypes = extractArchetypalComments(selections, topicData, clusterGroups, commentMap)
      console.log('Extracted archetypes:', archetypes)

      // Log in a more readable format
      console.log('\n=== SELECTED ARCHETYPAL COMMENTS ===')
      archetypes.forEach((group) => {
        console.log(`\nTopic: Layer ${group.layerId}, Cluster ${group.clusterId}`)
        group.archetypes.forEach((archetype, i) => {
          console.log(`  ${i + 1}. "${archetype.text}" (ID: ${archetype.commentId})`)
        })
      })
      console.log('=====================================\n')

      // Transform to API format
      const apiSelections = archetypes.map((group) => ({
        layer_id: group.layerId,
        cluster_id: group.clusterId,
        topic_key: group.topicKey,
        archetypal_comments: group.archetypes.map((a) => ({
          comment_id: a.commentId,
          comment_text: a.text,
          coordinates: a.coordinates,
          distance_to_centroid: a.distance
        }))
      }))

      // Send to API (token storage handled centrally in net module)
      const result = await saveTopicAgendaSelections({
        conversation_id,
        selections: apiSelections
      })

      if (result.status === 'success') {
        console.log('Topic agenda selections saved successfully:', result.data)
        setSubmissionSuccess(true)
        // Auto-hide success message after 3 seconds
        setTimeout(() => setSubmissionSuccess(false), 3000)
      } else {
        console.error('Failed to save selections:', result.message)
        setSubmissionError(result.message || 'Failed to save topic selections')
      }
    } catch (err: unknown) {
      console.error('Error saving topic agenda selections:', err)

      // Parse error message
      const error = err as { responseText?: string; message?: string }
      const errorText = error.responseText || error.message || ''
      let errorMessage = s.failedToSaveTopicSelections

      if (errorText.includes('polis_err_xid_required')) {
        errorMessage = s.xidRequired
      } else if (errorText.includes('polis_err_xid_not_allowed')) {
        errorMessage = s.xidRequired
      } else if (errorText.includes('polis_err_conversation_is_closed')) {
        errorMessage = s.convIsClosed
      } else if (errorText.includes('polis_err_post_votes_social_needed')) {
        errorMessage = s.signInToParticipate
      }

      setSubmissionError(errorMessage)
    }
  }

  if (isLoading || err || inviteCodeRequired) {
    return null
  }

  if (!isLoading && err) {
    return null
  }

  if (!loadWidget && !isLoading && !err) {
    return (
      <div
        style={{
          height: '195px',
          border: '1px solid #e0e0e0',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f9f9f9'
        }}
      >
        <button
          onClick={() => setLoadWidget(true)}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            cursor: 'pointer',
            border: '1px solid #ccc',
            borderRadius: '4px'
          }}
        >
          {s.selectTopics}
        </button>
      </div>
    )
  }

  // Render conditionally after all hooks are called
  let content = null

  if (error) {
    content = (
      <div className="topic-agenda-widget">
        <div className="error-message">
          <h3>{s.error}</h3>
          <p>{error}</p>
        </div>
      </div>
    )
  } else if (comments.length > 0 && Object.keys(reportData).length > 0) {
    content = (
      <div className="topic-agenda-widget">
        <div className="current-layer">
          <LayerHeader />

          <ScrollableTopicsGrid
            topicData={topicData}
            selections={selections}
            onToggleSelection={toggleTopicSelection}
            clusterGroups={clusterGroups}
            hierarchyAnalysis={hierarchyAnalysis}
            s={s}
          />

          {submissionError && (
            <div
              style={{
                backgroundColor: '#f8d7da',
                border: '1px solid #f5c6cb',
                borderRadius: '4px',
                padding: '12px 16px',
                margin: '12px 0',
                color: '#721c24',
                fontSize: '14px',
                textAlign: 'center'
              }}
            >
              {submissionError}
            </div>
          )}

          {submissionSuccess && (
            <div
              style={{
                backgroundColor: '#d4edda',
                border: '1px solid #c3e6cb',
                borderRadius: '4px',
                padding: '12px 16px',
                margin: '12px 0',
                color: '#155724',
                fontSize: '14px',
                textAlign: 'center'
              }}
            >
              {s.topicSelectionsSavedSuccess}
            </div>
          )}

          <div className="done-button-container">
            <button className="done-button" onClick={handleDone} disabled={selections.size === 0}>
              {s.doneWithCount.replace('{{count}}', String(selections.size))}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Always return the same component structure
  if (!content) return null

  return (
    <div className="topic-agenda">
      {content}
      <TopicAgendaStyles />
    </div>
  )
}

export default TopicAgenda
