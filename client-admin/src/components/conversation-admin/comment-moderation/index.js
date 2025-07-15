// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import ComponentHelpers from '../../../util/component-helpers'
import { withAuth0 } from '@auth0/auth0-react'

import NoPermission from '../no-permission'
import React from 'react'
import { connect } from 'react-redux'
import { populateAllCommentStores } from '../../../actions'
import { Heading, Flex, Box, jsx } from 'theme-ui'

import ModerateCommentsTodo from './moderate-comments-todo'
import ModerateCommentsAccepted from './moderate-comments-accepted'
import ModerateCommentsRejected from './moderate-comments-rejected'

import { Routes, Route, Link, useParams, useLocation } from 'react-router'

const mapStateToProps = (state, ownProps) => {
  return {
    unmoderated: state.mod_comments_unmoderated,
    accepted: state.mod_comments_accepted,
    rejected: state.mod_comments_rejected,
    seed: state.seed_comments
  }
}

const pollFrequency = 60000

@connect((state) => state.zid_metadata)
@connect(mapStateToProps)
class CommentModeration extends React.Component {
  loadComments() {
    const { params } = this.props
    this.props.dispatch(populateAllCommentStores(params.conversation_id))
  }

  componentDidMount() {
    // Try to load comments when component mounts and set up polling
    this.loadCommentsIfNeeded()
  }

  componentDidUpdate(prevProps) {
    // Try again if conversation_id changes or auth state changes
    const authStateChanged =
      prevProps.auth0?.isLoading !== this.props.auth0?.isLoading ||
      prevProps.auth0?.isAuthenticated !== this.props.auth0?.isAuthenticated

    if (
      prevProps.params.conversation_id !== this.props.params.conversation_id ||
      authStateChanged
    ) {
      this.loadCommentsIfNeeded()
    }
  }

  loadCommentsIfNeeded() {
    // Only load if we have a conversation ID and Auth0 is ready (not loading)
    if (this.props.params.conversation_id && this.props.auth0 && !this.props.auth0.isLoading) {
      this.loadComments()

      // Set up polling if not already set up
      if (!this.getCommentsRepeatedly) {
        this.getCommentsRepeatedly = setInterval(() => {
          this.loadComments()
        }, pollFrequency)
      }
    }
  }

  componentWillUnmount() {
    clearInterval(this.getCommentsRepeatedly)
  }

  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />
    }
    const { location } = this.props

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
            {Array.isArray(this.props.unmoderated.unmoderated_comments)
              ? this.props.unmoderated.unmoderated_comments.length
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
            {Array.isArray(this.props.accepted.accepted_comments)
              ? this.props.accepted.accepted_comments.length
              : null}
          </Link>
          <Link
            data-testid="filter-rejected"
            sx={{
              mr: [4],
              variant: url === 'rejected' ? 'links.activeNav' : 'links.nav'
            }}
            to="rejected">
            Rejected{' '}
            {Array.isArray(this.props.rejected.rejected_comments)
              ? this.props.rejected.rejected_comments.length
              : null}
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
}

function CommentModerationWrapper(props) {
  const params = useParams()
  const location = useLocation()
  return <CommentModeration {...props} params={params} location={location} />
}

export default withAuth0(CommentModerationWrapper)
