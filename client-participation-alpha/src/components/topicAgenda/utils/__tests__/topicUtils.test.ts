import type { UmapPoint } from '../../types'
import { calculateClusterCentroid, calculateDistance, cleanTopicDisplayName } from '../topicUtils'

describe('topicUtils', () => {
  describe('calculateClusterCentroid', () => {
    it('should calculate centroid for multiple points', () => {
      const points: UmapPoint[] = [
        { umap_x: 0, umap_y: 0, pid: 1, gid: 1 },
        { umap_x: 4, umap_y: 0, pid: 2, gid: 1 },
        { umap_x: 4, umap_y: 3, pid: 3, gid: 1 },
        { umap_x: 0, umap_y: 3, pid: 4, gid: 1 }
      ]

      const centroid = calculateClusterCentroid(points)

      expect(centroid).toEqual({ x: 2, y: 1.5 })
    })

    it('should return single point as centroid', () => {
      const points: UmapPoint[] = [{ umap_x: 5, umap_y: 10, pid: 1, gid: 1 }]

      const centroid = calculateClusterCentroid(points)

      expect(centroid).toEqual({ x: 5, y: 10 })
    })

    it('should handle negative coordinates', () => {
      const points: UmapPoint[] = [
        { umap_x: -2, umap_y: -3, pid: 1, gid: 1 },
        { umap_x: 2, umap_y: 3, pid: 2, gid: 1 }
      ]

      const centroid = calculateClusterCentroid(points)

      expect(centroid).toEqual({ x: 0, y: 0 })
    })

    it('should return null for empty array', () => {
      const centroid = calculateClusterCentroid([])

      expect(centroid).toBeNull()
    })

    it('should return null for undefined input', () => {
      const centroid = calculateClusterCentroid(undefined)

      expect(centroid).toBeNull()
    })

    it('should handle floating point coordinates', () => {
      const points: UmapPoint[] = [
        { umap_x: 1.5, umap_y: 2.5, pid: 1, gid: 1 },
        { umap_x: 3.5, umap_y: 4.5, pid: 2, gid: 1 }
      ]

      const centroid = calculateClusterCentroid(points)

      expect(centroid).toEqual({ x: 2.5, y: 3.5 })
    })
  })

  describe('calculateDistance', () => {
    it('should calculate distance between two points', () => {
      const point1 = { x: 0, y: 0 }
      const point2 = { x: 3, y: 4 }

      const distance = calculateDistance(point1, point2)

      expect(distance).toBe(5) // 3-4-5 triangle
    })

    it('should return 0 for same point', () => {
      const point = { x: 5, y: 10 }

      const distance = calculateDistance(point, point)

      expect(distance).toBe(0)
    })

    it('should handle negative coordinates', () => {
      const point1 = { x: -3, y: -4 }
      const point2 = { x: 0, y: 0 }

      const distance = calculateDistance(point1, point2)

      expect(distance).toBe(5)
    })

    it('should handle floating point coordinates', () => {
      const point1 = { x: 0, y: 0 }
      const point2 = { x: 1, y: 1 }

      const distance = calculateDistance(point1, point2)

      expect(distance).toBeCloseTo(Math.sqrt(2), 10)
    })

    it('should be symmetric', () => {
      const point1 = { x: 2, y: 3 }
      const point2 = { x: 7, y: 9 }

      const distance1 = calculateDistance(point1, point2)
      const distance2 = calculateDistance(point2, point1)

      expect(distance1).toBe(distance2)
    })
  })

  describe('cleanTopicDisplayName', () => {
    it('should remove layer_cluster prefix', () => {
      const result = cleanTopicDisplayName('2_3: Climate Change', 2, 3)

      expect(result).toBe('Climate Change')
    })

    it('should handle prefix without colon', () => {
      const result = cleanTopicDisplayName('2_3Climate Change', 2, 3)

      expect(result).toBe('Climate Change')
    })

    it('should handle prefix with extra spaces', () => {
      const result = cleanTopicDisplayName('2_3:   Climate Change', 2, 3)

      expect(result).toBe('Climate Change')
    })

    it('should not remove non-matching prefix', () => {
      const result = cleanTopicDisplayName('3_4: Climate Change', 2, 3)

      expect(result).toBe('3_4: Climate Change')
    })

    it('should handle string layer and cluster IDs', () => {
      const result = cleanTopicDisplayName('layer1_cluster2: Topic Name', 'layer1', 'cluster2')

      expect(result).toBe('Topic Name')
    })

    it('should return default name for empty topic', () => {
      const result = cleanTopicDisplayName('', 2, 3)

      expect(result).toBe('Topic 3')
    })

    it('should return default name for null topic', () => {
      const result = cleanTopicDisplayName(null as unknown as string, 2, 3)

      expect(result).toBe('Topic 3')
    })

    it('should return default name for undefined topic', () => {
      const result = cleanTopicDisplayName(undefined as unknown as string, 2, 3)

      expect(result).toBe('Topic 3')
    })

    it('should handle topic that is just the prefix', () => {
      const result = cleanTopicDisplayName('2_3', 2, 3)

      expect(result).toBe('')
    })

    it('should handle topic with prefix but no content after colon', () => {
      const result = cleanTopicDisplayName('2_3:', 2, 3)

      expect(result).toBe('')
    })

    it('should not modify topic without matching prefix', () => {
      const result = cleanTopicDisplayName('Climate Change Topic', 2, 3)

      expect(result).toBe('Climate Change Topic')
    })

    it('should handle numeric-looking content that is not a prefix', () => {
      const result = cleanTopicDisplayName('1_2_3 is a sequence', 2, 3)

      expect(result).toBe('1_2_3 is a sequence')
    })
  })
})
