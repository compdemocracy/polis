import { act, fireEvent, render, screen } from '@testing-library/react'
import SurveyForm from '../SurveyForm'
import { submitComment } from '../../api/comments'
import { getConversationToken } from '../../lib/auth'
import s from '../../strings/en_us'

jest.mock('../../api/comments', () => ({ submitComment: jest.fn() }))
jest.mock('../../lib/auth', () => ({ getConversationToken: jest.fn() }))
const submit = jest.mocked(submitComment)
const token = jest.mocked(getConversationToken)

/** The error lib/net.ts throws for a refused request: the response body is in responseText. */
function refused(status: number, error: string) {
  return Object.assign(
    new Error(`Polis API Error: POST /api/v3/comments failed with status ${status}`),
    {
      status,
      responseText: JSON.stringify({ error, message: error, status })
    }
  )
}

async function send(text: string) {
  render(<SurveyForm s={s} conversation_id="fixture-one" />)
  fireEvent.change(screen.getByPlaceholderText(s.writePrompt), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: s.submitComment }))
  })
}

beforeEach(() => {
  jest.resetAllMocks()
  token.mockReturnValue({ token: 'fixture', pid: 3 } as ReturnType<typeof getConversationToken>)
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

test('a statement the conversation already has shows the duplicate message and keeps the text', async () => {
  // The code the server sends for a duplicate (server/src/routes/comments.ts).
  submit.mockRejectedValueOnce(refused(409, 'polis_err_post_comment_duplicate'))
  await send('A statement already in the conversation')
  expect(screen.getByText(s.commentErrorDuplicate)).toBeVisible()
  expect(screen.queryByText(s.commentSendFailed)).not.toBeInTheDocument()
  expect(screen.getByPlaceholderText(s.writePrompt)).toHaveValue(
    'A statement already in the conversation'
  )
})

test('a server error is not shown as a duplicate', async () => {
  submit.mockRejectedValueOnce(refused(500, 'polis_err_post_comment'))
  await send('A statement the server failed to store')
  expect(screen.getByText(s.commentSendFailed)).toBeVisible()
  expect(screen.queryByText(s.commentErrorDuplicate)).not.toBeInTheDocument()
  expect(screen.getByPlaceholderText(s.writePrompt)).toHaveValue(
    'A statement the server failed to store'
  )
})

test('a closed conversation shows the closed message', async () => {
  submit.mockRejectedValueOnce(refused(403, 'polis_err_conversation_is_closed'))
  await send('A statement for a closed conversation')
  expect(screen.getByText(s.commentErrorConversationClosed)).toBeVisible()
})

test('a stored statement shows the sent message and clears the text', async () => {
  submit.mockResolvedValueOnce({ tid: 4, currentPid: 3 })
  await send('A new statement')
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      txt: 'A new statement',
      conversation_id: 'fixture-one',
      pid: 3,
      vote: 'agree'
    })
  )
  expect(screen.getByText(s.commentSent)).toBeVisible()
  expect(screen.getByPlaceholderText(s.writePrompt)).toHaveValue('')
})
