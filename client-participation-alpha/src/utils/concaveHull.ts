import concaveman from 'concaveman';

/**
 * Thin wrapper around the local TypeScript port of `hull.js`.
 *
 * @param points Array of [x, y] coordinates.
 * @param concavity Maximum edge length threshold (in coordinate units). Smaller = more concave.
 * @param lengthThreshold Minimum edge length threshold (in coordinate units). Smaller = more concave.
 * @returns Closed concave hull polyline (first point repeated) or null if not enough points.
 */
export function concaveHull(points: number[][], concavity: number, lengthThreshold: number): number[][] | null {
  if (points.length < 3) return null;

  const result = concaveman(points, concavity, lengthThreshold);

  if (result.length === 0) {
    return null;
  }

  return result;
}
