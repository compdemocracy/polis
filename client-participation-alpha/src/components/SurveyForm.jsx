import React, { useEffect, useState } from 'react';
import { getConversationToken } from '../lib/auth';
import PolisNet from '../lib/net';

const submitPerspectiveAPI = async (text, conversation_id) => {
  const decodedToken = getConversationToken(conversation_id);
  const pid = decodedToken?.pid;

  try {
    const resp = await PolisNet.polisPost('/comments', {
      txt: text.replace(/\n/g, " "),
      conversation_id,
      pid,
      vote: -1,
    });
    
    // The net module automatically handles JWT extraction and storage
    return resp;
  } catch (error) {
    console.error("Comment submission failed:", error);
    // Re-throw for caller to handle if needed
    throw error;
  }
};


export default function SurveyForm({ s, conversation_id, requiresInviteCode = false }) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [isAuthed, setIsAuthed] = useState(!!getConversationToken(conversation_id)?.token);
  const maxLength = 400;

  useEffect(() => {
    const onInviteOrLogin = () => setIsAuthed(!!getConversationToken(conversation_id)?.token);
    window.addEventListener('invite-code-submitted', onInviteOrLogin);
    window.addEventListener('login-code-submitted', onInviteOrLogin);
    return () => {
      window.removeEventListener('invite-code-submitted', onInviteOrLogin);
      window.removeEventListener('login-code-submitted', onInviteOrLogin);
    };
  }, [conversation_id]);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setFeedback(s.commentSent);
    const submittedText = text;
    setText('');
    submitPerspectiveAPI(submittedText, conversation_id);
  };

  if ((requiresInviteCode && !isAuthed)) {
    return null;
  }

  if (feedback) {
    return <p style={{ textAlign: 'center', color: '#28a745', fontWeight: 'bold' }}>{feedback}</p>;
  }

  return (
    <div>
      <div className="guidelines">
        <p dangerouslySetInnerHTML={{ __html: s.writeCommentHelpText }}/>
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
  );
}
