// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import strings from '../../strings/strings'
import { connect } from 'react-redux'
import { populateAllCommentStores } from '../../actions'
import withAuth0Ready from '../../util/with-auth0-ready'

@connect((state) => state.mod_comments_accepted)
@connect((state) => state.mod_comments_rejected)
@connect((state) => state.mod_comments_unmoderated)
class ConversationHasCommentsCheck extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      hasAttemptedLoad: false
    }
  }

  componentDidMount() {
    // Always try to load comments on mount, regardless of Auth0 state
    this.loadCommentsIfNeeded()
  }

  componentDidUpdate(prevProps) {
    // Try again if conversation_id changes or if we haven't attempted load yet
    if (prevProps.conversation_id !== this.props.conversation_id || !this.state.hasAttemptedLoad) {
      this.loadCommentsIfNeeded()
    }
  }

  loadCommentsIfNeeded() {
    if (!this.state.hasAttemptedLoad && this.props.conversation_id) {
      this.setState({ hasAttemptedLoad: true })
      this.loadComments()
    }
  }

  loadComments() {
    this.props.dispatch(populateAllCommentStores(this.props.conversation_id))
  }

  createCommentMarkup() {
    const numAccepted = this.props.accepted_comments?.length || 0
    const numUnmoderated = this.props.unmoderated_comments?.length || 0

    const isStrictMod = this.props.strict_moderation
    const numVisible = numAccepted + (isStrictMod ? 0 : numUnmoderated)

    let s = ''
    if (numVisible === 0) {
      if (isStrictMod && numUnmoderated > 0) {
        s = strings('share_but_no_visible_comments_warning')
      } else {
        s = strings('share_but_no_comments_warning')
      }
      return <div>{s}</div>
    } else {
      return null
    }
  }

  render() {
    const {
      accepted_comments,
      rejected_comments,
      unmoderated_comments
    } = this.props

    // Check if any store is still loading
    const isLoading = this.props.loading || 
                     (!this.state.hasAttemptedLoad && !this.props.conversation_id)

    // Show loading if we haven't attempted to load yet OR if comments are still null and we're loading
    const shouldShowLoading = isLoading || 
                             (accepted_comments === null || 
                              rejected_comments === null || 
                              unmoderated_comments === null)

    return (
      <div>
        {!shouldShowLoading ? (
          this.createCommentMarkup()
        ) : (
          <span> Loading accepted comments... </span>
        )}
      </div>
    )
  }
}

ConversationHasCommentsCheck.propTypes = {
  dispatch: PropTypes.func,
  conversation_id: PropTypes.string,
  strict_moderation: PropTypes.bool,
  loading: PropTypes.bool,
  unmoderated_comments: PropTypes.arrayOf(PropTypes.object),
  accepted_comments: PropTypes.arrayOf(PropTypes.object),
  rejected_comments: PropTypes.arrayOf(PropTypes.object)
}

export default withAuth0Ready(ConversationHasCommentsCheck, function(props) {
  // The callback that gets called when Auth0 is ready
  // But we also try loading in componentDidMount as a fallback
  this.loadComments();
});
