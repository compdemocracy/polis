/**
 * Helper function to select top consensus items
 * Handles items with tied scores by including all tied items, up to a tolerance
 */
export function selectTopConsensusItems(
  data: Record<string, number>,
  targetCount: number = 5,
  maxExcess: number = 10
): string[] {
  // Convert to array and sort descending by score
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])

  const selectedTids: string[] = []
  let i = 0

  while (i < entries.length) {
    // If we already have enough items, stop
    if (selectedTids.length >= targetCount) {
      break
    }

    const currentScore = entries[i][1]
    const candidates: string[] = []

    // Collect all items with the same score (using epsilon for float comparison)
    let j = i
    while (j < entries.length && Math.abs(entries[j][1] - currentScore) < Number.EPSILON) {
      candidates.push(entries[j][0])
      j++
    }

    // Check if adding these candidates would exceed the limit
    // We allow exceeding if it's the very first group (to ensure we show something)
    // or if the total count is within tolerance
    if (
      selectedTids.length === 0 ||
      selectedTids.length + candidates.length <= targetCount + maxExcess
    ) {
      selectedTids.push(...candidates)
      i = j
    } else {
      // If adding this group exceeds the limit and we already have items, stop here
      break
    }
  }

  return selectedTids
}
