import { useEffect, useRef, useState } from 'react'
import { fetchNextComment } from '../api/comments'
import { submitVote, type Vote } from '../api/votes'
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
    pid: decodedToken?.pid ?? ANONYMOUS_PID,
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

// Server sentinel for an absent conversation identity.
const ANONYMOUS_PID = -1

// A conversation change must not briefly render the previous conversation's text,
// or let one of its pending requests own this survey's state.
export default function Survey(props: SurveyProps) {
  return <ParticipantSurvey key={props.conversation_id} {...props} />
}

function ParticipantSurvey({
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

  const [firstLoad, setFirstLoad] = useState<'loading' | 'checking' | 'ready' | 'error'>(
    initialStatement ? 'checking' : 'loading'
  )
  const displayed = useRef<StatementData | undefined>(initialStatement)
  const firstRequest = useRef(0)
  const voting = useRef(false)
  const mounted = useRef(false)

  const checking = useRef(true)
  const acceptedVote = useRef(false)
  const checkedToken = useRef<string | undefined>(undefined)

  // Check the exact SSR tid; do not make a second draw while it is eligible.
  // Auth may reveal an existing vote. Only that explicit response permits a
  // pre-vote replacement. Late checks never own a vote's acknowledgement.
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const checkFirst = async () => {
      const token = getConversationToken(conversation_id)?.token
      if (voting.current || acceptedVote.current) return
      if (requiresInviteCode && !token) return
      if (!checking.current && checkedToken.current === token) return
      const request = ++firstRequest.current
      if (token) document.documentElement.setAttribute('data-polis-returning', '')
      checking.current = true
      setFirstLoad(displayed.current ? 'checking' : 'loading')
      try {
        const current = displayed.current
        const resp = await fetchNextComment(conversation_id, undefined, current?.tid)
        if (cancelled || request !== firstRequest.current) return
        const next = resp && typeof resp.tid !== 'undefined' ? resp : undefined
        if (current && resp.initialStatus !== 'voted') {
          if (resp.initialStatus !== 'eligible' || next?.tid !== current.tid) {
            setFirstLoad('error')
            return
          }
          // Preserve text and translation bytes even when the server has edits.
        } else {
          displayed.current = next
          setStatement(next)
        }
        checkedToken.current = getConversationToken(conversation_id)?.token
        checking.current = false
        setFirstLoad('ready')
      } catch (e) {
        if (cancelled || request !== firstRequest.current) return
        console.warn('Initial comment eligibility check failed', e)
        setFirstLoad('error')
      }
    }
    void checkFirst()
    window.addEventListener('invite-code-submitted', checkFirst)
    window.addEventListener('login-code-submitted', checkFirst)
    return () => {
      mounted.current = false
      cancelled = true
      window.removeEventListener('invite-code-submitted', checkFirst)
      window.removeEventListener('login-code-submitted', checkFirst)
    }
  }, [conversation_id, requiresInviteCode])

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

  const handleVote = async (voteType: Vote, tid: number | string) => {
    if (checking.current || voting.current || !displayed.current || displayed.current.tid !== tid)
      return
    voting.current = true
    ++firstRequest.current // A pending startup/auth response cannot undo this vote.
    setIsFetchingNext(true)
    setVoteError(null)

    try {
      const vote: VoteData = { vote: voteType, tid: tid }
      const result = await submitVoteAndGetNextCommentAPI(
        vote,
        conversation_id,
        importanceEnabled ? isStatementImportant : false
      )

      if (!mounted.current) return
      setVoteError(null)
      acceptedVote.current = true
      displayed.current = result?.nextComment
      setStatement(result?.nextComment)
      setFirstLoad('ready')
      setIsStatmentImportant(false)
    } catch (err: unknown) {
      if (!mounted.current) return
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
      if (mounted.current) {
        voting.current = false
        setIsFetchingNext(false)
      }
    }
  }

  if (inviteGate) {
    return <InviteCodeSubmissionForm s={s as Translations} conversation_id={conversation_id} />
  }

  if (firstLoad === 'loading') return <p role="status">{s.loading}</p>
  if (firstLoad === 'error')
    return <p role="alert">{s.couldNotLoadConversation.replace('{{error}}', s.error)}</p>

  return (
    <div data-initial-statement={firstLoad === 'checking' ? conversation_id : undefined}>
      {statement ? (
        <Statement
          statement={statement}
          onVote={handleVote}
          isVoting={isFetchingNext || firstLoad !== 'ready'}
          s={s as Translations}
          isStatementImportant={isStatementImportant}
          setIsStatmentImportant={setIsStatmentImportant}
          voteError={voteError}
          importanceEnabled={importanceEnabled}
        />
      ) : (
        <EmailSubscribeForm s={s as Translations} conversation_id={conversation_id} />
      )}
    </div>
  )
}
