// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useSelector, useDispatch } from 'react-redux'
import {
  changeCommentStatusToAccepted,
  changeCommentStatusToRejected,
  changeCommentCommentIsMeta
} from '../../../actions'
import Comment from './comment'

const ModerateCommentsTodo = () => {
  const dispatch = useDispatch()
  const { unmoderated_comments } = useSelector((state) => state.mod_comments_unmoderated)

  const onCommentAccepted = (comment) => {
    dispatch(changeCommentStatusToAccepted(comment))
  }

  const onCommentRejected = (comment) => {
    dispatch(changeCommentStatusToRejected(comment))
  }

  const toggleIsMetaHandler = (comment, is_meta) => {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  const createCommentMarkup = (max) => {
    // Add safety check to ensure unmoderated_comments is an array
    if (!Array.isArray(unmoderated_comments)) {
      return null
    }

    return unmoderated_comments.slice(0, max).map((comment, i) => {
      return (
        <Comment
          key={i}
          acceptButton
          rejectButton
          acceptClickHandler={onCommentAccepted}
          rejectClickHandler={onCommentRejected}
          acceptButtonText="accept"
          rejectButtonText="reject"
          isMetaCheckbox
          toggleIsMetaHandler={toggleIsMetaHandler}
          comment={comment}
        />
      )
    })
  }

  const max = 100
  return (
    <div data-testid="pending-comment">
      <div>
        <p> Displays maximum {max} comments </p>
        {unmoderated_comments !== null && Array.isArray(unmoderated_comments)
          ? createCommentMarkup(max)
          : 'Loading unmoderated comments...'}
      </div>
    </div>
  )
}

export default ModerateCommentsTodo
