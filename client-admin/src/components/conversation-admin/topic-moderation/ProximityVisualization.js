/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { connect } from 'react-redux'
import { jsx, Box, Flex, Heading, Text, Button, Select } from 'theme-ui'

const mapStateToProps = (state) => {
  return {
    zid_metadata: state.zid_metadata
  }
}

@connect(mapStateToProps)
class ProximityVisualization extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      proximityData: [],
      selectedLayer: '0',
      loading: true,
      error: null,
      svgRef: React.createRef()
    }
  }

  componentDidMount() {
    this.loadProximityData()
  }

  async loadProximityData() {
    try {
      this.setState({ loading: true, error: null })
      const { match } = this.props
      const { selectedLayer } = this.state
      const conversation_id = match.params.conversation_id

      // Fetch proximity data (UMAP coordinates)
      const response = await fetch(
        `/api/v3/topicMod/proximity?report_id=${conversation_id}&layer_id=${selectedLayer}`
      )
      const data = await response.json()

      if (data.status === 'success') {
        this.setState(
          {
            proximityData: data.proximity_data || [],
            loading: false
          },
          () => {
            this.renderVisualization()
          }
        )
      } else {
        this.setState({
          error: data.message || 'Failed to load proximity data',
          loading: false
        })
      }
    } catch (err) {
      this.setState({
        error: 'Network error loading proximity data',
        loading: false
      })
    }
  }

  componentDidUpdate(prevState) {
    if (prevState.selectedLayer !== this.state.selectedLayer) {
      this.loadProximityData()
    }
  }

  renderVisualization() {
    const { proximityData } = this.state
    const svgElement = this.state.svgRef.current

    if (!svgElement || proximityData.length === 0) return

    // Clear previous content
    svgElement.innerHTML = ''

    // Set up dimensions
    const width = 800
    const height = 600
    const margin = 50

    // Calculate bounds
    const xValues = proximityData.map((d) => d.umap_x).filter((x) => x !== undefined)
    const yValues = proximityData.map((d) => d.umap_y).filter((y) => y !== undefined)

    if (xValues.length === 0 || yValues.length === 0) {
      svgElement.innerHTML =
        '<text x="50%" y="50%" text-anchor="middle" fill="#666">No coordinate data available</text>'
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
          return '#22c55e'
        case 'rejected':
        case -1:
          return '#ef4444'
        case 'meta':
        case 0:
          return '#f59e0b'
        default:
          return '#6b7280'
      }
    }

    // Group by cluster for better visualization
    const clusters = {}
    proximityData.forEach((point) => {
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
      circle.setAttribute('fill', '#f3f4f6')
      circle.setAttribute('stroke', '#d1d5db')
      circle.setAttribute('stroke-width', '1')
      circle.setAttribute('opacity', '0.3')
      svgElement.appendChild(circle)

      // Add cluster label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', centerX)
      text.setAttribute('y', centerY - maxRadius + 15)
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('fill', '#6b7280')
      text.setAttribute('font-size', '12')
      text.textContent = `Cluster ${clusterId}`
      svgElement.appendChild(text)
    })

    // Render points
    proximityData.forEach((point, index) => {
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
    xAxis.setAttribute('stroke', '#d1d5db')
    xAxis.setAttribute('stroke-width', '1')
    svgElement.appendChild(xAxis)

    const yAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    yAxis.setAttribute('x1', margin)
    yAxis.setAttribute('y1', margin)
    yAxis.setAttribute('x2', margin)
    yAxis.setAttribute('y2', height - margin)
    yAxis.setAttribute('stroke', '#d1d5db')
    yAxis.setAttribute('stroke-width', '1')
    svgElement.appendChild(yAxis)

    // Add axis labels
    const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    xLabel.setAttribute('x', width / 2)
    xLabel.setAttribute('y', height - 10)
    xLabel.setAttribute('text-anchor', 'middle')
    xLabel.setAttribute('fill', '#6b7280')
    xLabel.textContent = 'UMAP Dimension 1'
    svgElement.appendChild(xLabel)

    const yLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    yLabel.setAttribute('x', 15)
    yLabel.setAttribute('y', height / 2)
    yLabel.setAttribute('text-anchor', 'middle')
    yLabel.setAttribute('fill', '#6b7280')
    yLabel.setAttribute('transform', `rotate(-90, 15, ${height / 2})`)
    yLabel.textContent = 'UMAP Dimension 2'
    svgElement.appendChild(yLabel)
  }

  render() {
    const { loading, error, proximityData, selectedLayer } = this.state

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
          <Button sx={{ mt: 2 }} onClick={() => this.loadProximityData()}>
            Retry
          </Button>
        </Box>
      )
    }

    return (
      <Box>
        <Flex sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 4 }}>
          <Heading as="h3">Proximity Visualization</Heading>
          <Flex sx={{ alignItems: 'center', gap: 2 }}>
            <Text>Layer:</Text>
            <Select
              value={selectedLayer}
              onChange={(e) => this.setState({ selectedLayer: e.target.value })}
              sx={{ width: '100px' }}>
              <option value="0">Layer 0</option>
              <option value="1">Layer 1</option>
              <option value="2">Layer 2</option>
            </Select>
          </Flex>
        </Flex>

        <Text sx={{ mb: 4, color: 'textSecondary' }}>
          This visualization shows comments positioned by semantic similarity using UMAP
          coordinates. Comments that are closer together are more semantically similar.
        </Text>

        {proximityData.length > 0 ? (
          <Box>
            <Box sx={{ mb: 3 }}>
              <Flex sx={{ gap: 3, alignItems: 'center', fontSize: 0 }}>
                <Flex sx={{ alignItems: 'center', gap: 1 }}>
                  <Box sx={{ width: '12px', height: '12px', bg: '#6b7280', borderRadius: '50%' }} />
                  <Text>Pending</Text>
                </Flex>
                <Flex sx={{ alignItems: 'center', gap: 1 }}>
                  <Box sx={{ width: '12px', height: '12px', bg: '#22c55e', borderRadius: '50%' }} />
                  <Text>Accepted</Text>
                </Flex>
                <Flex sx={{ alignItems: 'center', gap: 1 }}>
                  <Box sx={{ width: '12px', height: '12px', bg: '#ef4444', borderRadius: '50%' }} />
                  <Text>Rejected</Text>
                </Flex>
                <Flex sx={{ alignItems: 'center', gap: 1 }}>
                  <Box sx={{ width: '12px', height: '12px', bg: '#f59e0b', borderRadius: '50%' }} />
                  <Text>Meta</Text>
                </Flex>
              </Flex>
            </Box>

            <Box
              sx={{
                border: '1px solid',
                borderColor: 'border',
                borderRadius: 'default',
                overflow: 'hidden'
              }}>
              <svg
                ref={this.state.svgRef}
                width="800"
                height="600"
                style={{ display: 'block', margin: '0 auto' }}></svg>
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
}

export default ProximityVisualization
