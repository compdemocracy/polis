import React, { useEffect, useState } from 'react';

export default function TreeviteLoginCodeModal({ s }) {
  const [visible, setVisible] = useState(false);
  const [loginCode, setLoginCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onIssued = (e) => {
      const code = e?.detail?.login_code;
      if (code) {
        setLoginCode(code);
        setVisible(true);
      }
    };
    window.addEventListener('treevite-login-code-issued', onIssued);
    return () => window.removeEventListener('treevite-login-code-issued', onIssued);
  }, []);

  const close = () => setVisible(false);

  if (!visible) return null;

  const message = (s.invite_code_accepted_message || '').replace('{{login_code}}', loginCode);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(loginCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  };

  return (
    <div className="tv-modal-overlay" role="dialog" aria-modal="true">
      <style>{styles}</style>
      <div className="tv-modal">
        <h3>{s.invite_code_required_short}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
        <div className="tv-code-box">
          <code>{loginCode}</code>
          <button className={`tv-copy${copied ? ' copied' : ''}`} onClick={copyToClipboard} disabled={copied}>
            {copied ? (s.copied || 'Copied') : (s.copy || 'Copy')}
          </button>
        </div>
        <div className="tv-actions">
          <button className="tv-primary" onClick={close}>{s.ok_got_it || 'OK, got it'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = `
.tv-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.tv-modal {
  background: #fff;
  border-radius: 8px;
  max-width: 560px;
  width: calc(100% - 32px);
  padding: 20px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.2);
}
.tv-code-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f7f7f7;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 8px;
}
.tv-code-box code { font-size: 1.1rem; }
.tv-copy {
  margin-left: 12px;
  border: 1px solid #ccc;
  background: #fafafa;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.tv-copy.copied {
  background: #d1e7dd;
  border-color: #a3cfbb;
  color: #0f5132;
}
.tv-actions { margin-top: 16px; text-align: right; }
.tv-primary {
  background: #0d6efd;
  color: #fff;
  border: 1px solid #0b5ed7;
  border-radius: 4px;
  padding: 8px 14px;
  cursor: pointer;
}
`;


