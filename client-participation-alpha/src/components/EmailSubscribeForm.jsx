import React, { useState } from 'react';

// Mock API for submitting an email
const subscribeAPI = (email) => {
  console.log(`Subscribing email: ${email}`);
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log('Email subscribed successfully.');
      resolve({ success: true, message: 'Thanks for subscribing!' });
    }, 1000);
  });
};

export default function EmailSubscribeForm() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    const result = await subscribeAPI(email);
    setIsSubmitting(false);

    if (result.success) {
      setFeedback(result.message);
    }
  };

  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>;
  }

  return (
    <div className="email-subscribe-container">
      <h2>Get results by email</h2>
      <form className="email-subscribe-form" onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
          required
        />
        <button type="submit" className="submit-button" disabled={isSubmitting || !email.includes('@')}>
          {isSubmitting ? '...' : 'Subscribe'}
        </button>
      </form>
    </div>
  );
}
