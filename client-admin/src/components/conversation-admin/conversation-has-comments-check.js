// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import strings from '../../strings/strings'
import { connect } from 'react-redux'
import { populateAllCommentStores } from '../../actions'

@connect((state) => state.mod_comments_accepted)
@connect((state) => state.mod_comments_rejected)
@connect((state) => state.mod_comments_unmoderated)
class ConversationHasCommentsCheck extends React.Component {
  componentDidMount() {
    this.props.dispatch(populateAllCommentStores(this.props.conversation_id))
  }

  createCommentMarkup() {
    const numAccepted = this.props.accepted_comments.length
    const numUnmoderated = this.props.unmoderated_comments.length

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
    return (
      <div>
        {accepted_comments !== null &&
        rejected_comments !== null &&
        unmoderated_comments !== null ? (
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
  unmoderated_comments: PropTypes.arrayOf(PropTypes.object),
  accepted_comments: PropTypes.arrayOf(PropTypes.object),
  rejected_comments: PropTypes.arrayOf(PropTypes.object)
}

export default ConversationHasCommentsCheck
