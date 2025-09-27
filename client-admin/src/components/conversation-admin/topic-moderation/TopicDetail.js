/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { connect } from 'react-redux'
import { jsx, Box, Flex, Heading, Text, Button, Checkbox, Label } from 'theme-ui'
import { Link } from 'react-router-dom'

const mapStateToProps = (state) => {
  return {
    zid_metadata: state.zid_metadata
  }
}

@connect(mapStateToProps)
class TopicDetail extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      comments: [],
      selectedComments: new Set(),
      loading: true,
      error: null,
      topicInfo: null,
      selectAll: false
    }
  }

  componentDidMount() {
    this.loadTopicComments()
  }

  componentDidUpdate(prevProps) {
    if (prevProps.match.params.topicKey !== this.props.match.params.topicKey) {
      this.loadTopicComments()
    }
  }

  async loadTopicComments() {
    try {
      this.setState({ loading: true, error: null })
      const { match } = this.props
      const conversation_id = match.params.conversation_id
      const topicKey = decodeURIComponent(match.params.topicKey)

      // Fetch comments for this specific topic
      const response = await fetch(
        `/api/v3/topicMod/topics/${encodeURIComponent(topicKey)}/comments?report_id=${conversation_id}`
      )
      const data = await response.json()

      if (data.status === 'success') {
        this.setState({
          comments: data.comments || [],
          loading: false,
          selectedComments: new Set()
        })
      } else {
        this.setState({
          error: data.message || 'Failed to load comments',
          loading: false
        })
      }
    } catch (err) {
      this.setState({
        error: 'Network error loading comments',
        loading: false
      })
    }
  }

  toggleComment(commentId) {
    const { selectedComments } = this.state
    const newSelected = new Set(selectedComments)

    if (newSelected.has(commentId)) {
      newSelected.delete(commentId)
    } else {
      newSelected.add(commentId)
    }

    this.setState({
      selectedComments: newSelected,
      selectAll: newSelected.size === this.state.comments.length
    })
  }

  toggleSelectAll() {
    const { selectAll, comments } = this.state

    if (selectAll) {
      this.setState({
        selectedComments: new Set(),
        selectAll: false
      })
    } else {
      this.setState({
        selectedComments: new Set(comments.map((c) => c.comment_id)),
        selectAll: true
      })
    }
  }

  async moderateSelected(action) {
    const { selectedComments } = this.state

    if (selectedComments.size === 0) {
      return
    }

    try {
      const { match } = this.props
      const conversation_id = match.params.conversation_id

      const response = await fetch('/api/v3/topicMod/moderate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          report_id: conversation_id,
          comment_ids: Array.from(selectedComments),
          action: action,
          moderator: 'admin' // TODO: Get from auth state
        })
      })

      const data = await response.json()

      if (data.status === 'success') {
        // Reload comments to reflect changes
        this.loadTopicComments()
      } else {
        console.error('Moderation failed:', data.message)
      }
    } catch (err) {
      console.error('Network error during moderation:', err)
    }
  }

  getStatusColor(status) {
    switch (status) {
      case 'accepted':
      case 1:
        return 'green'
      case 'rejected':
      case -1:
        return 'red'
      case 'meta':
      case 0:
        return 'orange'
      default:
        return 'gray'
    }
  }

  getStatusText(status) {
    switch (status) {
      case 'accepted':
      case 1:
        return 'Accepted'
      case 'rejected':
      case -1:
        return 'Rejected'
      case 'meta':
      case 0:
        return 'Meta'
      default:
        return 'Pending'
    }
  }

  renderComment(comment) {
    const { selectedComments } = this.state
    const isSelected = selectedComments.has(comment.comment_id)
    const status = comment.moderation_status || 'pending'

    return (
      <Box
        key={comment.comment_id}
        sx={{
          border: '1px solid',
          borderColor: isSelected ? 'primary' : 'border',
          borderRadius: 'default',
          p: 3,
          mb: 2,
          bg: isSelected ? 'highlight' : 'background',
          cursor: 'pointer'
        }}
        onClick={() => this.toggleComment(comment.comment_id)}>
        <Flex sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Flex sx={{ alignItems: 'flex-start', flex: 1 }}>
            <Checkbox
              checked={isSelected}
              onChange={() => this.toggleComment(comment.comment_id)}
              sx={{ mr: 3, mt: 1 }}
              onClick={(e) => e.stopPropagation()}
            />
            <Box sx={{ flex: 1 }}>
              <Text sx={{ mb: 2, lineHeight: 'body' }}>{comment.comment_text}</Text>
              <Flex sx={{ gap: 3, fontSize: 0, color: 'textSecondary' }}>
                <Text>ID: {comment.comment_id}</Text>
                <Text>Cluster: {comment.cluster_id}</Text>
                <Text>Layer: {comment.layer_id}</Text>
                {comment.umap_x !== undefined && comment.umap_y !== undefined && (
                  <Text>
                    Position: ({comment.umap_x?.toFixed(2)}, {comment.umap_y?.toFixed(2)})
                  </Text>
                )}
              </Flex>
            </Box>
          </Flex>

          <Box sx={{ textAlign: 'right' }}>
            <Text
              sx={{
                fontSize: 0,
                fontWeight: 'bold',
                color: this.getStatusColor(status)
              }}>
              {this.getStatusText(status)}
            </Text>
          </Box>
        </Flex>
      </Box>
    )
  }

  render() {
    const { match } = this.props
    const { loading, error, comments, selectedComments, selectAll } = this.state
    const topicKey = decodeURIComponent(match.params.topicKey)

    if (loading) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text>Loading comments...</Text>
        </Box>
      )
    }

    if (error) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text sx={{ color: 'error' }}>Error: {error}</Text>
          <Button sx={{ mt: 2 }} onClick={() => this.loadTopicComments()}>
            Retry
          </Button>
        </Box>
      )
    }

    return (
      <Box>
        <Flex sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 4 }}>
          <Box>
            <Link to={match.url.replace('/topic/' + encodeURIComponent(topicKey), '')}>
              <Button variant="outline" size="small" sx={{ mr: 3 }}>
                ← Back to Topics
              </Button>
            </Link>
            <Heading as="h3" sx={{ display: 'inline' }}>
              Topic: {topicKey}
            </Heading>
          </Box>
          <Text sx={{ color: 'textSecondary' }}>{comments.length} comments</Text>
        </Flex>

        {comments.length > 0 && (
          <>
            <Flex
              sx={{
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 4,
                p: 3,
                bg: 'muted',
                borderRadius: 'default'
              }}>
              <Flex sx={{ alignItems: 'center' }}>
                <Label sx={{ display: 'flex', alignItems: 'center', mr: 4 }}>
                  <Checkbox
                    checked={selectAll}
                    onChange={() => this.toggleSelectAll()}
                    sx={{ mr: 2 }}
                  />
                  Select All ({selectedComments.size} selected)
                </Label>
              </Flex>

              <Flex sx={{ gap: 2 }}>
                <Button
                  variant="success"
                  size="small"
                  onClick={() => this.moderateSelected('accept')}
                  disabled={selectedComments.size === 0}>
                  Accept Selected
                </Button>
                <Button
                  variant="danger"
                  size="small"
                  onClick={() => this.moderateSelected('reject')}
                  disabled={selectedComments.size === 0}>
                  Reject Selected
                </Button>
                <Button
                  variant="warning"
                  size="small"
                  onClick={() => this.moderateSelected('meta')}
                  disabled={selectedComments.size === 0}>
                  Mark as Meta
                </Button>
              </Flex>
            </Flex>

            <Box>{comments.map((comment) => this.renderComment(comment))}</Box>
          </>
        )}

        {comments.length === 0 && (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Text>No comments found for this topic.</Text>
          </Box>
        )}
      </Box>
    )
  }
}

export default TopicDetail
