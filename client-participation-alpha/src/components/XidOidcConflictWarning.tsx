import { useState } from 'react'
import { getXidFromUrl, isOidcAuthenticated } from '../lib/auth'
import type { Translations } from '../strings/types'

interface XidOidcConflictWarningProps {
  s: Translations
}

export default function XidOidcConflictWarning({ s }: XidOidcConflictWarningProps) {
  const [showWarning, setShowWarning] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const xid = getXidFromUrl()
    const hasOidcToken = isOidcAuthenticated()
    return !!(xid && hasOidcToken)
  })

  if (!showWarning) {
    return null
  }

  return (
    <div
      style={{
        backgroundColor: '#fff3cd',
        border: '1px solid #ffc107',
        borderRadius: '4px',
        padding: '12px 16px',
        margin: '16px 0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          flex: 1
        }}
      >
        <span
          style={{
            fontSize: '20px',
            lineHeight: '1.5'
          }}
        >
          ⚠️
        </span>
        <p
          style={{
            margin: 0,
            color: '#856404',
            fontSize: '14px',
            lineHeight: '1.5'
          }}
        >
          {s.xidOidcConflictWarning}
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
        aria-label={s.dismissWarning}
      >
        ×
      </button>
    </div>
  )
}
