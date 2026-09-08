import { act, render, waitFor } from '@testing-library/react'
import VisualizationContainer from '../VisualizationContainer'
import { fetchPCAData, PCA_VISUALIZATION_KEYS } from '../../api/pca'
import { fetchComments } from '../../api/comments'
import { REFRESH_DELAY_MS } from '../visualization/constants'
import type { Comment, PCAData } from '../../api/types'
import type { Translations } from '../../strings/types'

jest.mock('../../lib/net')
jest.mock('../../lib/lang')
jest.mock('../../api/pca', () => {
  const actual = jest.requireActual('../../api/pca')
  return { ...actual, fetchPCAData: jest.fn() }
})
jest.mock('../../api/comments')

// Record every (data, comments) pair the visualization is handed, so we can
// tell a short-circuited poll (no new object) from an applied one, and so the
// two states can be checked independently of each other.
const received: PCAData[] = []
const receivedComments: (Comment[] | null)[] = []
jest.mock('../visualization', () => ({
  PCAVisualization: (props: { data: PCAData; comments: Comment[] | null }) => {
    received.push(props.data)
    receivedComments.push(props.comments)
    return <div data-testid="viz">tick:{String(props.data.math_tick)}</div>
  }
}))

const mockedFetchPCAData = fetchPCAData as jest.MockedFunction<typeof fetchPCAData>
const mockedFetchComments = fetchComments as jest.MockedFunction<typeof fetchComments>

const CONVERSATION_ID = 'conv123'

function pcaBody(math_tick: number): PCAData {
  return {
    'base-clusters': { x: [], y: [], id: [], count: [], members: [] },
    'group-clusters': [],
    math_tick
  } as PCAData
}

function comment(tid: number): Comment {
  return {
    txt: `statement ${tid}`,
    tid,
    created: 0,
    quote_src_url: null,
    is_seed: false,
    is_meta: false,
    lang: 'en',
    pid: 0
  }
}

async function triggerPoll(conversationId = CONVERSATION_ID) {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('polis-vote-submitted', {
        detail: { conversation_id: conversationId }
      })
    )
    jest.advanceTimersByTime(REFRESH_DELAY_MS)
  })
}

