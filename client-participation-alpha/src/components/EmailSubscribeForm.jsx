import PolisNet from '../lib/net';
import React, { useState } from 'react';

const subscribeAPI = async (email, conversation_id) => {
  return await PolisNet.polisPost('/notifications', {
    type: 1,
    email,
    conversation_id,
  });
};

export default function EmailSubscribeForm({ s, conversation_id }) {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorFeedback, setErrorFeedback] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting || !email.includes('@')) return;

    setIsSubmitting(true);
    setFeedback('');
    setErrorFeedback('');

    try {
      await subscribeAPI(email, conversation_id);
      setFeedback(s.notificationsAlreadySubscribed || 'You are subscribed to updates for this conversation.');
    } catch (error) {
      console.error("Subscription failed:", error);
      setErrorFeedback(s.notificationsSubscribeErrorAlert || "Sorry, we couldn't subscribe you. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>;
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
        <button type="submit" className="submit-button" disabled={isSubmitting || !email.includes('@')}>
          {isSubmitting ? '...' : s.notificationsSubscribeButton}
        </button>
      </form>
      {errorFeedback && <p className="subscribe-error">{errorFeedback}</p>}
    </div>
  );
}
