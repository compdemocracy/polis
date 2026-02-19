import { useEffect, useState } from 'react'
import { fetchNextComment } from '../api/comments'
import { submitVote } from '../api/votes'
import { getConversationToken } from '../lib/auth'
import type { Translations } from '../strings/types'
import EmailSubscribeForm from './EmailSubscribeForm'
import InviteCodeSubmissionForm from './InviteCodeSubmissionForm'
import { Statement } from './Statement'
import type { StatementData, VoteData } from './types'

interface SurveyProps {
  initialStatement?: StatementData
  s: Translations
  conversation_id: string
  requiresInviteCode?: boolean
  importanceEnabled?: boolean
}

const submitVoteAndGetNextCommentAPI = async (
  vote: VoteData,
  conversation_id: string,
  high_priority: boolean = false
) => {
  const decodedToken = getConversationToken(conversation_id)

  const resp = await submitVote({
    agid: 1,
    conversation_id,
    high_priority,
    pid: decodedToken?.pid || -1,
    tid: vote.tid,
    vote: vote.vote
  })

  // Dispatch event to notify visualization to update
  window.dispatchEvent(
    new CustomEvent('polis-vote-submitted', {
      detail: { conversation_id }
    })
  )
  console.log('dispatched polis-vote-submitted event')

  return resp
}

export default function Survey({
  initialStatement,
  s,
  conversation_id,
  requiresInviteCode = false,
  importanceEnabled = false
}: SurveyProps) {
  const [statement, setStatement] = useState<StatementData | undefined>(initialStatement)
  const [isFetchingNext, setIsFetchingNext] = useState<boolean>(false)
  const [isStatementImportant, setIsStatmentImportant] = useState<boolean>(false)
  const [voteError, setVoteError] = useState<string | null>(null)
  const [inviteGate, setInviteGate] = useState<boolean>(requiresInviteCode)

  // On hydration, fetch a participant-personalized next comment.
  // This replaces the SSR-provided generic comment if needed.
  useEffect(() => {
    let cancelled = false
    const loadPersonalizedFirst = async () => {
      try {
        getConversationToken(conversation_id)
        const resp = await fetchNextComment(conversation_id)

        if (!cancelled) {
          if (resp && typeof resp.tid !== 'undefined') {
            const mapped: StatementData = {
              tid: resp.tid,
              txt: resp.txt,
              remaining: resp.remaining,
              lang: resp.lang,
              translations: resp.translations
            }
            setStatement((prev) => {
              if (!prev || mapped.tid !== prev.tid) {
                return mapped
              }
              return prev
            })
          } else {
            // No personalized next comment available; hide the SSR fallback.
            setStatement(undefined)
          }
        }
      } catch (e) {
        // Non-fatal; keep SSR statement
        console.warn('Personalized first comment fetch failed', e)
      }
    }
    // Initial fetch (SSR may have random, we try to personalize even before auth if possible)
    loadPersonalizedFirst()

    // Also re-fetch after login/invite acceptance to personalize post-auth
    const onInviteAccepted = () => {
      loadPersonalizedFirst()
    }
    const onLoginSuccess = () => {
      loadPersonalizedFirst()
    }
    window.addEventListener('invite-code-submitted', onInviteAccepted)
    window.addEventListener('login-code-submitted', onLoginSuccess)

    return () => {
      cancelled = true
      window.removeEventListener('invite-code-submitted', onInviteAccepted)
      window.removeEventListener('login-code-submitted', onLoginSuccess)
    }
    // Run once on mount for this conversation
  }, [conversation_id])

  // On mount, determine whether to show the invite/login gate based on JWT presence
  useEffect(() => {
    const token = getConversationToken(conversation_id)
    if (token && token.token) {
      setInviteGate(false)
    } else {
      setInviteGate(requiresInviteCode)
    }

    const onInviteAccepted = () => setInviteGate(false)
    const onLoginSuccess = () => setInviteGate(false)
    window.addEventListener('invite-code-submitted', onInviteAccepted)
    window.addEventListener('login-code-submitted', onLoginSuccess)
    return () => {
      window.removeEventListener('invite-code-submitted', onInviteAccepted)
      window.removeEventListener('login-code-submitted', onLoginSuccess)
    }
  }, [conversation_id, requiresInviteCode])

  const handleVote = async (voteType: number, tid: number | string) => {
    setIsFetchingNext(true)
    setVoteError(null)

    try {
      const vote: VoteData = { vote: voteType, tid: tid }
      const result = await submitVoteAndGetNextCommentAPI(
        vote,
        conversation_id,
        importanceEnabled ? isStatementImportant : false
      )

      setVoteError(null)
      if (result?.nextComment) {
        setStatement(result.nextComment)
      } else {
        setStatement(undefined)
      }
      setIsStatmentImportant(false)
    } catch (err: unknown) {
      console.error('Vote submission failed:', err)
      let errorMessage = s.voteFailedGeneric

      // Check error.responseText first (from net.js), then fall back to error.message
      const error = err as { responseText?: string; message?: string }
      const errorText = error.responseText || error.message || ''

      if (errorText.includes('polis_err_conversation_is_closed')) {
        errorMessage = s.convIsClosed
      } else if (errorText.includes('polis_err_post_votes_social_needed')) {
        errorMessage = s.signInToVote
      } else if (errorText.includes('polis_err_xid_not_allowed')) {
        errorMessage = s.xidRequired
      } else if (errorText.includes('polis_err_xid_required')) {
        errorMessage = s.xidRequired
      }

      setVoteError(errorMessage)
    } finally {
      setIsFetchingNext(false)
    }
  }

  if (inviteGate) {
    return <InviteCodeSubmissionForm s={s as Translations} conversation_id={conversation_id} />
  }

  return (
    <>
      {statement ? (
        <Statement
          statement={statement}
          onVote={handleVote}
          isVoting={isFetchingNext}
          s={s as Translations}
          isStatementImportant={isStatementImportant}
          setIsStatmentImportant={setIsStatmentImportant}
          voteError={voteError}
          importanceEnabled={importanceEnabled}
        />
      ) : (
        <EmailSubscribeForm s={s as Translations} conversation_id={conversation_id} />
      )}
    </>
  )
}
