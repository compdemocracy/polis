import React, { useEffect, useState } from 'react'
import { submitComment } from '../api/comments'
import { getConversationToken } from '../lib/auth'
import type { Translations } from '../strings/types'

interface SurveyFormProps {
  s: Translations
  conversation_id: string
  requiresInviteCode?: boolean
}

const submitPerspectiveAPI = async (text: string, conversation_id: string) => {
  const decodedToken = getConversationToken(conversation_id)
  const pid = decodedToken?.pid

  try {
    const resp = await submitComment({
      txt: text.replace(/\n/g, ' '),
      conversation_id,
      pid: pid || -1,
      vote: -1
    })

    // Dispatch event to notify visualization to update
    window.dispatchEvent(
      new CustomEvent('polis-comment-submitted', {
        detail: { conversation_id }
      })
    )
    console.log('dispatched polis-comment-submitted event')

    // The net module automatically handles JWT extraction and storage
    return resp
  } catch (error) {
    console.error('Comment submission failed:', error)
    // Re-throw for caller to handle if needed
    throw error
  }
}

export default function SurveyForm({
  s,
  conversation_id,
  requiresInviteCode = false
}: SurveyFormProps) {
  const [text, setText] = useState<string>('')
  const [feedback, setFeedback] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [isAuthed, setIsAuthed] = useState<boolean>(!!getConversationToken(conversation_id)?.token)
  const maxLength = 400

  useEffect(() => {
    const onInviteOrLogin = () => setIsAuthed(!!getConversationToken(conversation_id)?.token)
    window.addEventListener('invite-code-submitted', onInviteOrLogin)
    window.addEventListener('login-code-submitted', onInviteOrLogin)
    return () => {
      window.removeEventListener('invite-code-submitted', onInviteOrLogin)
      window.removeEventListener('login-code-submitted', onInviteOrLogin)
    }
  }, [conversation_id])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!text.trim()) return

    setFeedback('')
    setError('')
    const submittedText = text
    setText('')

    try {
      await submitPerspectiveAPI(submittedText, conversation_id)
      setFeedback(s.commentSent)
    } catch (err: unknown) {
      console.error('Comment submission failed:', err)

      // Parse error message
      const error = err as { responseText?: string; message?: string }
      const errorText = error.responseText || error.message || ''
      let errorMessage = s.commentSendFailed

      if (errorText.includes('polis_err_conversation_is_closed')) {
        errorMessage = s.commentErrorConversationClosed
      } else if (errorText.includes('polis_err_comment_duplicate')) {
        errorMessage = s.commentErrorDuplicate
      } else if (errorText.includes('polis_err_xid_required')) {
        errorMessage = s.xidRequired
      } else if (errorText.includes('polis_err_xid_not_allowed')) {
        errorMessage = s.xidRequired
      }

      setError(errorMessage)
      // Restore the text so user doesn't lose their work
      setText(submittedText)
    }
  }

  if (requiresInviteCode && !isAuthed) {
    return null
  }

  return (
    <div>
      {feedback && (
        <p
          style={{
            textAlign: 'center',
            color: '#28a745',
            fontWeight: 'bold',
            marginBottom: '1rem'
          }}
        >
          {feedback}
        </p>
      )}
      {error && (
        <p
          style={{
            textAlign: 'center',
            color: '#dc3545',
            fontWeight: 'bold',
            marginBottom: '1rem'
          }}
        >
          {error}
        </p>
      )}
      <div className="guidelines">
        <p dangerouslySetInnerHTML={{ __html: s.writeCommentHelpText }} />
        <h2>{s.helpWriteListIntro}</h2>
        <ul>
          <li>{s.helpWriteListStandalone}</li>
          <li>{s.helpWriteListRaisNew}</li>
          <li>{s.helpWriteListShort}</li>
        </ul>
        <p dangerouslySetInnerHTML={{ __html: s.tipCommentsRandom }}></p>
      </div>
      <form className="submit-form" onSubmit={handleSubmit}>
        <div className="textarea-wrapper">
          <textarea
            placeholder={s.writePrompt}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={maxLength}
          />
          <div className="char-counter">
            {text.length} / {maxLength}
          </div>
        </div>
        <button type="submit" className="submit-button" disabled={!text.trim()}>
          {s.submitComment}
        </button>
      </form>
    </div>
  )
}