describe('VisualizationContainer math_tick guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    received.length = 0
    receivedComments.length = 0
    jest.useFakeTimers()
    mockedFetchComments.mockResolvedValue([])
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('requests math_tick under its wire name', async () => {
    mockedFetchPCAData.mockResolvedValue(pcaBody(7))

    render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)

    await waitFor(() => expect(mockedFetchPCAData).toHaveBeenCalled())
    expect(mockedFetchPCAData).toHaveBeenCalledWith(CONVERSATION_ID, PCA_VISUALIZATION_KEYS)
    expect(PCA_VISUALIZATION_KEYS).toContain('math_tick')
  })

  it('short-circuits when the tick is unchanged', async () => {
    const first = pcaBody(7)
    const unchanged = pcaBody(7)
    mockedFetchPCAData.mockResolvedValueOnce(first).mockResolvedValueOnce(unchanged)

    render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)

    await waitFor(() => expect(received.length).toBeGreaterThan(0))
    expect(received[received.length - 1]).toBe(first)

    await triggerPoll()

    expect(mockedFetchPCAData).toHaveBeenCalledTimes(2)
    // The second body never reached the visualization: state was not replaced.
    expect(received).not.toContain(unchanged)
    expect(new Set(received).size).toBe(1)
  })

  it('updates when the tick advances', async () => {
    const first = pcaBody(7)
    const advanced = pcaBody(8)
    mockedFetchPCAData.mockResolvedValueOnce(first).mockResolvedValueOnce(advanced)

    render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)

    await waitFor(() => expect(received.length).toBeGreaterThan(0))

    await triggerPoll()

    expect(mockedFetchPCAData).toHaveBeenCalledTimes(2)
    expect(received).toContain(advanced)
    expect(received[received.length - 1]).toBe(advanced)
  })

  it('always updates when the server omits the tick', async () => {
    // Subset mode may legitimately omit a key; an absent tick must not be
    // mistaken for an unchanged one.
    const first = pcaBody(7)
    const untracked = { 'base-clusters': first['base-clusters'], 'group-clusters': [] } as PCAData
    mockedFetchPCAData.mockResolvedValueOnce(first).mockResolvedValueOnce(untracked)

    render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)

    await waitFor(() => expect(received.length).toBeGreaterThan(0))

    await triggerPoll()

    expect(received).toContain(untracked)
  })

  it('applies changed comments even when the tick is unchanged', async () => {
    // A statement can be submitted or moderated between polls while the math
    // tick stands still. The short circuit must skip only the PCA state.
    const first = pcaBody(7)
    const unchanged = pcaBody(7)
    const before = [comment(1)]
    const after = [comment(1), comment(2)]
    mockedFetchPCAData.mockResolvedValueOnce(first).mockResolvedValueOnce(unchanged)
    mockedFetchComments.mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    render(<VisualizationContainer conversation_id={CONVERSATION_ID} s={{} as Translations} />)

    await waitFor(() => expect(received.length).toBeGreaterThan(0))
    expect(receivedComments[receivedComments.length - 1]).toBe(before)

    await triggerPoll()

    // PCA state still short-circuited...
    expect(received).not.toContain(unchanged)
    expect(new Set(received).size).toBe(1)
    // ...but the newer comments were applied.
    expect(receivedComments).toContain(after)
    expect(receivedComments[receivedComments.length - 1]).toBe(after)
  })

  it('re-applies math when the conversation changes at an equal tick', async () => {
    // Ticks are per-conversation generations: conversation B's tick 7 is not
    // conversation A's tick 7, so a switch must not short-circuit and leave
    // A's math on screen under B's id.
    const conversationA = pcaBody(7)
    const conversationB = pcaBody(7)
    mockedFetchPCAData.mockResolvedValueOnce(conversationA).mockResolvedValueOnce(conversationB)

    const { rerender } = render(
      <VisualizationContainer conversation_id="convA" s={{} as Translations} />
    )

    await waitFor(() => expect(received.length).toBeGreaterThan(0))
    expect(received[received.length - 1]).toBe(conversationA)

    await act(async () => {
      rerender(<VisualizationContainer conversation_id="convB" s={{} as Translations} />)
    })

    await waitFor(() => expect(received[received.length - 1]).toBe(conversationB))
    expect(mockedFetchPCAData).toHaveBeenNthCalledWith(2, 'convB', PCA_VISUALIZATION_KEYS)
  })

  it('drops a response for a conversation that has already been left', async () => {
    // A slow response for conversation A must not land on conversation B.
    let resolveA: (value: PCAData) => void = () => {}
    const slowA = new Promise<PCAData>((resolve) => {
      resolveA = resolve
    })
    const staleA = pcaBody(3)
    const conversationB = pcaBody(4)
    mockedFetchPCAData.mockReturnValueOnce(slowA).mockResolvedValueOnce(conversationB)

    const { rerender } = render(
      <VisualizationContainer conversation_id="convA" s={{} as Translations} />
    )

    await act(async () => {
      rerender(<VisualizationContainer conversation_id="convB" s={{} as Translations} />)
    })
    await waitFor(() => expect(received[received.length - 1]).toBe(conversationB))

    await act(async () => {
      resolveA(staleA)
    })

    expect(received).not.toContain(staleA)
    expect(received[received.length - 1]).toBe(conversationB)
  })

  // A -> B -> A returns to the same conversation id, so an id-equality guard
  // lets the FIRST A's late response through. These three follow the schedules
  // in cost-reduction/scripts/p046-r2-astra-review.cjs.
  describe('A -> B -> A', () => {
    function deferred<T>() {
      let resolve: (value: T) => void = () => {}
      let reject: (reason: unknown) => void = () => {}
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      // Nothing awaits a rejection until the component does.
      promise.catch(() => {})
      return { promise, resolve, reject }
    }

    async function goAthenBthenA(slowA: Promise<PCAData>, secondA: PCAData | Promise<PCAData>) {
      const conversationB = pcaBody(7)
      mockedFetchPCAData
        .mockReturnValueOnce(slowA)
        .mockResolvedValueOnce(conversationB)
        .mockReturnValueOnce(
          secondA instanceof Promise ? secondA : (Promise.resolve(secondA) as Promise<PCAData>)
        )
      mockedFetchComments
        .mockResolvedValueOnce([comment(1)])
        .mockResolvedValueOnce([comment(2)])
        .mockResolvedValueOnce([comment(3)])

      const view = render(<VisualizationContainer conversation_id="convA" s={{} as Translations} />)
      await act(async () => {
        view.rerender(<VisualizationContainer conversation_id="convB" s={{} as Translations} />)
      })
      await act(async () => {
        view.rerender(<VisualizationContainer conversation_id="convA" s={{} as Translations} />)
      })
      return view
    }

    it('does not let the first visit resurrect old math and comments', async () => {
      const slowA = deferred<PCAData>()
      const secondA = pcaBody(9)
      const staleA = pcaBody(3)

      await goAthenBthenA(slowA.promise, secondA)
      await waitFor(() => expect(received[received.length - 1]).toBe(secondA))

      await act(async () => {
        slowA.resolve(staleA)
      })

      expect(received).not.toContain(staleA)
      expect(received[received.length - 1]).toBe(secondA)
      // The stale visit's comments must not come back either.
      expect(receivedComments[receivedComments.length - 1]).toEqual([comment(3)])
    })

    it('does not let the first visit surface an obsolete error', async () => {
      const slowA = deferred<PCAData>()
      const secondA = pcaBody(9)

      const view = await goAthenBthenA(slowA.promise, secondA)
      await waitFor(() => expect(received[received.length - 1]).toBe(secondA))

      await act(async () => {
        slowA.reject(new Error('obsolete A failure'))
      })

      expect(view.queryByText('Visualization unavailable')).toBeNull()
      expect(view.queryByTestId('viz')).not.toBeNull()
    })

    it('does not let the first visit clear the current loading state', async () => {
      const slowA = deferred<PCAData>()
      const stillLoadingA = deferred<PCAData>()

      const view = await goAthenBthenA(slowA.promise, stillLoadingA.promise)
      // The second visit to A is still in flight, so the spinner is up.
      expect(view.queryByText('Loading visualization data...')).not.toBeNull()

      await act(async () => {
        slowA.resolve(pcaBody(3))
      })

      // ...and the first visit finishing must not take it down.
      expect(view.queryByText('Loading visualization data...')).not.toBeNull()

      await act(async () => {
        stillLoadingA.resolve(pcaBody(9))
      })
      expect(view.queryByText('Loading visualization data...')).toBeNull()
    })
  })
})
