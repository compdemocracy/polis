import React, { useEffect, useState } from 'react';
import PolisNet from '../lib/net';

export default function InviteCodeSubmissionForm({ s, conversation_id }) {
  const [inviteCode, setInviteCode] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submittingInvite, setSubmittingInvite] = useState(false);
  const [submittingLogin, setSubmittingLogin] = useState(false);

  const handleAcceptInvite = async () => {
    if (!inviteCode) return;
    setSubmittingInvite(true);
    setError('');
    try {
      const response = await PolisNet.polisPost('/treevite/acceptInvite', {
        conversation_id,
        invite_code: inviteCode.trim(),
      });

      // Store JWT handled centrally in net.ts via handleJwtFromResponse
      // Notify listeners that auth state changed
      dispatchEvent(new CustomEvent('invite-code-submitted', { bubbles: true }));

      if (response && response.login_code) {
        setMessage((s.invite_code_accepted_message || 'Invite accepted. Your login code is: {{login_code}}').replace('{{login_code}}', response.login_code));
        // Emit a global event so a modal can display the code and block until dismissed
        dispatchEvent(new CustomEvent('treevite-login-code-issued', { detail: { login_code: response.login_code }, bubbles: true }));
      } else {
        setMessage(s.invite_code_accepted_message_no_code || 'Invite accepted.');
      }
      setInviteCode('');
    } catch (e) {
      setError(s.invite_code_invalid || 'Invalid invite code.');
    } finally {
      setSubmittingInvite(false);
    }
  };

  const handleLoginWithCode = async () => {
    if (!loginCode) return;
    setSubmittingLogin(true);
    setError('');
    try {
      const response = await PolisNet.polisPost('/treevite/login', {
        conversation_id,
        login_code: loginCode.trim(),
      });
      // JWT handled in net.ts
      dispatchEvent(new CustomEvent('login-code-submitted', { bubbles: true }));
      setMessage(s.login_success || 'Success! You are now logged in.');
      setLoginCode('');
    } catch (e) {
      setError(s.login_code_invalid || 'Invalid login code.');
    } finally {
      setSubmittingLogin(false);
    }
  };

  return (
    <>
      <style>{invite_code_css}</style>
      <div className="invite-code-submission-form">
        <h2>{s.invite_code_required_short}</h2>
        <p>{s.invite_code_required_long}</p>

        {message ? (
          <div className="notice success" role="status">{message}</div>
        ) : null}
        {error ? (
          <div className="notice error" role="alert">{error}</div>
        ) : null}

        <div className="invite-code-submission-form-container">
          <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={s.invite_code_prompt} />
          <button disabled={!inviteCode || submittingInvite} onClick={handleAcceptInvite}>{submittingInvite ? (s.submitting || 'Submitting...') : s.submit_invite_code}</button>
        </div>

        <div className="or-separator">{s.or_text || 'or'}</div>

        <div className="invite-code-submission-form-container">
          <input type="text" value={loginCode} onChange={(e) => setLoginCode(e.target.value)} placeholder={s.login_code_prompt || 'Enter Login Code'} />
          <button disabled={!loginCode || submittingLogin} onClick={handleLoginWithCode}>{submittingLogin ? (s.submitting || 'Submitting...') : (s.submit_login_code || 'Submit Login Code')}</button>
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
  width: 100%;
  max-width: 100%;
}

/* Styling for the text input field */
.invite-code-submission-form-container input[type="text"] {
  flex-grow: 1; /* Allows the input to take up available space */
  min-width: 0; /* Critical for flex children to avoid overflow on small screens */
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
  white-space: nowrap; /* Prevents the button text from wrapping; overridden on small screens */
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

/* On narrow screens, stack input and button to prevent horizontal overflow */
@media (max-width: 480px) {
  .invite-code-submission-form-container {
    flex-direction: column;
    align-items: stretch;
  }
  .invite-code-submission-form-container input[type="text"] {
    border-right: 1px solid #ccc;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .invite-code-submission-form-container button {
    border-radius: 4px;
    white-space: normal; /* allow wrap if needed */
    width: 100%;
  }
}

.or-separator {
  text-align: center;
  color: #777;
  margin: 12px 0;
}

.notice {
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
}
.notice.success {
  background-color: #e6f4ea;
  border: 1px solid #b7e1c1;
  color: #1e6c34;
}
.notice.error {
  background-color: #fdecea;
  border: 1px solid #f5c2c7;
  color: #842029;
}
`;
