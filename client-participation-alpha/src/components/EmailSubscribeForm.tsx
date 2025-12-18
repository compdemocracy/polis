import React, { useState } from 'react'
import { subscribeToNotifications } from '../api/notifications'
import type { Translations } from '../strings/types'

interface EmailSubscribeFormProps {
  s: Translations
  conversation_id: string
}

const subscribeAPI = async (email: string, conversation_id: string) => {
  return await subscribeToNotifications({
    email,
    conversation_id,
    frequency: 1
  })
}

export default function EmailSubscribeForm({ s, conversation_id }: EmailSubscribeFormProps) {
  const [email, setEmail] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [feedback, setFeedback] = useState<string>('')
  const [errorFeedback, setErrorFeedback] = useState<string>('')

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting || !email.includes('@')) return

    setIsSubmitting(true)
    setFeedback('')
    setErrorFeedback('')

    try {
      await subscribeAPI(email, conversation_id)
      setFeedback(s.notificationsAlreadySubscribed)
    } catch (error) {
      console.error('Subscription failed:', error)
      setErrorFeedback(s.notificationsSubscribeErrorGeneric)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>
  }

  return (
    <div className="email-subscribe-container">
      <h2>{s.notificationsGetNotified}</h2>
      <form className="email-subscribe-form" onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder={s.notificationsEnterEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
          required
        />
        <button
          type="submit"
          className="submit-button"
          disabled={isSubmitting || !email.includes('@')}
        >
          {isSubmitting ? '...' : s.notificationsSubscribeButton}
        </button>
      </form>
      {errorFeedback && <p className="subscribe-error">{errorFeedback}</p>}
    </div>
  )
}
