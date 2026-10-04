import { render } from '@testing-library/react'
import { a11yStrings, expectNoA11yViolations } from '../../test-utils/a11y'
import InviteCodeSubmissionForm from '../InviteCodeSubmissionForm'

jest.mock('../../api/treevite', () => ({
  acceptInvite: jest.fn(),
  treeviteLogin: jest.fn()
}))

describe('InviteCodeSubmissionForm a11y', () => {
  it('has no accessibility violations in default state', async () => {
    const { container } = render(
      <InviteCodeSubmissionForm s={a11yStrings} conversation_id="test-conversation" />
    )

    await expectNoA11yViolations(container)
  })
})
