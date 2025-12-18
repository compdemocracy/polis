import type { Translations } from '../../strings/types'
import { groupColors, groupLetters } from './constants'
import type { Hull, SelectedStatement, StatementContext, StatementWithType } from './types'

interface VisualizationControlsProps {
  isConsensusSelected: boolean
  selectedGroup: number | null
  hulls: Hull[]
  statements: StatementWithType[]
  selectedStatement: SelectedStatement | null
  onConsensusToggle: () => void
  onGroupSelect: (groupId: number | null) => void
  onStatementSelect: (statement: StatementWithType | null, context: StatementContext) => void
  s: Translations
}

export function VisualizationControls({
  isConsensusSelected,
  selectedGroup,
  hulls,
  statements,
  selectedStatement,
  onConsensusToggle,
  onGroupSelect,
  onStatementSelect,
  s
}: VisualizationControlsProps) {
  return (
    <div
      style={{
        marginTop: '1.8rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        flexWrap: 'wrap'
      }}
    >
      {/* Consensus button */}
      <button
        className="vis-control-btn"
        onClick={onConsensusToggle}
        style={{
          padding: '0.5rem 1rem',
          borderRadius: '8px',
          border: '1px solid var(--color-border)',
          backgroundColor: isConsensusSelected ? 'var(--color-button-bg)' : 'var(--color-surface)',
          color: isConsensusSelected ? 'var(--color-button-text)' : 'var(--color-text)',
          cursor: 'pointer',
          fontSize: '0.95rem',
          fontWeight: 500,
          transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease'
        }}
        onMouseEnter={(e) => {
          if (!isConsensusSelected) {
            e.currentTarget.style.backgroundColor = 'var(--color-surface-alt)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isConsensusSelected) {
            e.currentTarget.style.backgroundColor = 'var(--color-surface)'
          }
        }}
      >
        {s.consensus}
      </button>

      {/* Group selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>{s.group_123}</span>
        {hulls.map(({ groupId }) => {
          const color = groupColors[groupId] ?? '#999'
          const letter = groupLetters[groupId] ?? ''
          return (
            <button
              key={`group-selector-${groupId}`}
              className="vis-control-btn"
              onClick={() => {
                // Toggle group selection
                onGroupSelect(selectedGroup === groupId ? null : groupId)
              }}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '8px',
                border: selectedGroup === groupId ? '3px solid #000000' : '2px solid transparent',
                backgroundColor: selectedGroup === groupId ? 'var(--color-button-bg)' : color,
                color: selectedGroup === groupId ? 'var(--color-button-text)' : '#333333',
                cursor: 'pointer',
                fontSize: '0.95rem',
                fontWeight: selectedGroup === groupId ? 700 : 600,
                transition:
                  'opacity 0.2s ease, transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease',
                boxShadow:
                  selectedGroup === groupId
                    ? '0 0 0 3px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(0, 0, 0, 0.3)'
                    : 'none',
                transform: selectedGroup === groupId ? 'scale(1.05)' : 'scale(1)'
              }}
              onMouseEnter={(e) => {
                if (selectedGroup !== groupId) {
                  e.currentTarget.style.opacity = '0.85'
                  e.currentTarget.style.transform = 'scale(1.05)'
                }
              }}
              onMouseLeave={(e) => {
                if (selectedGroup !== groupId) {
                  e.currentTarget.style.opacity = '1'
                  e.currentTarget.style.transform = 'scale(1)'
                } else {
                  e.currentTarget.style.transform = 'scale(1.05)'
                }
              }}
            >
              {letter}
            </button>
          )
        })}
      </div>

      {/* Statement selector */}
      {(isConsensusSelected || selectedGroup !== null) && statements.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginLeft: '0.5rem',
            flexWrap: 'wrap',
            maxWidth: '100%'
          }}
        >
          <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>{s.comment_123}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {statements.map((statement) => {
              const context: StatementContext = isConsensusSelected
                ? 'consensus'
                : { groupId: selectedGroup! }

              const isSelected =
                selectedStatement?.tid === statement.tid &&
                ((context === 'consensus' && selectedStatement.context === 'consensus') ||
                  (typeof context === 'object' &&
                    typeof selectedStatement.context === 'object' &&
                    selectedStatement.context.groupId === context.groupId))

              return (
                <button
                  key={`statement-${statement.tid}`}
                  className="vis-control-btn"
                  onClick={() => {
                    // Toggle selection
                    if (isSelected) {
                      onStatementSelect(null, context)
                    } else {
                      onStatementSelect(statement, context)
                    }
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    border: `1px solid ${
                      isSelected ? 'var(--color-button-bg)' : 'var(--color-border)'
                    }`,
                    backgroundColor: isSelected
                      ? 'var(--color-surface-alt)'
                      : 'var(--color-surface)',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    transition: 'background-color 0.2s ease, border-color 0.2s ease',
                    whiteSpace: 'nowrap'
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--color-surface-alt)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--color-surface)'
                    }
                  }}
                >
                  {statement.tid}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
