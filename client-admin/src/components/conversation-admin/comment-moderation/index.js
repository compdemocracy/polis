// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Flex, Box } from 'theme-ui'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'
import { useAuth } from 'react-oidc-context'
import { useEffect, useRef, useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'

import { populateAllCommentStores } from '../../../actions'
import ModerateCommentsAccepted from './ModerateCommentsAccepted'
import ModerateCommentsRejected from './ModerateCommentsRejected'
import ModerateCommentsTodo from './ModerateCommentsTodo'

const pollFrequency = 60000

const CommentModeration = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const location = useLocation()
  const { isLoading, isAuthenticated } = useAuth()
  const unmoderated = useSelector((state) => state.mod_comments_unmoderated)
  const accepted = useSelector((state) => state.mod_comments_accepted)
  const rejected = useSelector((state) => state.mod_comments_rejected)
  const getCommentsRepeatedlyRef = useRef(null)

  // Pagination state
  const [pageSize] = useState(50) // Default page size
  const [currentPage, setCurrentPage] = useState(0) // 0-based page index

  const loadComments = (page = currentPage) => {
    const offset = page * pageSize
    dispatch(populateAllCommentStores(params.conversation_id, pageSize, offset))
  }

  const handlePageChange = (newOffset, limit) => {
    const newPage = Math.floor(newOffset / limit)
    setCurrentPage(newPage)
    loadComments(newPage)
  }

  useEffect(() => {
    // Only load if we have a conversation ID, Auth is ready (not loading), and user is authenticated
    if (params.conversation_id && !isLoading && isAuthenticated) {
      loadComments()

      // Set up polling if not already set up
      if (!getCommentsRepeatedlyRef.current) {
        getCommentsRepeatedlyRef.current = setInterval(() => {
          loadComments()
        }, pollFrequency)
      }
    }

    return () => {
      if (getCommentsRepeatedlyRef.current) {
        clearInterval(getCommentsRepeatedlyRef.current)
        getCommentsRepeatedlyRef.current = null
      }
    }
  }, [params.conversation_id, isLoading, isAuthenticated])

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
          to="../comments">
          Unmoderated{' '}
          {unmoderated.pagination?.total !== undefined
            ? unmoderated.pagination.total
            : Array.isArray(unmoderated.unmoderated_comments)
              ? unmoderated.unmoderated_comments.length
              : null}
        </Link>
        <Link
          data-testid="filter-approved"
          sx={{
            mr: [4],
            variant: url === 'accepted' ? 'links.activeNav' : 'links.nav'
          }}
          to="../comments/accepted">
          Accepted{' '}
          {accepted.pagination?.total !== undefined
            ? accepted.pagination.total
            : Array.isArray(accepted.accepted_comments)
              ? accepted.accepted_comments.length
              : null}
        </Link>
        <Link
          data-testid="filter-rejected"
          sx={{
            mr: [4],
            variant: url === 'rejected' ? 'links.activeNav' : 'links.nav'
          }}
          to="../comments/rejected">
          Rejected{' '}
          {rejected.pagination?.total !== undefined
            ? rejected.pagination.total
            : Array.isArray(rejected.rejected_comments)
              ? rejected.rejected_comments.length
              : null}
        </Link>
      </Flex>
      <Box>
        <Routes>
          <Route
            path="/"
            element={
              <ModerateCommentsTodo
                pagination={unmoderated.pagination}
                onPageChange={handlePageChange}
                loading={unmoderated.loading}
              />
            }
          />
          <Route
            path="accepted"
            element={
              <ModerateCommentsAccepted
                pagination={accepted.pagination}
                onPageChange={handlePageChange}
                loading={accepted.loading}
              />
            }
          />
          <Route
            path="rejected"
            element={
              <ModerateCommentsRejected
                pagination={rejected.pagination}
                onPageChange={handlePageChange}
                loading={rejected.loading}
              />
            }
          />
        </Routes>
      </Box>
    </Box>
  )
}

export default CommentModeration
