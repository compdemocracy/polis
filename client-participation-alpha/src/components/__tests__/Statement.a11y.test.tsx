import { render } from '@testing-library/react'
import { a11yStrings, expectNoA11yViolations } from '../../test-utils/a11y'
import { Statement } from '../Statement'
import type { StatementData } from '../types'

const statement: StatementData = {
  tid: 1,
  txt: 'This is a test statement for accessibility checks.',
  remaining: 5
}

describe('Statement a11y', () => {
  it('has no accessibility violations in default voting state', async () => {
    const { container } = render(
      <Statement
        statement={statement}
        onVote={jest.fn()}
        isVoting={false}
        s={a11yStrings}
        isStatementImportant={false}
        setIsStatmentImportant={jest.fn()}
        voteError={null}
      />
    )

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations with importance checkbox and vote error', async () => {
    const { container } = render(
      <Statement
        statement={statement}
        onVote={jest.fn()}
        isVoting={false}
        s={a11yStrings}
        isStatementImportant={false}
        setIsStatmentImportant={jest.fn()}
        voteError="Vote failed"
        importanceEnabled
      />
    )

    await expectNoA11yViolations(container)
  })
})
