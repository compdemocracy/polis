import { renderHook } from '@testing-library/react'
import { describe, expect, jest, test } from '@jest/globals'
import schedule from '../../../../../delphi/scripts/schedules/pc-zerovote-01-empty.json'
import type { PCAData } from '../../../api/types'
import { useVisualizationData } from '../useVisualizationData'
import { xMax, yMax } from '../constants'

// Empty/one-point geometry must never invoke the hull algorithm. Real React and
// visx scales are used; the ESM hull package is the sole external boundary double.
jest.mock('concaveman', () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error('unexpected hull computation')
  })
}))
function emptyMath(legacy = false): PCAData {
  const value: Record<string, unknown> = {
    pca: { comps: [[], []] },
    'base-clusters': { id: [], x: [], y: [], count: [], members: [] },
    repness: {}
  }
  for (const [key, field] of Object.entries(schedule.empty_output)) {
    const [parent, leaf] = key.split('.')
    if (leaf) (value[parent] as Record<string, unknown>)[leaf] = field
    else value[parent] = field
  }
  if (legacy)
    for (const key of schedule.legacy_absent_keys) {
      const [parent, leaf] = key.split('.')
      if (leaf) delete (value[parent] as Record<string, unknown>)[leaf]
      else delete value[parent]
    }
  return value as PCAData
}
function useTestVisualization(data: PCAData) {
  return useVisualizationData(data, null, true, null, null)
}
describe('empty visualization', () => {
  test.each([false, true])('schedule fixture has finite, centered origins; legacy=%s', (legacy) => {
    const { result } = renderHook(() => useTestVisualization(emptyMath(legacy)))
    expect(result.current.baseClusters).toEqual([])
    expect(result.current.hulls).toEqual([])
    expect(result.current.statements).toEqual([])
    expect(result.current.groupVoteData).toEqual([])
    expect(result.current.userPosition).toBeNull()
    expect(result.current.originX).toBe(xMax / 2)
    expect(result.current.originY).toBe(yMax / 2)
  })
  test('a response omitting both cluster fields is valid and safe', () => {
    const data: PCAData = {}
    const { result } = renderHook(() => useTestVisualization(data))
    expect(result.current.baseClusters).toEqual([])
    expect(result.current.hulls).toEqual([])
    expect(Number.isFinite(result.current.originX)).toBe(true)
    expect(Number.isFinite(result.current.originY)).toBe(true)
  })
  test('missing groups preserve existing base-cluster points as unassigned', () => {
    const data: PCAData = {
      'base-clusters': { id: [7], x: [2], y: [3], count: [1], members: [[12]] }
    }
    const { result } = renderHook(() => useVisualizationData(data, null, false, null, 12))
    expect(result.current.baseClusters[0]).toEqual({
      id: 7,
      x: 2,
      y: 3,
      count: 1,
      groupId: -1,
      members: [12]
    })
    expect(result.current.hulls).toEqual([])
    expect(result.current.userPosition).toEqual({ x: xMax / 2, y: yMax / 2 })
  })
  test('missing base clusters allow an empty group hull with finite center', () => {
    const data: PCAData = { 'group-clusters': [{ id: 0, members: [7], center: [0, 0] }] }
    const { result } = renderHook(() => useTestVisualization(data))
    expect(result.current.hulls).toEqual([
      { groupId: 0, hull: null, points: [], participantCount: 0, center: [xMax / 2, yMax / 2] }
    ])
  })
  test('one-point populated geometry preserves membership and resets on empty data', () => {
    const data: PCAData = {
      'base-clusters': { id: [7], x: [2], y: [3], count: [1], members: [[12]] },
      'group-clusters': [{ id: 0, members: [7], center: [2, 3] }]
    }
    const { result, rerender } = renderHook(
      ({ data }) => useVisualizationData(data, 0, false, null, 12),
      { initialProps: { data } }
    )
    expect(result.current.baseClusters[0].groupId).toBe(0)
    expect(result.current.hulls[0].participantCount).toBe(1)
    expect(result.current.userPosition).toEqual({ x: xMax / 2, y: yMax / 2 })
    rerender({ data: emptyMath() })
    expect(result.current.baseClusters).toEqual([])
    expect(result.current.hulls).toEqual([])
    expect(result.current.userPosition).toBeNull()
    expect(Number.isFinite(result.current.originX)).toBe(true)
    expect(Number.isFinite(result.current.originY)).toBe(true)
  })
})
