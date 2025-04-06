// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import {
  changeCommentStatusToRejected,
  changeCommentCommentIsMeta
} from '../../../actions'
import withAuth0 from '../../../util/withAuth0'
import Comment from './comment'

@connect((state) => state.mod_comments_accepted)
class ModerateCommentsAccepted extends React.Component {
  async onCommentRejected(comment) {
    let token
    if (process.env.USE_AUTH_PROVIDER) {
      token = await this.props.getAccessTokenSilently()
      this.props.dispatch(changeCommentStatusToRejected(comment, token))
    } else {
      this.props.dispatch(changeCommentStatusToRejected(comment))
    }
  }

  async toggleIsMetaHandler(comment, is_meta) {
    let token
    if (process.env.USE_AUTH_PROVIDER) {
      token = await this.props.getAccessTokenSilently()
      this.props.dispatch(changeCommentCommentIsMeta(comment, is_meta, token))
    } else {
      this.props.dispatch(changeCommentStatusToRejected(comment))
    }
  }

  createCommentMarkup() {
    const comments = this.props.accepted_comments.map((comment, i) => {
      return (
        <Comment
          key={i}
          rejectButton
          rejectClickHandler={this.onCommentRejected.bind(this)}
          rejectButtonText="reject"
          isMetaCheckbox
          toggleIsMetaHandler={this.toggleIsMetaHandler.bind(this)}
          comment={comment}
        />
      )
    })
    return comments
  }

  render() {
    return (
      <div data-test-id="approved-comments">
        {this.props.accepted_comments !== null
          ? this.createCommentMarkup()
          : 'Loading accepted comments...'}
      </div>
    )
  }
}

ModerateCommentsAccepted.propTypes = {
  dispatch: PropTypes.func,
  accepted_comments: PropTypes.arrayOf(PropTypes.object)
}

export default withAuth0(ModerateCommentsAccepted)
