import { render } from '@testing-library/react'
import { a11yStrings, expectNoA11yViolations } from '../../test-utils/a11y'
import SurveyForm from '../SurveyForm'

jest.mock('../../api/comments', () => ({
  submitComment: jest.fn()
}))

jest.mock('../../lib/auth', () => ({
  getConversationToken: () => ({ token: 'test-token', pid: 1 })
}))

describe('SurveyForm a11y', () => {
  it('has no accessibility violations in default state', async () => {
    const { container } = render(<SurveyForm s={a11yStrings} conversation_id="test-conversation" />)

    await expectNoA11yViolations(container)
  })
})
