import type { Comment } from '../../api/types'
import type { Translations } from '../../strings/types'
import BanIcon from '../icons/BanIcon'
import CheckCircleIcon from '../icons/CheckCircleIcon'
import { groupLetters } from './constants'
import type { SelectedStatement } from './types'

interface StatementInfoProps {
  selectedStatement: SelectedStatement
  selectedComment: Comment | null
  s: Translations
}

export function StatementInfo({ selectedStatement, selectedComment, s }: StatementInfoProps) {
  return (
    <>
      {/* Comment text display */}
      {selectedComment && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            backgroundColor: 'var(--color-surface-alt)',
            borderRadius: '8px',
            border: '1px solid var(--color-border)'
          }}
        >
          <p style={{ color: 'var(--color-text)', fontSize: '0.95rem', margin: 0 }}>
            <strong>#{selectedComment.tid}</strong> {selectedComment.txt}
          </p>
        </div>
      )}

      {/* Statement details */}
      <div
        style={{
          marginTop: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '1rem',
          backgroundColor: 'var(--color-surface-alt)',
          borderRadius: '8px',
          border: '1px solid var(--color-border)'
        }}
      >
        {selectedStatement.type === 'agree' ? (
          <CheckCircleIcon fill="#10b981" />
        ) : (
          <BanIcon fill="#ef4444" />
        )}
        <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>
          {(() => {
            const pct = Math.floor(selectedStatement.pSuccess * 100)
            const commentId = String(selectedStatement.tid)

            if (selectedStatement.context === 'consensus') {
              const template =
                selectedStatement.type === 'agree' ? s.pctAgreedLong : s.pctDisagreedLong
              return template.replace('{{pct}}', String(pct)).replace('{{comment_id}}', commentId)
            } else {
              const groupLetter =
                groupLetters[selectedStatement.context.groupId] ??
                String(selectedStatement.context.groupId)
              const template =
                selectedStatement.type === 'agree'
                  ? s.pctAgreedOfGroupLong
                  : s.pctDisagreedOfGroupLong
              return template
                .replace('{{pct}}', String(pct))
                .replace('{{group}}', groupLetter)
                .replace('{{comment_id}}', commentId)
            }
          })()}
        </span>
      </div>
    </>
  )
}
