import React, { useEffect, useState } from 'react';
import PolisNet from '../lib/net';

const submitInviteCode = (inviteCode, s, setInviteCodeReceived, conversation_id) => {
  return async () => {
    try {
      const response = await PolisNet.polisPost('/inviteCode', { inviteCode });
      if (response.success) {
        window.localStorage.setItem(`invite-code-${conversation_id}`, inviteCode);
        // fire custom event
        dispatchEvent(new CustomEvent('invite-code-submitted', { bubbles: true }));
        setInviteCodeReceived(true);
      } else {
        alert(s.invite_code_invalid);
      }
    } catch (error) {
      alert(s.invite_code_invalid);
      // stub code, delete later
      window.localStorage.setItem(`invite-code-${conversation_id}`, inviteCode);
      dispatchEvent(new CustomEvent('invite-code-submitted', { bubbles: true }));
      setInviteCodeReceived(true);
    }
  };
};


export default function InviteCodeSubmissionForm({ s, setInviteCodeReceived, conversation_id }) {
  const [inviteCode, setInviteCode] = useState('');
  useEffect(() => {
    const storedInviteCode = window.localStorage.getItem(`invite-code-${conversation_id}`);
    console.log('Stored invite code:', storedInviteCode);
    if (storedInviteCode) {
      submitInviteCode(storedInviteCode, s, setInviteCodeReceived, conversation_id)();
    }
  }, []);

  return (
    <>
      <style>{invite_code_css}</style>
      <div className="invite-code-submission-form">
        <h2>{s.invite_code_required_short}</h2>
        <p>{s.invite_code_required_long}</p>
        <div className="invite-code-submission-form-container">
          <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={s.invite_code_prompt} />
          <button disabled={!inviteCode} onClick={submitInviteCode(inviteCode, s, setInviteCodeReceived, conversation_id)}>{s.submit_invite_code}</button>
        </div>
      </div>
    </>
  );
}

const invite_code_css = `
/* Main container for the invite code section */
.invite-code-submission-form {
  margin-top: 24px; /* Adds space above the form */
  padding-top: 24px; /* Adds space inside the top border */
  border-top: 1px solid #e0e0e0; /* A light separator line */
}

/* Styling for the main heading */
.invite-code-submission-form h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
}

/* Styling for the descriptive paragraph */
.invite-code-submission-form p {
  font-size: 0.9rem;
  color: #555;
  margin-bottom: 16px;
}

/* Flex container for the input and button */
.invite-code-submission-form-container {
  display: flex;
  align-items: center;
}

/* Styling for the text input field */
.invite-code-submission-form-container input[type="text"] {
  flex-grow: 1; /* Allows the input to take up available space */
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-right: none; /* Removes the border between the input and button */
  border-radius: 4px 0 0 4px; /* Rounds the left corners */
  font-size: 1rem;
  outline: none; /* Removes the default browser outline on focus */
}

/* Adds a blue glow on focus for better accessibility */
.invite-code-submission-form-container input[type="text"]:focus {
  border-color: #007bff;
  box-shadow: 0 0 0 1px #007bff;
}

/* Styling for the submit button */
.invite-code-submission-form-container button {
  padding: 8px 16px;
  border: 1px solid #666;
  border-radius: 0 4px 4px 0; /* Rounds the right corners */
  background-color: #777;
  color: white;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap; /* Prevents the button text from wrapping */
  transition: background-color 0.2s ease;
}

/* Hover state for the button */
.invite-code-submission-form-container button:hover {
  background-color: #555;
}

/* Disabled state for the button */
.invite-code-submission-form-container button:disabled {
  background-color: #ccc;
  border-color: #bbb;
  cursor: not-allowed;
}
`;
