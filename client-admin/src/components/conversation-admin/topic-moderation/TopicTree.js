/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState, useEffect } from 'react'
import { Box, Flex, Heading, Text, Button } from 'theme-ui'
import { Link, useParams } from 'react-router-dom'
import PropTypes from 'prop-types'

const TopicTree = ({ conversation_id }) => {
  const [selectedLayer, setSelectedLayer] = useState('0')
  const [expandedTopics, setExpandedTopics] = useState(new Set())
  const [topicsData, setTopicsData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const params = useParams()

  const loadTopics = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch(`/api/v3/topicMod/topics?conversation_id=${conversation_id}`)
      const data = await response.json()
      if (data.status === 'success') {
        setTopicsData(data.topics_by_layer || {})
      } else {
        setError(data.message || 'Failed to load topics')
      }
    } catch (err) {
      setError('Network error loading topics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTopics()
  }, [conversation_id])

  const toggleTopic = (topicKey) => {
    const newExpanded = new Set(expandedTopics)
    if (newExpanded.has(topicKey)) {
      newExpanded.delete(topicKey)
    } else {
      newExpanded.add(topicKey)
    }
    setExpandedTopics(newExpanded)
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'accepted':
        return 'primary'
      case 'rejected':
        return 'error'
      default:
        return 'gray'
    }
  }

  const moderateTopic = async (topicKey, action) => {
    try {
      const response = await fetch('/api/v3/topicMod/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          conversation_id: conversation_id,
          topic_key: topicKey,
          action: action,
          moderator: 'admin' // TODO: Get from auth state
        })
      })
      const data = await response.json()
      if (data.status === 'success') {
        loadTopics()
      } else {
        console.error('Moderation failed:', data.message)
      }
    } catch (err) {
      console.error('Network error during moderation:', err)
    }
  }

  const renderTopic = (topic, layerId, clusterId) => {
    const topicKey = topic.topic_key || `${layerId}_${clusterId}`
    const isExpanded = expandedTopics.has(topicKey)
    const status = topic.moderation?.status || 'pending'
    const commentCount = Number(topic.moderation?.comment_count || 0)
    return (
      <Box
        key={topicKey}
        sx={{
          border: '1px solid',
          borderColor: 'border',
          borderRadius: 'default',
          p: [2, 3, 3],
          mb: 2,
          bg: 'background'
        }}>
        <Flex
          sx={{
            alignItems: ['flex-start', 'center', 'center'],
            justifyContent: 'space-between',
            flexDirection: ['column', 'row', 'row'],
            gap: [2, 0, 0]
          }}>
          <Box sx={{ flex: 1, width: ['100%', 'auto', 'auto'] }}>
            <Flex sx={{ alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: [1, 2, 2] }}>
              <Button
                variant="outline"
                size="small"
                onClick={() => toggleTopic(topicKey)}
                sx={{ p: 1, fontSize: 0, minWidth: '32px' }}>
                {isExpanded ? '−' : '+'}
              </Button>
              <Text sx={{ fontWeight: 'bold', color: getStatusColor(status), fontSize: [1, 2, 2] }}>
                Layer {layerId}, Cluster {clusterId}
              </Text>
              <Text sx={{ fontSize: 0, color: 'textSecondary', ml: 2 }}>Status: {status}</Text>
            </Flex>
            <Text sx={{ mb: 2, fontSize: [1, 2, 2], wordWrap: 'break-word' }}>
              {topic.topic_name || 'Unnamed Topic'}
            </Text>
            <Text sx={{ fontSize: 0, color: 'textSecondary', ml: 2 }}>
              {commentCount > 0 ? commentCount + ' comments' : 'No comments'}
            </Text>
          </Box>
          <Flex
            sx={{
              gap: [1, 2, 2],
              flexDirection: ['column', 'row', 'row'],
              width: ['100%', 'auto', 'auto'],
              flexWrap: ['nowrap', 'wrap', 'nowrap']
            }}>
            <Button
              variant="primary"
              size="small"
              onClick={() => moderateTopic(topicKey, 'accept')}
              disabled={status === 'accepted'}
              sx={{
                fontSize: [0, 1, 1],
                px: [2, 2, 2],
                py: [1, 1, 1],
                width: ['100%', 'auto', 'auto']
              }}>
              Accept
            </Button>
            <Button
              variant="danger"
              size="small"
              onClick={() => moderateTopic(topicKey, 'reject')}
              disabled={status === 'rejected'}
              sx={{
                fontSize: [0, 1, 1],
                px: [2, 2, 2],
                py: [1, 1, 1],
                width: ['100%', 'auto', 'auto']
              }}>
              Reject
            </Button>
            <Link
              to={`/m/${conversation_id}/topics/topic/${encodeURIComponent(topicKey)}`}
              sx={{ width: ['100%', 'auto', 'auto'] }}>
              <Button
                variant="outline"
                size="small"
                sx={{ fontSize: [0, 1, 1], px: [2, 2, 2], py: [1, 1, 1], width: '100%' }}>
                View Comments
              </Button>
            </Link>
          </Flex>
        </Flex>
        {isExpanded && (
          <Box sx={{ mt: 3, pl: 4, borderLeft: '2px solid', borderColor: 'border' }}>
            <Text sx={{ fontSize: 0, color: 'textSecondary', mb: 2 }}>
              Model: {topic.model_name || 'Unknown'}
            </Text>
            <Text sx={{ fontSize: 0, color: 'textSecondary' }}>
              Created: {topic.created_at ? new Date(topic.created_at).toLocaleString() : 'Unknown'}
            </Text>
            {topic.moderation?.moderator && (
              <Text sx={{ fontSize: 0, color: 'textSecondary', mt: 1 }}>
                Moderated by: {topic.moderation.moderator}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  }

  const renderLayer = (layerId, topics) => {
    const layerTopics = Object.entries(topics).sort(([a], [b]) => parseInt(a) - parseInt(b))
    return (
      <Box key={layerId} sx={{ mb: 4 }}>
        <Heading as="h4" sx={{ mb: 3, fontSize: 2 }}>
          Layer {layerId} ({layerTopics.length} topics)
        </Heading>
        {layerTopics.map(([clusterId, topic]) => renderTopic(topic, layerId, clusterId))}
      </Box>
    )
  }

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Text>Loading topics...</Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Text sx={{ color: 'error' }}>Error: {error}</Text>
        <Button sx={{ mt: 2 }} onClick={loadTopics}>
          Retry
        </Button>
      </Box>
    )
  }

  if (!topicsData || Object.keys(topicsData).length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Text>No topics available for this conversation.</Text>
        <Text sx={{ fontSize: 0, color: 'textSecondary', mt: 2 }}>
          Topics are generated by the Delphi pipeline. Make sure the pipeline has been run for this
          conversation.
        </Text>
      </Box>
    )
  }

  const layers = Object.entries(topicsData).sort(([a], [b]) => parseInt(a) - parseInt(b))

  return (
    <Box>
      <Box sx={{ mb: 4 }}>
        <Text sx={{ fontWeight: 'bold', mb: [2], display: 'block' }}>View Layer:</Text>
        <Flex sx={{ gap: 2, flexWrap: 'wrap' }}>
          {layers.map(([layerId]) => (
            <Button
              key={layerId}
              variant={selectedLayer === layerId ? 'primary' : 'outline'}
              size="small"
              onClick={() => setSelectedLayer(layerId)}
              sx={{
                fontSize: [1, 2, 2],
                px: [2, 3, 3],
                py: [1, 2, 2],
                minWidth: ['auto', 'auto', 'auto']
              }}>
              Layer {layerId}
            </Button>
          ))}
          <Button
            variant={selectedLayer === 'all' ? 'primary' : 'outline'}
            size="small"
            onClick={() => setSelectedLayer('all')}
            sx={{
              fontSize: [1, 2, 2],
              px: [2, 3, 3],
              py: [1, 2, 2],
              minWidth: ['auto', 'auto', 'auto']
            }}>
            All Layers
          </Button>
        </Flex>
      </Box>
      {selectedLayer === 'all'
        ? layers.map(([layerId, topics]) => renderLayer(layerId, topics))
        : topicsData[selectedLayer] && renderLayer(selectedLayer, topicsData[selectedLayer])}
    </Box>
  )
}

TopicTree.propTypes = {
  conversation_id: PropTypes.string.isRequired
}

export default TopicTree
