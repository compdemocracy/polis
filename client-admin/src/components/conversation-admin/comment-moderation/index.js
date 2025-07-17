// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import ComponentHelpers from '../../../util/component-helpers'
import { useAuth } from 'react-oidc-context'

import NoPermission from '../no-permission'
import { useEffect, useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { populateAllCommentStores } from '../../../actions'
import { Heading, Flex, Box } from 'theme-ui'

import ModerateCommentsTodo from './moderate-comments-todo'
import ModerateCommentsAccepted from './moderate-comments-accepted'
import ModerateCommentsRejected from './moderate-comments-rejected'

import { Routes, Route, Link, useParams, useLocation } from 'react-router'

const pollFrequency = 60000

const CommentModeration = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const location = useLocation()
  const { isLoading, isAuthenticated } = useAuth()

  const zid_metadata = useSelector((state) => state.zid_metadata)
  const unmoderated = useSelector((state) => state.mod_comments_unmoderated)
  const accepted = useSelector((state) => state.mod_comments_accepted)
  const rejected = useSelector((state) => state.mod_comments_rejected)

  const getCommentsRepeatedlyRef = useRef(null)

  const loadComments = () => {
    dispatch(populateAllCommentStores(params.conversation_id))
  }

  const loadCommentsIfNeeded = () => {
    // Only load if we have a conversation ID and Auth is ready (not loading)
    if (params.conversation_id && !isLoading) {
      loadComments()

      // Set up polling if not already set up
      if (!getCommentsRepeatedlyRef.current) {
        getCommentsRepeatedlyRef.current = setInterval(() => {
          loadComments()
        }, pollFrequency)
      }
    }
  }

  useEffect(() => {
    // Try to load comments when component mounts and set up polling
    loadCommentsIfNeeded()

    return () => {
      if (getCommentsRepeatedlyRef.current) {
        clearInterval(getCommentsRepeatedlyRef.current)
        getCommentsRepeatedlyRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    // Try again if conversation_id changes or auth state changes
    loadCommentsIfNeeded()
  }, [params.conversation_id, isLoading, isAuthenticated])

  if (
    ComponentHelpers.shouldShowPermissionsError({
      zid_metadata: zid_metadata.zid_metadata,
      loading: zid_metadata.loading
    })
  ) {
    return <NoPermission />
  }

  const url = location.pathname.split('/')[4]

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Moderate
      </Heading>
      <Flex sx={{ mb: [4] }}>
        <Link
          data-testid="mod-queue"
          sx={{
            mr: [4],
            variant: url ? 'links.nav' : 'links.activeNav'
          }}
          to=".">
          Unmoderated{' '}
          {Array.isArray(unmoderated.unmoderated_comments)
            ? unmoderated.unmoderated_comments.length
            : null}
        </Link>
        <Link
          data-testid="filter-approved"
          sx={{
            mr: [4],
            variant: url === 'accepted' ? 'links.activeNav' : 'links.nav'
          }}
          to="accepted">
          Accepted{' '}
          {Array.isArray(accepted.accepted_comments) ? accepted.accepted_comments.length : null}
        </Link>
        <Link
          data-testid="filter-rejected"
          sx={{
            mr: [4],
            variant: url === 'rejected' ? 'links.activeNav' : 'links.nav'
          }}
          to="rejected">
          Rejected{' '}
          {Array.isArray(rejected.rejected_comments) ? rejected.rejected_comments.length : null}
        </Link>
      </Flex>
      <Box>
        <Routes>
          <Route path="/" element={<ModerateCommentsTodo />} />
          <Route path="accepted" element={<ModerateCommentsAccepted />} />
          <Route path="rejected" element={<ModerateCommentsRejected />} />
        </Routes>
      </Box>
    </Box>
  )
}

export default CommentModeration
