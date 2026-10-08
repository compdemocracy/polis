import { act, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { StrictMode } from 'react'
import Survey from '../Survey'
import { fetchNextComment } from '../../api/comments'
import { submitVote } from '../../api/votes'
import { getConversationToken } from '../../lib/auth'
import s from '../../strings/en_us'

jest.mock('../../api/comments', () => ({ fetchNextComment: jest.fn() }))
jest.mock('../../api/votes', () => ({ submitVote: jest.fn() }))
jest.mock('../../lib/auth', () => ({ getConversationToken: jest.fn() }))
jest.mock('../EmailSubscribeForm', () => ({ __esModule: true, default: () => <p>Exhausted</p> }))
jest.mock('../InviteCodeSubmissionForm', () => ({
  __esModule: true,
  default: () => <p>Invite gate</p>
}))
const next = jest.mocked(fetchNextComment)
const vote = jest.mocked(submitVote)
const token = jest.mocked(getConversationToken)
const first = { tid: 0, txt: 'Blended SSR first', remaining: 3 }
const second = { tid: 2, txt: 'Blended next', remaining: 2 }
const props = { s, conversation_id: 'synthetic-one', initialStatement: first }
type Next = Awaited<ReturnType<typeof fetchNextComment>>
const eligible = { ...first, initialStatus: 'eligible' } as Next
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function auth() {
  act(() => {
    window.dispatchEvent(new Event('login-code-submitted'))
  })
}
async function ready() {
  next.mockResolvedValueOnce(eligible)
  render(<Survey {...props} />)
  await act(async () => {})
  expect(screen.getByTestId('vote-agree')).toBeEnabled()
}
beforeEach(() => {
  jest.resetAllMocks()
  token.mockReturnValue(null)
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())
test('SSR contains the SSR choice statement; hydration checks its exact tid including zero', async () => {
  expect(renderToString(<Survey {...props} />)).toContain(first.txt)
  await ready()
  expect(next).toHaveBeenCalledWith(props.conversation_id, undefined, 0)
  expect(screen.getByText(first.txt)).toBeVisible()
})
test('keeps SSR bytes when eligible even if the server edited text or translations', async () => {
  next.mockResolvedValueOnce({ ...eligible, txt: 'Edited after SSR' })
  render(<Survey {...props} />)
  await act(async () => {})
  expect(screen.getByText(first.txt)).toBeVisible()
  expect(screen.queryByText('Edited after SSR')).not.toBeInTheDocument()
})
test('no second selection draw after hydration or same-identity auth refresh', async () => {
  await ready()
  next.mockResolvedValueOnce({ ...second, initialStatus: 'voted' } as Next)
  auth()
  await act(async () => {})
  expect(next).toHaveBeenCalledTimes(1)
  expect(screen.getByText(first.txt)).toBeVisible()
})
test('first vote targets SSR tid and only then advances to the next blended choice', async () => {
  token.mockReturnValue({ token: 'synthetic', pid: 0 })
  await ready()
  vote.mockResolvedValueOnce({ nextComment: second })
  fireEvent.click(screen.getByTestId('vote-agree'))
  await screen.findByText(second.txt)
  expect(vote).toHaveBeenCalledWith(expect.objectContaining({ pid: 0, tid: 0, vote: 'agree' }))
})
test('returning participant with existing vote gets their unvoted statement', async () => {
  token.mockReturnValue({ token: 'synthetic', pid: 0 })
  next.mockResolvedValueOnce({ ...second, initialStatus: 'voted' } as Next)
  render(<Survey {...props} />)
  expect(screen.getByTestId('vote-agree')).toBeDisabled()
  await screen.findByText(second.txt)
  expect(screen.queryByText(first.txt)).not.toBeInTheDocument()
  expect(screen.getByTestId('vote-agree')).toBeEnabled()
})
test('returning participant without a vote keeps the SSR choice', async () => {
  token.mockReturnValue({ token: 'synthetic', pid: 9 })
  await ready()
  expect(screen.getByText(first.txt)).toBeVisible()
})
test('returning all-voted participant sees exhaustion', async () => {
  next.mockResolvedValueOnce({ initialStatus: 'voted' } as Next)
  render(<Survey {...props} />)
  await screen.findByText('Exhausted')
})
for (const response of [{ initialStatus: 'unavailable' }, second, {}]) {
  test(`unverified or unavailable SSR selection never silently swaps: ${JSON.stringify(response)}`, async () => {
    next.mockResolvedValueOnce(response as Next)
    render(<Survey {...props} />)
    await screen.findByRole('alert')
    expect(screen.queryByText(second.txt)).not.toBeInTheDocument()
    expect(screen.queryByText('Exhausted')).not.toBeInTheDocument()
    expect(vote).not.toHaveBeenCalled()
  })
}
for (const response of [{ ...second, initialStatus: 'voted' }, {}]) {
  test(`late check cannot overwrite accepted vote: ${JSON.stringify(response)}`, async () => {
    const pending = deferred<Next>()
    next.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(eligible)
    render(<Survey {...props} />)
    auth()
    await act(async () => {})
    vote.mockResolvedValueOnce({ nextComment: second })
    fireEvent.click(screen.getByTestId('vote-pass'))
    await screen.findByText(second.txt)
    await act(async () => pending.resolve(response as Next))
    expect(screen.getByText(second.txt)).toBeVisible()
    expect(screen.queryByText('Exhausted')).not.toBeInTheDocument()
  })
}
test('late rejected check cannot erase the successful current check', async () => {
  const pending = deferred<Next>()
  next.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(eligible)
  render(<Survey {...props} />)
  auth()
  await act(async () => {})
  await act(async () => pending.reject(new Error('late')))
  expect(screen.getByText(first.txt)).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
test('vote error preserves the statement and permits explicit retry', async () => {
  await ready()
  vote.mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(screen.getByTestId('vote-agree'))
  await screen.findByText(s.voteFailedGeneric)
  expect(screen.getByText(first.txt)).toBeVisible()
  vote.mockResolvedValueOnce({ nextComment: second })
  fireEvent.click(screen.getByTestId('vote-agree'))
  await screen.findByText(second.txt)
  expect(vote).toHaveBeenCalledTimes(2)
})
test('same-turn duplicate vote and auth refresh cannot steal vote ownership', async () => {
  await ready()
  const pending = deferred<Awaited<ReturnType<typeof submitVote>>>()
  vote.mockReturnValue(pending.promise)
  fireEvent.click(screen.getByTestId('vote-agree'))
  auth()
  fireEvent.click(screen.getByTestId('vote-agree'))
  expect(vote).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ nextComment: second }))
  expect(screen.getByText(second.txt)).toBeVisible()
  expect(next).toHaveBeenCalledTimes(1)
})
test('accepted last vote stays exhausted on later auth', async () => {
  await ready()
  vote.mockResolvedValueOnce({})
  fireEvent.click(screen.getByTestId('vote-pass'))
  await screen.findByText('Exhausted')
  auth()
  await act(async () => {})
  expect(next).toHaveBeenCalledTimes(1)
})
test('initial failure is an error, never false exhaustion or an enabled stale vote', async () => {
  next.mockRejectedValueOnce(new Error('offline'))
  render(<Survey {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByText('Exhausted')).not.toBeInTheDocument()
  expect(screen.queryByTestId('vote-agree')).not.toBeInTheDocument()
})
test('no SSR statement uses the ordinary participant draw', async () => {
  next.mockResolvedValueOnce(second as Next)
  render(<Survey {...props} initialStatement={undefined} />)
  await screen.findByText(second.txt)
  expect(next).toHaveBeenCalledWith(props.conversation_id, undefined, undefined)
})
for (const phase of ['check', 'vote']) {
  test(`navigation fences previous conversation ${phase}`, async () => {
    const pending = deferred<Next & Awaited<ReturnType<typeof submitVote>>>()
    next.mockReturnValueOnce(phase === 'check' ? pending.promise : Promise.resolve(eligible))
    const view = render(<Survey {...props} />)
    if (phase === 'vote') {
      await act(async () => {})
      vote.mockReturnValueOnce(pending.promise)
      fireEvent.click(screen.getByTestId('vote-agree'))
    }
    next.mockResolvedValueOnce({ ...second, initialStatus: 'eligible' } as Next)
    view.rerender(<Survey {...props} conversation_id="synthetic-two" initialStatement={second} />)
    await act(async () => {})
    await act(async () => pending.resolve({ ...eligible, nextComment: first }))
    expect(screen.getByText(second.txt)).toBeVisible()
    expect(screen.queryByText(first.txt)).not.toBeInTheDocument()
  })
}
test('invite gate waits for authentication before checking and revealing a statement', async () => {
  render(<Survey {...props} requiresInviteCode />)
  expect(screen.getByText('Invite gate')).toBeVisible()
  expect(next).not.toHaveBeenCalled()
  token.mockReturnValue({ token: 'synthetic', pid: 0 })
  next.mockResolvedValueOnce({ ...second, initialStatus: 'voted' } as Next)
  auth()
  await screen.findByText(second.txt)
})
test('StrictMode discards the first effect response', async () => {
  const pending = deferred<Next>()
  next.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(eligible)
  render(
    <StrictMode>
      <Survey {...props} />
    </StrictMode>
  )
  await act(async () => {})
  await act(async () => pending.resolve({ ...second, initialStatus: 'voted' } as Next))
  expect(screen.getByText(first.txt)).toBeVisible()
})
