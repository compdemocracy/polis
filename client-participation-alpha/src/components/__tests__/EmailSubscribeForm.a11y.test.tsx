import { render } from '@testing-library/react'
import { a11yStrings, expectNoA11yViolations } from '../../test-utils/a11y'
import EmailSubscribeForm from '../EmailSubscribeForm'

jest.mock('../../api/notifications', () => ({
  subscribeToNotifications: jest.fn()
}))

describe('EmailSubscribeForm a11y', () => {
  it('has no accessibility violations in default state', async () => {
    const { container } = render(
      <EmailSubscribeForm s={a11yStrings} conversation_id="test-conversation" />
    )

    await expectNoA11yViolations(container)
  })
})
