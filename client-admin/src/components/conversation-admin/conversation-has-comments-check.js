// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import strings from '../../strings/strings'
import { useSelector, useDispatch } from 'react-redux'
import { populateAllCommentStores } from '../../actions'
import { useAuth } from 'react-oidc-context'

const ConversationHasCommentsCheck = ({ conversation_id, strict_moderation, loading }) => {
  const dispatch = useDispatch()
  const { isLoading, isAuthenticated } = useAuth()

  const accepted_comments = useSelector((state) => state.mod_comments_accepted.accepted_comments)
  const rejected_comments = useSelector((state) => state.mod_comments_rejected.rejected_comments)
  const unmoderated_comments = useSelector(
    (state) => state.mod_comments_unmoderated.unmoderated_comments
  )

  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false)

  const loadComments = () => {
    dispatch(populateAllCommentStores(conversation_id))
  }

  const loadCommentsIfNeeded = () => {
    // Only load if we have a conversation ID and Auth is ready (not loading)
    if (!hasAttemptedLoad && conversation_id && !isLoading) {
      setHasAttemptedLoad(true)
      loadComments()
    }
  }

  useEffect(() => {
    // Try to load comments when component mounts
    loadCommentsIfNeeded()
  }, [])

  useEffect(() => {
    // Try again if conversation_id changes, auth state changes, or if we haven't attempted load yet
    if (!hasAttemptedLoad) {
      loadCommentsIfNeeded()
    }
  }, [conversation_id, isLoading, isAuthenticated, hasAttemptedLoad])

  // Reset hasAttemptedLoad when conversation_id changes
  useEffect(() => {
    setHasAttemptedLoad(false)
  }, [conversation_id])

  const createCommentMarkup = () => {
    const numAccepted = Array.isArray(accepted_comments) ? accepted_comments.length : 0
    const numUnmoderated = Array.isArray(unmoderated_comments) ? unmoderated_comments.length : 0

    const isStrictMod = strict_moderation
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

  // Check if any store is still loading or if Auth is still loading
  const isLoadingState = loading || isLoading || (!hasAttemptedLoad && !conversation_id)

  // Show loading if we haven't attempted to load yet OR if comments are still null and we're loading
  const shouldShowLoading =
    isLoadingState ||
    accepted_comments === null ||
    rejected_comments === null ||
    unmoderated_comments === null

  return (
    <div>
      {!shouldShowLoading ? createCommentMarkup() : <span> Loading accepted comments... </span>}
    </div>
  )
}

ConversationHasCommentsCheck.propTypes = {
  conversation_id: PropTypes.string,
  strict_moderation: PropTypes.bool,
  loading: PropTypes.bool
}

export default ConversationHasCommentsCheck
