/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState, useEffect } from 'react'
import { Box, Flex, Heading, Text, Button, Checkbox, Label } from 'theme-ui'
import { Link, useParams } from 'react-router-dom'

const TopicDetail = () => {
  const [comments, setComments] = useState([])
  const [selectedComments, setSelectedComments] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectAll, setSelectAll] = useState(false)
  const params = useParams()
  const { conversation_id, topicKey: encodedTopicKey } = params
  const topicKey = decodeURIComponent(encodedTopicKey)

  const loadTopicComments = async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await fetch(
        `/api/v3/topicMod/topics/${encodeURIComponent(
          topicKey
        )}/comments?conversation_id=${conversation_id}`
      )
      const data = await response.json()

      if (data.status === 'success') {
        setComments(data.comments || [])
        setSelectedComments(new Set())
      } else {
        setError(data.message || 'Failed to load comments')
      }
    } catch (err) {
      setError('Network error loading comments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTopicComments()
  }, [conversation_id, topicKey])

  const toggleComment = (commentId) => {
    const newSelected = new Set(selectedComments)
    if (newSelected.has(commentId)) {
      newSelected.delete(commentId)
    } else {
      newSelected.add(commentId)
    }
    setSelectedComments(newSelected)
    setSelectAll(newSelected.size === comments.length)
  }

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelectedComments(new Set())
      setSelectAll(false)
    } else {
      setSelectedComments(new Set(comments.map((c) => c.comment_id)))
      setSelectAll(true)
    }
  }

  const moderateSelected = async (action) => {
    if (selectedComments.size === 0) return

    try {
      const response = await fetch('/api/v3/topicMod/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: conversation_id,
          comment_ids: Array.from(selectedComments),
          action: action,
          moderator: 'admin' // TODO: Get from auth state
        })
      })
      const data = await response.json()
      if (data.status === 'success') {
        loadTopicComments()
      } else {
        console.error('Moderation failed:', data.message)
      }
    } catch (err) {
      console.error('Network error during moderation:', err)
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'accepted':
      case 1:
        return 'primary'
      case 'rejected':
      case -1:
        return 'error'
      case 'meta':
      case 0:
        return 'lightGray'
      default:
        return 'gray'
    }
  }

  const getStatusText = (status) => {
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

  const renderComment = (comment) => {
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
        onClick={() => toggleComment(comment.comment_id)}>
        <Flex sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Flex sx={{ alignItems: 'flex-start', flex: 1 }}>
            <Checkbox
              checked={isSelected}
              onChange={() => toggleComment(comment.comment_id)}
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
                color: getStatusColor(status)
              }}>
              {getStatusText(status)}
            </Text>
          </Box>
        </Flex>
      </Box>
    )
  }

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
        <Button sx={{ mt: 2 }} onClick={loadTopicComments}>
          Retry
        </Button>
      </Box>
    )
  }

  return (
    <Box>
      <Flex sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 4 }}>
        <Box>
          <Link to={`/m/${conversation_id}/topics`}>
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
                <Checkbox checked={selectAll} onChange={toggleSelectAll} sx={{ mr: 2 }} />
                Select All ({selectedComments.size} selected)
              </Label>
            </Flex>
            <Flex sx={{ gap: 2 }}>
              <Button
                variant="primary"
                size="small"
                onClick={() => moderateSelected('accept')}
                disabled={selectedComments.size === 0}>
                Accept Selected
              </Button>
              <Button
                variant="danger"
                size="small"
                onClick={() => moderateSelected('reject')}
                disabled={selectedComments.size === 0}>
                Reject Selected
              </Button>
            </Flex>
          </Flex>
          <Box>{comments.map(renderComment)}</Box>
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

export default TopicDetail
