import { act, render, waitFor } from '@testing-library/react'
import VisualizationContainer from '../VisualizationContainer'
import { fetchPCAData, PCA_VISUALIZATION_KEYS } from '../../api/pca'
import { fetchComments } from '../../api/comments'
import { REFRESH_DELAY_MS } from '../visualization/constants'
import type { PCAData } from '../../api/types'
import type { Translations } from '../../strings/types'

jest.mock('../../lib/net')
jest.mock('../../lib/lang')
jest.mock('../../api/pca', () => {
  const actual = jest.requireActual('../../api/pca')
  return { ...actual, fetchPCAData: jest.fn() }
})
jest.mock('../../api/comments')

// Record every `data` object the visualization is handed, so we can tell a
// short-circuited poll (no new object) from an applied one.
const received: PCAData[] = []
jest.mock('../visualization', () => ({
  PCAVisualization: (props: { data: PCAData }) => {
    received.push(props.data)
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

async function triggerPoll() {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('polis-vote-submitted', {
        detail: { conversation_id: CONVERSATION_ID }
      })
    )
    jest.advanceTimersByTime(REFRESH_DELAY_MS)
  })
}

describe('VisualizationContainer math_tick guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    received.length = 0
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
})
