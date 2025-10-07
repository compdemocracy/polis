/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Box, Flex, Heading, Text, Button, Select } from 'theme-ui'
import theme from '../../../theme'

const ProximityVisualization = () => {
  const [proximityData, setProximityData] = useState([])
  const [selectedLayer, setSelectedLayer] = useState('0')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const svgRef = useRef(null)
  const params = useParams()

  const renderVisualization = (data) => {
    const svgElement = svgRef.current

    if (!svgElement || data.length === 0) return

    // Clear previous content
    svgElement.innerHTML = ''

    // Set up dimensions
    const width = 800
    const height = 600
    const margin = 50

    // Calculate bounds
    const xValues = data.map((d) => d.umap_x).filter((x) => x !== undefined)
    const yValues = data.map((d) => d.umap_y).filter((y) => y !== undefined)

    if (xValues.length === 0 || yValues.length === 0) {
      svgElement.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="${theme.colors.gray}">No coordinate data available</text>`
      return
    }

    const xMin = Math.min(...xValues)
    const xMax = Math.max(...xValues)
    const yMin = Math.min(...yValues)
    const yMax = Math.max(...yValues)

    // Create scales
    const xScale = (x) => margin + ((x - xMin) / (xMax - xMin)) * (width - 2 * margin)
    const yScale = (y) => height - margin - ((y - yMin) / (yMax - yMin)) * (height - 2 * margin)

    // Color mapping for moderation status
    const getColor = (status) => {
      switch (status) {
        case 'accepted':
        case 1:
          return theme.colors.primary
        case 'rejected':
        case -1:
          return theme.colors.error
        case 'meta':
        case 0:
          return theme.colors.lightGray
        default:
          return theme.colors.gray
      }
    }

    // Group by cluster for better visualization
    const clusters = {}
    data.forEach((point) => {
      const clusterId = point.cluster_id || 0
      if (!clusters[clusterId]) clusters[clusterId] = []
      clusters[clusterId].push(point)
    })

    // Render cluster backgrounds (convex hulls would be better, but this is simpler)
    Object.entries(clusters).forEach(([clusterId, points]) => {
      if (points.length < 3) return

      const clusterXs = points.map((p) => xScale(p.umap_x))
      const clusterYs = points.map((p) => yScale(p.umap_y))
      const centerX = clusterXs.reduce((a, b) => a + b) / clusterXs.length
      const centerY = clusterYs.reduce((a, b) => a + b) / clusterYs.length
      const maxRadius =
        Math.max(
          ...points.map((p) =>
            Math.sqrt(
              Math.pow(xScale(p.umap_x) - centerX, 2) + Math.pow(yScale(p.umap_y) - centerY, 2)
            )
          )
        ) + 20

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', centerX)
      circle.setAttribute('cy', centerY)
      circle.setAttribute('r', maxRadius)
      circle.setAttribute('fill', theme.colors.clusterBg)
      circle.setAttribute('stroke', theme.colors.clusterStroke)
      circle.setAttribute('stroke-width', '1')
      circle.setAttribute('opacity', '0.3')
      svgElement.appendChild(circle)

      // Add cluster label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', centerX)
      text.setAttribute('y', centerY - maxRadius + 15)
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('fill', theme.colors.gray)
      text.setAttribute('font-size', '12')
      text.textContent = `Cluster ${clusterId}`
      svgElement.appendChild(text)
    })

    // Render points
    data.forEach((point, index) => {
      if (point.umap_x === undefined || point.umap_y === undefined) return

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      const x = xScale(point.umap_x)
      const y = yScale(point.umap_y)

      circle.setAttribute('cx', x)
      circle.setAttribute('cy', y)
      circle.setAttribute('r', '4')
      circle.setAttribute('fill', getColor(point.moderation_status))
      circle.setAttribute('stroke', '#fff')
      circle.setAttribute('stroke-width', '1')
      circle.setAttribute('cursor', 'pointer')

      // Add tooltip on hover
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = `Comment ${point.comment_id}\nCluster: ${point.cluster_id}\nStatus: ${point.moderation_status || 'pending'}\n\n${point.comment_text?.substring(0, 100)}...`
      circle.appendChild(title)

      svgElement.appendChild(circle)
    })

    // Add axes
    const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    xAxis.setAttribute('x1', margin)
    xAxis.setAttribute('y1', height - margin)
    xAxis.setAttribute('x2', width - margin)
    xAxis.setAttribute('y2', height - margin)
    xAxis.setAttribute('stroke', theme.colors.clusterStroke)
    xAxis.setAttribute('stroke-width', '1')
    svgElement.appendChild(xAxis)

    const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    yAxis.setAttribute('x1', margin)
    yAxis.setAttribute('y1', margin)
    yAxis.setAttribute('x2', margin)
    yAxis.setAttribute('y2', height - margin)
    yAxis.setAttribute('stroke', theme.colors.clusterStroke)
    yAxis.setAttribute('stroke-width', '1')
    svgElement.appendChild(yAxis)

    // Add axis labels
    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    xLabel.setAttribute('x', width / 2)
    xLabel.setAttribute('y', height - 10)
    xLabel.setAttribute('text-anchor', 'middle')
    xLabel.setAttribute('fill', theme.colors.gray)
    xLabel.textContent = 'UMAP Dimension 1'
    svgElement.appendChild(xLabel)

    const yLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    yLabel.setAttribute('x', 15)
    yLabel.setAttribute('y', height / 2)
    yLabel.setAttribute('text-anchor', 'middle')
    yLabel.setAttribute('fill', theme.colors.gray)
    yLabel.setAttribute('transform', `rotate(-90, 15, ${height / 2})`)
    yLabel.textContent = 'UMAP Dimension 2'
    svgElement.appendChild(yLabel)
  }

  const loadProximityData = async () => {
    try {
      setLoading(true)
      setError(null)
      const conversation_id = params.conversation_id

      // Fetch proximity data (UMAP coordinates)
      const response = await fetch(
        `/api/v3/topicMod/proximity?conversation_id=${conversation_id}&layer_id=${selectedLayer}`
      )
      const data = await response.json()

      if (data.status === 'success') {
        setProximityData(data.proximity_data || [])
        setLoading(false)
        renderVisualization(data.proximity_data || [])
      } else {
        setError(data.message || 'Failed to load proximity data')
        setLoading(false)
      }
    } catch (err) {
      setError('Network error loading proximity data')
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProximityData()
  }, [selectedLayer, params.conversation_id])

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Text>Loading proximity visualization...</Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Text sx={{ color: 'error' }}>Error: {error}</Text>
        <Button sx={{ mt: 2, ml: 3 }} onClick={loadProximityData}>
          Retry
        </Button>
      </Box>
    )
  }

  return (
    <Box>
      <Flex
        sx={{
          alignItems: ['flex-start', 'center', 'center'],
          justifyContent: 'space-between',
          mb: 4,
          flexDirection: ['column', 'row', 'row'],
          gap: [2, 0, 0]
        }}>
        <Heading as="h3" sx={{ fontSize: [2, 3, 3] }}>
          Proximity Visualization
        </Heading>
        <Flex sx={{ alignItems: 'center', gap: 2 }}>
          <Text sx={{ fontSize: [1, 2, 2] }}>Layer:</Text>
          <Select
            value={selectedLayer}
            onChange={(e) => setSelectedLayer(e.target.value)}
            sx={{ width: ['80px', '100px', '120px'], fontSize: [1, 2, 2] }}>
            <option value="0">Layer 0</option>
            <option value="1">Layer 1</option>
            <option value="2">Layer 2</option>
          </Select>
        </Flex>
      </Flex>

      <Text sx={{ mb: 4, color: 'textSecondary' }}>
        This visualization shows comments positioned by semantic similarity using UMAP coordinates.
        Comments that are closer together are more semantically similar.
      </Text>

      {proximityData.length > 0 ? (
        <Box>
          <Box sx={{ mb: 3 }}>
            <Flex sx={{ gap: [2, 3, 3], alignItems: 'center', fontSize: 0, flexWrap: 'wrap' }}>
              <Flex sx={{ alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: '12px',
                    height: '12px',
                    bg: 'gray',
                    borderRadius: '50%',
                    flexShrink: 0
                  }}
                />
                <Text sx={{ whiteSpace: 'nowrap' }}>Pending</Text>
              </Flex>
              <Flex sx={{ alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: '12px',
                    height: '12px',
                    bg: 'primary',
                    borderRadius: '50%',
                    flexShrink: 0
                  }}
                />
                <Text sx={{ whiteSpace: 'nowrap' }}>Accepted</Text>
              </Flex>
              <Flex sx={{ alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: '12px',
                    height: '12px',
                    bg: 'error',
                    borderRadius: '50%',
                    flexShrink: 0
                  }}
                />
                <Text sx={{ whiteSpace: 'nowrap' }}>Rejected</Text>
              </Flex>
              <Flex sx={{ alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: '12px',
                    height: '12px',
                    bg: 'lightGray',
                    borderRadius: '50%',
                    flexShrink: 0
                  }}
                />
                <Text sx={{ whiteSpace: 'nowrap' }}>Meta</Text>
              </Flex>
            </Flex>
          </Box>

          <Box
            sx={{
              border: '1px solid',
              borderColor: 'border',
              borderRadius: 'default',
              overflow: 'auto',
              width: '100%'
            }}>
            <svg
              ref={svgRef}
              width="800"
              height="600"
              viewBox="0 0 800 600"
              preserveAspectRatio="xMidYMid meet"
              style={{
                display: 'block',
                margin: '0 auto',
                maxWidth: '100%',
                height: 'auto'
              }}></svg>
          </Box>

          <Text sx={{ mt: 2, fontSize: 0, color: 'textSecondary', textAlign: 'center' }}>
            Hover over points to see comment details. Points are grouped by semantic clusters.
          </Text>
        </Box>
      ) : (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text>No proximity data available for this layer.</Text>
        </Box>
      )}
    </Box>
  )
}

export default ProximityVisualization
