import React, { useEffect, useRef, useState } from 'react';
import PolisNet from '../lib/net';
import { getConversationToken } from '../lib/auth';

export default function TreeviteInvites({ conversation_id, s }) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [me, setMe] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const fetchedRef = useRef(false);
  const panelRef = useRef(null);
  const innerRef = useRef(null);
  const [panelMax, setPanelMax] = useState(0);

  const statusToText = (status) => {
    switch (status) {
      case 0: return s.invite_status_unused || 'unused';
      case 1: return s.invite_status_used || 'used';
      case 2: return s.invite_status_revoked || 'revoked';
      case 3: return s.invite_status_expired || 'expired';
      default: return String(status);
    }
  };

  const formatDate = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
      return iso;
    }
  };

  const tryFetchMe = async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const res = await PolisNet.polisGet('/treevite/me', { conversation_id });
      if (res) {
        setMe(res);
        setVisible(true);
      }
    } catch (e) {
      // Silently ignore for now; placeholder component
    }
  };

  useEffect(() => {
    // If already authenticated on mount, fetch once
    const token = getConversationToken(conversation_id);
    if (token && token.token) {
      tryFetchMe();
    }

    const onInviteAccepted = () => tryFetchMe();
    const onLoginSuccess = () => tryFetchMe();
    window.addEventListener('invite-code-submitted', onInviteAccepted);
    window.addEventListener('login-code-submitted', onLoginSuccess);
    return () => {
      window.removeEventListener('invite-code-submitted', onInviteAccepted);
      window.removeEventListener('login-code-submitted', onLoginSuccess);
    };
  }, [conversation_id]);

  // Measure inner content height for smooth drawer animation
  useEffect(() => {
    const measure = () => {
      if (innerRef.current) {
        setPanelMax(innerRef.current.scrollHeight);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [me, expanded]);

  if (!visible) return null;

  const waveText = me?.wave && typeof me.wave.wave !== 'undefined'
    ? (s.invites_wave_sentence || 'You are in wave {{wave}}. Joined {{date}}')
        .replace('{{wave}}', String(me.wave.wave))
        .replace('{{date}}', formatDate(me.wave.joined_at))
    : null;

  const hasInvites = Array.isArray(me?.invites) && me.invites.length > 0;

  const onCopy = async (code, id) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (_) {}
  };

  const onDownloadCsv = async () => {
    try {
      await PolisNet.downloadCsv('/treevite/myInvites/csv', { conversation_id });
    } catch (e) {
      // noop: errors are surfaced via network logs; keep UI simple
    }
  };

  return (
    <div className="tv-invites" style={{ marginTop: '1rem' }}>
      <style>{styles}</style>
      <button
        type="button"
        className={`tv-invites-toggle${expanded ? ' open' : ''}`}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <span className={`tv-caret${expanded ? ' open' : ''}`}>▾</span>
        <span>{s.invites_link || 'Invites'}</span>
      </button>

      <div
        ref={panelRef}
        className="tv-invites-panel"
        style={{ maxHeight: expanded ? panelMax : 0, opacity: expanded ? 1 : 0 }}
        aria-hidden={!expanded}
      >
        <div ref={innerRef} className="tv-invites-inner">
          {waveText && <p style={{ marginTop: 0 }}>{waveText}</p>}
          {hasInvites ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                <p style={{ margin: 0 }}>{s.invites_instructions || 'Copy and share these invite codes to invite new participants:'}</p>
                <button className="tv-download-btn" onClick={onDownloadCsv}>{s.download_invites_csv || 'Download CSV'}</button>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {me.invites.map((inv) => (
                  <li key={inv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f1f1f1' }}>
                    <div>
                      <code>{inv.invite_code}</code>
                      <span style={{ marginLeft: '8px', color: '#666' }}>({statusToText(inv.status)})</span>
                    </div>
                    {inv.status === 0 ? (
                      <button onClick={() => onCopy(inv.invite_code, inv.id)} className={`tv-copy-btn${copiedId === inv.id ? ' copied' : ''}`}>
                        {copiedId === inv.id ? (s.copied || 'Copied') : (s.copy || 'Copy')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p style={{ marginBottom: 0 }}>{s.invites_none || "You don't have any invites yet."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = `
.tv-invites-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #d0d0d0;
  background: #fafafa;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.tv-caret { transition: transform 160ms ease; display: inline-block; }
.tv-caret.open { transform: rotate(180deg); }
.tv-invites-panel {
  overflow: hidden;
  transition: max-height 220ms ease, opacity 180ms ease;
}
.tv-invites-inner {
  margin-top: 8px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}
.tv-copy-btn {
  border: 1px solid #ccc;
  background: #fafafa;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.tv-copy-btn.copied { background: #d1e7dd; border-color: #a3cfbb; color: #0f5132; }
.tv-download-btn {
  border: 1px solid #ccc;
  background: #fafafa;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
`;


