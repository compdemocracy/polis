// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import Flex from '../framework/flex'
import React from 'react'
import strings from '../../strings/strings'
import { connect } from 'react-redux'
import {
  populateAllCommentStores,
  changeCommentStatusToRejected
} from '../../actions'

@connect(state => state.mod_comments_accepted)
@connect(state => state.mod_comments_rejected)
@connect(state => state.mod_comments_unmoderated)
class ConversationHasCommentsCheck extends React.Component {
  componentWillMount() {
    this.props.dispatch(populateAllCommentStores(this.props.conversation_id))
  }

  createCommentMarkup() {
    const numAccepted = this.props.accepted_comments.length
    const numRejected = this.props.rejected_comments.length
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
    return (
      <div>
        {this.props.accepted_comments > 0 &&
        this.props.rejected_comments > 0 ? (
          this.createCommentMarkup()
        ) : (
          <span> Loading accepted comments... </span>
        )}
      </div>
    )
  }
}

ConversationHasCommentsCheck.defaultProps = {
  accepted_comments: [],
  rejected_comments: [],
  unmoderated_comments: []
}

export default ConversationHasCommentsCheck
