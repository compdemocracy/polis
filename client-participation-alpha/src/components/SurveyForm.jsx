import React, { useState } from 'react';

const submitPerspectiveAPI = (text) => {
  console.log(`Submitting new perspective: "${text}"`);
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log('Perspective submitted successfully.');
      resolve({ success: true });
    }, 1000);
  });
};

export default function SurveyForm({ s }) {
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
      setFeedback(s.commentSent);
      setText('');
    }
  };
  
  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>;
  }

  return (
    <div>
      <div className="guidelines">
        <p>{s.writeCommentHelpText}</p>
        <h2>{s.helpWriteListIntro}</h2>
        <ul>
          <li>{s.helpWriteListStandalone}</li>
          <li>{s.helpWriteListRaisNew}</li>
          <li>{s.helpWriteListShort}</li>
        </ul>
        <p>{s.tipCommentsRandom}</p>
      </div>
      <form className="submit-form" onSubmit={handleSubmit}>
        <textarea
          placeholder={s.writePrompt}
          onChange={(e) => setText(e.target.value)}
          disabled={isSubmitting}
          maxLength="140"
        />
        <button type="submit" className="submit-button" disabled={isSubmitting || !text.trim()}>
          {isSubmitting ? ('Submitting...') : (s.submit)}
        </button>
      </form>
    </div>
  );
}
