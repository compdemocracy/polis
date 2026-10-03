import { render, renderHook } from '@testing-library/react'
import { describe, expect, jest, test } from '@jest/globals'
import type { PCAData } from '../../../api/types'
import { DB_VOTE, cellFromVotes } from '../../../api/voteCounts'
import { useVisualizationData } from '../useVisualizationData'
import { VoteBarCharts } from '../VoteBarCharts'
import type { Hull } from '../types'

jest.mock('concaveman', () => ({ __esModule: true, default: jest.fn(() => []) }))

// Generated fixture: one group, one statement seen by twelve members.
const GROUP_ID = 0
const TID = 5
const AGREES = 6
const DISAGREES = 3
const PASSES = 3
const SEEN = AGREES + DISAGREES + PASSES
const BAR_WIDTH = 60 // VoteBarCharts' total bar width

const cell = cellFromVotes([
  ...Array<number>(AGREES).fill(DB_VOTE.AGREE),
  ...Array<number>(DISAGREES).fill(DB_VOTE.DISAGREE),
  ...Array<number>(PASSES).fill(DB_VOTE.PASS)
])

const data: PCAData = {
  'group-votes': { [GROUP_ID]: { 'n-members': SEEN, votes: { [TID]: cell } } }
}

describe('group vote bars', () => {
  test('group vote data reads S as seen, not as a third kind of vote', () => {
    const { result } = renderHook(() => useVisualizationData(data, null, true, TID, null))
    expect(result.current.groupVoteData).toEqual([
      { groupId: GROUP_ID, agree: AGREES, disagree: DISAGREES, pass: PASSES, seen: SEEN }
    ])
  })

  test('bar segments are agree/disagree/pass shares of everyone who saw it', () => {
    const { result } = renderHook(() => useVisualizationData(data, null, true, TID, null))
    const hulls: Hull[] = [
      { groupId: GROUP_ID, hull: null, points: [], participantCount: SEEN, center: [0, 0] }
    ]
    const { container } = render(
      <svg>
        <VoteBarCharts hulls={hulls} groupVoteData={result.current.groupVoteData} />
      </svg>
    )
    const widths = Array.from(container.querySelectorAll('rect')).map((r) =>
      Number(r.getAttribute('width'))
    )
    expect(widths).toHaveLength(3)
    const [agree, disagree, pass] = widths
    expect(agree).toBeCloseTo((AGREES / SEEN) * BAR_WIDTH)
    expect(disagree).toBeCloseTo((DISAGREES / SEEN) * BAR_WIDTH)
    expect(pass).toBeCloseTo((PASSES / SEEN) * BAR_WIDTH)
    expect(agree + disagree + pass).toBeCloseTo(BAR_WIDTH)
  })
})
