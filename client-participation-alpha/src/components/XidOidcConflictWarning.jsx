import React, { useState, useEffect } from 'react';
import { getXidFromUrl, isOidcAuthenticated } from '../lib/auth';

export default function XidOidcConflictWarning({ s }) {
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    // Check if both XID and OIDC token are present
    const xid = getXidFromUrl();
    const hasOidcToken = isOidcAuthenticated();
    
    if (xid && hasOidcToken) {
      setShowWarning(true);
    }
  }, []);

  if (!showWarning) {
    return null;
  }

  return (
    <div style={{
      backgroundColor: '#fff3cd',
      border: '1px solid #ffc107',
      borderRadius: '4px',
      padding: '12px 16px',
      margin: '16px 0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        flex: 1
      }}>
        <span style={{
          fontSize: '20px',
          lineHeight: '1.5'
        }}>⚠️</span>
        <p style={{
          margin: 0,
          color: '#856404',
          fontSize: '14px',
          lineHeight: '1.5'
        }}>
          {s.xidOidcConflictWarning || "Warning: You are currently signed-in to polis, but have opened a conversation with an XID token. To participate with an XID, please log out of your polis account."}
        </p>
      </div>
      <button
        onClick={() => setShowWarning(false)}
        style={{
          background: 'none',
          border: 'none',
          fontSize: '20px',
          cursor: 'pointer',
          padding: '0 4px',
          color: '#856404',
          lineHeight: '1'
        }}
        aria-label="Dismiss warning"
      >
        ×
      </button>
    </div>
  );
}

