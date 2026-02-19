import { useEffect, useRef, useState } from 'react'
import { fetchTreeviteMe } from '../api/treevite'
import type { MeData } from '../api/types'
import { getConversationToken } from '../lib/auth'
import PolisNet from '../lib/net'
import type { Translations } from '../strings/types'

interface TreeviteInvitesProps {
  conversation_id: string
  s: Translations
}

export default function TreeviteInvites({ conversation_id, s }: TreeviteInvitesProps) {
  const [visible, setVisible] = useState<boolean>(false)
  const [expanded, setExpanded] = useState<boolean>(false)
  const [me, setMe] = useState<MeData | null>(null)
  const [copiedId, setCopiedId] = useState<number | string | null>(null)
  const fetchedRef = useRef<boolean>(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [panelMax, setPanelMax] = useState<number>(0)

  const statusToText = (status: number) => {
    switch (status) {
      case 0:
        return s.invite_status_unused
      case 1:
        return s.invite_status_used
      case 2:
        return s.invite_status_revoked
      case 3:
        return s.invite_status_expired
      default:
        return String(status)
    }
  }

  const formatDate = (iso: string) => {
    try {
      const date = new Date(iso)
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    } catch {
      return iso
    }
  }

  useEffect(() => {
    const tryFetchMe = async () => {
      if (fetchedRef.current) return
      fetchedRef.current = true
      try {
        const res = await fetchTreeviteMe(conversation_id)
        if (res) {
          setMe(res)
          setVisible(true)
        }
      } catch {
        // Silently ignore for now; placeholder component
      }
    }

    // If already authenticated on mount, fetch once
    const token = getConversationToken(conversation_id)
    if (token && token.token) {
      tryFetchMe()
    }

    const onInviteAccepted = () => tryFetchMe()
    const onLoginSuccess = () => tryFetchMe()
    window.addEventListener('invite-code-submitted', onInviteAccepted)
    window.addEventListener('login-code-submitted', onLoginSuccess)
    return () => {
      window.removeEventListener('invite-code-submitted', onInviteAccepted)
      window.removeEventListener('login-code-submitted', onLoginSuccess)
    }
  }, [conversation_id])

  // Measure inner content height for smooth drawer animation
  useEffect(() => {
    const measure = () => {
      if (innerRef.current) {
        setPanelMax(innerRef.current.scrollHeight)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [me, expanded])

  if (!visible || !me) return null

  const waveText =
    me?.wave && typeof me.wave.wave !== 'undefined'
      ? s.invites_wave_sentence
          .replace('{{wave}}', String(me.wave.wave))
          .replace('{{date}}', formatDate(me.wave.joined_at))
      : null

  const hasInvites = Array.isArray(me?.invites) && me.invites.length > 0

  const onCopy = async (code: string, id: number | string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      // ignore
    }
  }

  const onDownloadCsv = async () => {
    try {
      await PolisNet.downloadCsv('/treevite/myInvites/csv', { conversation_id })
    } catch {
      // noop: errors are surfaced via network logs; keep UI simple
    }
  }

  return (
    <div className="tv-invites" style={{ marginTop: '1rem' }}>
      <style>{styles}</style>
      <button
        type="button"
        className={`tv-invites-toggle${expanded ? ' open' : ''}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`tv-caret${expanded ? ' open' : ''}`}>▾</span>
        <span>{s.invites_link}</span>
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  marginBottom: '8px'
                }}
              >
                <p style={{ margin: 0 }}>{s.invites_instructions}</p>
                <button className="tv-download-btn" onClick={onDownloadCsv}>
                  {s.download_invites_csv}
                </button>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {me.invites!.map((inv) => (
                  <li
                    key={inv.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 0',
                      borderBottom: '1px solid #f1f1f1'
                    }}
                  >
                    <div>
                      <code>{inv.invite_code}</code>
                      <span style={{ marginLeft: '8px', color: '#666' }}>
                        ({statusToText(inv.status)})
                      </span>
                    </div>
                    {inv.status === 0 ? (
                      <button
                        onClick={() => onCopy(inv.invite_code, inv.id)}
                        className={`tv-copy-btn${copiedId === inv.id ? ' copied' : ''}`}
                      >
                        {copiedId === inv.id ? s.copied : s.copy}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p style={{ marginBottom: 0 }}>{s.invites_none}</p>
          )}
        </div>
      </div>
    </div>
  )
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
`
