import React, { useState } from 'react';
import { getJwtPayload } from '../lib/auth';

const submitPerspectiveAPI = async (text, conversation_id) => {
  const tokenKey = `participant_token_${conversation_id}`;
  const decodedToken = getJwtPayload(tokenKey);
  const pid = decodedToken?.pid;

  if (!pid) {
    console.error("Comment submission failed: Auth token not found.");
    return;
  }

  try {
    const response = await fetch(`${import.meta.env.PUBLIC_SERVICE_URL}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        txt: text.replace(/\n/g, " "),
        conversation_id,
        pid,
        vote: -1,
      }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Comment submission failed with status ${response.status}:`, errorText);
    }
  } catch (error) {
    console.error("Network error during comment submission:", error);
  }
};


export default function SurveyForm({ s, conversation_id }) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const maxLength = 400;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setFeedback(s.commentSent);
    const submittedText = text;
    setText('');
    submitPerspectiveAPI(submittedText, conversation_id);
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
          <li>{s.helpWriteListRaiseNew}</li>
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
  );
}
