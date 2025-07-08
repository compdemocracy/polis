import React, { useState } from 'react';

// Mock API for submitting a new perspective
const submitPerspectiveAPI = (text) => {
  console.log(`Submitting new perspective: "${text}"`);
  return new Promise((resolve) => {
    // Simulate network delay of 1 second
    setTimeout(() => {
      console.log('Perspective submitted successfully.');
      resolve({ success: true, message: 'Thank you for your perspective!' });
    }, 1000);
  });
};

export default function SurveyForm() {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting || !text.trim()) return;

    setIsSubmitting(true);
    const result = await submitPerspectiveAPI(text);
    setIsSubmitting(false);

    if (result.success) {
      setFeedback(result.message);
      setText(''); // Clear the textarea
    }
  };
  
  // If we have success feedback, just show the message
  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>;
  }

  return (
    <div>
      <div className="guidelines">
        <p>Are your perspectives or experiences missing from the conversation? If so, add them in the box below — one at a time.</p>
        <h2>What makes for a good statement?</h2>
        <ul>
          <li>A stand-alone idea</li>
          <li>A new perspective, experience, or issue</li>
          <li>Clear & concise wording (limited to 140 characters)</li>
        </ul>
        <p>Statements are displayed randomly and you are not replying directly to other people's statements: you are adding a stand-alone statement.</p>
      </div>
      <form className="submit-form" onSubmit={handleSubmit}>
        <textarea
          placeholder="Share your perspective (you are not replying — submit a stand-alone statement)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isSubmitting}
        />
        <button type="submit" className="submit-button" disabled={isSubmitting || !text.trim()}>
          {isSubmitting ? 'Submitting...' : 'Submit'}
        </button>
      </form>
    </div>
  );
}