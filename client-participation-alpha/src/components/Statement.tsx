import React, { useState } from 'react'
import { uiLanguage } from '../lib/lang'
import type { Translations } from '../strings/types'
import InfoIcon from './icons/InfoIcon'
import type { StatementData } from './types'

interface StatementProps {
  statement: StatementData
  onVote: (voteType: number, tid: number | string) => void
  isVoting: boolean
  s: Translations
  isStatementImportant: boolean
  setIsStatmentImportant: React.Dispatch<React.SetStateAction<boolean>>
  voteError: string | null
  importanceEnabled?: boolean
}

export function Statement({
  statement,
  onVote,
  isVoting,
  s,
  isStatementImportant,
  setIsStatmentImportant,
  voteError,
  importanceEnabled = false
}: StatementProps) {
  const [showImportanceDesc, setShowImportanceDesc] = useState<boolean>(false)
  const [translationsEnabled, setTranslationsEnabled] = useState<boolean>(false)

  // Get current user language
  const currentLang = uiLanguage()
  const statementLang = statement.lang
  const langMismatch = statementLang && currentLang && statementLang !== currentLang

  // Find matching translation if translations array exists
  const matchingTranslation = statement.translations?.find((t) => t.lang === currentLang)

  // Determine if we have an official translation (src > 0)
  const hasOfficialTranslation = langMismatch && matchingTranslation && matchingTranslation.src > 0

  // Determine if we have a non-official translation (src <= 0)
  const hasNonOfficialTranslation =
    langMismatch && matchingTranslation && matchingTranslation.src <= 0

  // Show translation button only if:
  // - Translations not enabled
  // - Language mismatch exists
  // - NOT official translation
  // - AND (no translation exists OR translation is non-official)
  const shouldShowTranslationButton =
    !translationsEnabled &&
    langMismatch &&
    !hasOfficialTranslation &&
    (!matchingTranslation || hasNonOfficialTranslation)

  // Show hide button only if:
  // - Translations enabled
  // - AND (we have a non-official translation OR no translations array)
  const shouldShowHideButton =
    translationsEnabled && (hasNonOfficialTranslation || !statement.translations)

  const handleVoteClick = (voteType: number) => {
    if (isVoting) return
    onVote(voteType, statement.tid)
  }

  const passUnsureText = s.pass

  const remaining = statement.remaining
  const remainingText =
    remaining != null && remaining > 0
      ? s.comments_remaining.replace(
          '{{num_comments}}',
          remaining >= 100 ? '100+' : String(remaining)
        )
      : null

  return (
    <div className="statement-card">
      <div className="statement-header">
        <div className="anonymous-user">
          {/* Use a relative URL so it works when app is mounted at /alpha/ behind nginx */}
          <img src="anonProfile.svg" alt="" className="avatar" />
          <span>
            {s.anonPerson} {s.x_wrote}
          </span>
        </div>
        {remainingText && (
          <span className="statement-remaining">
            {remainingText}
          </span>
        )}
      </div>

      {/* Show official translation (replaces original) or original text */}
      {hasOfficialTranslation ? (
        <p className="statement-text" dir="auto">
          <bdi>{matchingTranslation.txt}</bdi>
        </p>
      ) : (
        <p className="statement-text" dir="auto">
          <bdi>{statement.txt}</bdi>
        </p>
      )}

      {/* Show translation buttons only if not using official translation */}
      {!hasOfficialTranslation && shouldShowTranslationButton && (
        <button
          className="translation-button"
          onClick={() => {
            // No-op for now
            setTranslationsEnabled(true)
          }}
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-border, #ccc)',
            borderRadius: '4px',
            cursor: 'pointer',
            color: 'var(--color-text, #333)'
          }}
        >
          {s.showTranslationButton}
        </button>
      )}

      {!hasOfficialTranslation && shouldShowHideButton && (
        <button
          className="translation-button"
          onClick={() => {
            // No-op for now
            setTranslationsEnabled(false)
          }}
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-border, #ccc)',
            borderRadius: '4px',
            cursor: 'pointer',
            color: 'var(--color-text, #333)'
          }}
        >
          {s.hideTranslationButton}
        </button>
      )}

      {/* Show non-official translation below original text when enabled */}
      {hasNonOfficialTranslation && translationsEnabled && (
        <p
          className="statement-text"
          style={{
            marginTop: '0.5rem',
            fontStyle: 'italic',
            color: 'var(--color-text-secondary, #666)'
          }}
        >
          {matchingTranslation.txt}
        </p>
      )}

      {importanceEnabled ? (
        <>
          <div className="importance-container">
            <label htmlFor="important">{s.importantCheckbox}</label>
            <input
              id="important"
              type="checkbox"
              onChange={() => setIsStatmentImportant((prev) => !prev)}
              checked={isStatementImportant}
            />
            <InfoIcon
              size={17}
              className="info-icon"
              onClick={() => setShowImportanceDesc((prev) => !prev)}
              aria-label={s.infoIconAriaLabel}
            />
          </div>

          {showImportanceDesc && <p className="importance-desc">{s.importantCheckboxDesc}</p>}
        </>
      ) : null}

      <div className="vote-buttons">
        <button
          className="vote-button agree"
          onClick={() => handleVoteClick(-1)}
          disabled={isVoting}
          aria-label={s.agree}
          data-testid="vote-agree"
        >
          {isVoting ? '' : `✔ ${s.agree}`}
        </button>
        <button
          className="vote-button disagree"
          onClick={() => handleVoteClick(1)}
          disabled={isVoting}
          aria-label={s.disagree}
          data-testid="vote-disagree"
        >
          {isVoting ? '' : `✘ ${s.disagree}`}
        </button>
        <button
          className="vote-button pass"
          onClick={() => handleVoteClick(0)}
          disabled={isVoting}
          aria-label={passUnsureText}
          data-testid="vote-pass"
        >
          {isVoting ? '' : passUnsureText}
        </button>
      </div>
      {voteError && <p className="vote-error">{voteError}</p>}
    </div>
  )
}
