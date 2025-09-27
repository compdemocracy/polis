/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { connect } from 'react-redux'
import { jsx, Box, Flex, Heading, Text, Button } from 'theme-ui'
import { Link } from 'react-router-dom'

const mapStateToProps = (state) => {
  return {
    topics: state.topic_mod_topics || {},
    zid_metadata: state.zid_metadata
  }
}

@connect(mapStateToProps)
class TopicTree extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      selectedLayer: '0',
      expandedTopics: new Set(),
      topicsData: null,
      loading: true,
      error: null
    }
  }

  componentDidMount() {
    this.loadTopics()
  }

  async loadTopics() {
    try {
      this.setState({ loading: true, error: null })
      const conversation_id = this.props.conversation_id

      console.log('TopicTree loadTopics - conversation_id:', conversation_id)

      // Fetch topics from API
      const response = await fetch(`/api/v3/topicMod/topics?conversation_id=${conversation_id}`)
      const data = await response.json()

      if (data.status === 'success') {
        this.setState({
          topicsData: data.topics_by_layer || {},
          loading: false
        })
      } else {
        this.setState({
          error: data.message || 'Failed to load topics',
          loading: false
        })
      }
    } catch (err) {
      this.setState({
        error: 'Network error loading topics',
        loading: false
      })
    }
  }

  toggleTopic(topicKey) {
    const { expandedTopics } = this.state
    const newExpanded = new Set(expandedTopics)

    if (newExpanded.has(topicKey)) {
      newExpanded.delete(topicKey)
    } else {
      newExpanded.add(topicKey)
    }

    this.setState({ expandedTopics: newExpanded })
  }

  getStatusColor(status) {
    switch (status) {
      case 'accepted':
        return 'green'
      case 'rejected':
        return 'red'
      case 'meta':
        return 'orange'
      default:
        return 'gray'
    }
  }

  async moderateTopic(topicKey, action) {
    try {
      const conversation_id = this.props.conversation_id

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
        // Reload topics to reflect changes
        this.loadTopics()
      } else {
        console.error('Moderation failed:', data.message)
      }
    } catch (err) {
      console.error('Network error during moderation:', err)
    }
  }

  renderTopic(topic, layerId, clusterId) {
    const { match } = this.props
    const { expandedTopics } = this.state
    const topicKey = topic.topic_key || `${layerId}_${clusterId}`
    const isExpanded = expandedTopics.has(topicKey)
    const status = topic.moderation?.status || 'pending'

    return (
      <Box
        key={topicKey}
        sx={{
          border: '1px solid',
          borderColor: 'border',
          borderRadius: 'default',
          p: 3,
          mb: 2,
          bg: 'background'
        }}>
        <Flex sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ flex: 1 }}>
            <Flex sx={{ alignItems: 'center', mb: 2 }}>
              <Button
                variant="outline"
                size="small"
                onClick={() => this.toggleTopic(topicKey)}
                sx={{ mr: 2, p: 1, fontSize: 0 }}>
                {isExpanded ? '−' : '+'}
              </Button>
              <Text sx={{ fontWeight: 'bold', color: this.getStatusColor(status) }}>
                Layer {layerId}, Cluster {clusterId}
              </Text>
              <Text sx={{ ml: 2, fontSize: 0, color: 'textSecondary' }}>Status: {status}</Text>
            </Flex>
            <Text sx={{ mb: 2 }}>{topic.topic_name || 'Unnamed Topic'}</Text>
            {topic.moderation?.comment_count && (
              <Text sx={{ fontSize: 0, color: 'textSecondary' }}>
                {topic.moderation.comment_count} comments
              </Text>
            )}
          </Box>

          <Flex sx={{ gap: 2 }}>
            <Button
              variant="success"
              size="small"
              onClick={() => this.moderateTopic(topicKey, 'accept')}
              disabled={status === 'accepted'}>
              Accept
            </Button>
            <Button
              variant="danger"
              size="small"
              onClick={() => this.moderateTopic(topicKey, 'reject')}
              disabled={status === 'rejected'}>
              Reject
            </Button>
            <Button
              variant="warning"
              size="small"
              onClick={() => this.moderateTopic(topicKey, 'meta')}
              disabled={status === 'meta'}>
              Meta
            </Button>
            <Link to={`${match.url}/topic/${encodeURIComponent(topicKey)}`}>
              <Button variant="outline" size="small">
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

  renderLayer(layerId, topics) {
    const layerTopics = Object.entries(topics).sort(([a], [b]) => parseInt(a) - parseInt(b))

    return (
      <Box key={layerId} sx={{ mb: 4 }}>
        <Heading as="h4" sx={{ mb: 3, fontSize: 2 }}>
          Layer {layerId} ({layerTopics.length} topics)
        </Heading>
        {layerTopics.map(([clusterId, topic]) => this.renderTopic(topic, layerId, clusterId))}
      </Box>
    )
  }

  render() {
    const { loading, error, topicsData, selectedLayer } = this.state

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
          <Button sx={{ mt: 2 }} onClick={() => this.loadTopics()}>
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
            Topics are generated by the Delphi pipeline. Make sure the pipeline has been run for
            this conversation.
          </Text>
        </Box>
      )
    }

    const layers = Object.entries(topicsData).sort(([a], [b]) => parseInt(a) - parseInt(b))

    return (
      <Box>
        <Flex sx={{ mb: 4, gap: 2 }}>
          <Text sx={{ fontWeight: 'bold' }}>View Layer:</Text>
          {layers.map(([layerId]) => (
            <Button
              key={layerId}
              variant={selectedLayer === layerId ? 'primary' : 'outline'}
              size="small"
              onClick={() => this.setState({ selectedLayer: layerId })}>
              Layer {layerId}
            </Button>
          ))}
          <Button
            variant={selectedLayer === 'all' ? 'primary' : 'outline'}
            size="small"
            onClick={() => this.setState({ selectedLayer: 'all' })}>
            All Layers
          </Button>
        </Flex>

        {selectedLayer === 'all'
          ? layers.map(([layerId, topics]) => this.renderLayer(layerId, topics))
          : topicsData[selectedLayer] && this.renderLayer(selectedLayer, topicsData[selectedLayer])}
      </Box>
    )
  }
}

export default TopicTree
