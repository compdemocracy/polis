import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, jest, test } from '@jest/globals'
import VisualizationContainer from '../VisualizationContainer'
import { fetchComments } from '../../api/comments'
import { fetchPCAData } from '../../api/pca'
import type { Comment, PCAData } from '../../api/types'
import type { Translations } from '../../strings/types'
import { REFRESH_DELAY_MS } from '../visualization/constants'

jest.mock('../../api/comments', () => ({ fetchComments: jest.fn() }))
jest.mock('../../api/pca', () => ({ fetchPCAData: jest.fn() }))
jest.mock('../visualization', () => ({
  PCAVisualization: ({ comments }: { comments: { txt: string }[] }) => (
    <div>{comments?.[0]?.txt}</div>
  )
}))

const CONVERSATION_ID = 'generated-conversation'
const UNCHANGED_MATH_TICK = 42
const BEFORE = 'before refresh'
const AFTER = 'after refresh'

test('an unchanged math_tick does not discard a refreshed comments response', async () => {
  const pca = fetchPCAData as jest.MockedFunction<typeof fetchPCAData>
  const comments = fetchComments as jest.MockedFunction<typeof fetchComments>
  pca.mockResolvedValue({ math_tick: UNCHANGED_MATH_TICK } as PCAData)
  comments
    .mockResolvedValueOnce([{ txt: BEFORE }] as Comment[])
    .mockResolvedValueOnce([{ txt: AFTER }] as Comment[])

  render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)
  await screen.findByText(BEFORE)

  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('polis-comment-submitted', { detail: { conversation_id: CONVERSATION_ID } })
    )
  })
  await waitFor(() => expect(comments).toHaveBeenCalledTimes(2), {
    timeout: REFRESH_DELAY_MS * 3
  })
  expect(await screen.findByText(AFTER)).not.toBeNull()
})
