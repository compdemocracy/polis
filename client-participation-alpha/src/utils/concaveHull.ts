import hull from '../../lib/hull';

type Point = [number, number];

/**
 * Thin wrapper around the local TypeScript port of `hull.js`.
 *
 * @param points Array of [x, y] coordinates.
 * @param concavity Maximum edge length threshold (in coordinate units). Smaller = more concave.
 * @returns Closed concave hull polyline (first point repeated) or null if not enough points.
 */
export function concaveHull(points: Point[], concavity: number): Point[] | null {
  if (points.length < 3) return null;

  const result = hull(points, concavity);

  if (result.length === 0) {
    return null;
  }

  return result;
}

