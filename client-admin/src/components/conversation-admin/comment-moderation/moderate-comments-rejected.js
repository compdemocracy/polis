// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { changeCommentStatusToAccepted, changeCommentCommentIsMeta } from '../../../actions'
import { useSelector, useDispatch } from 'react-redux'
import Comment from './comment'

const ModerateCommentsRejected = () => {
  const dispatch = useDispatch()
  const { rejected_comments } = useSelector((state) => state.mod_comments_rejected)

  const onCommentAccepted = (comment) => {
    dispatch(changeCommentStatusToAccepted(comment))
  }

  const toggleIsMetaHandler = (comment, is_meta) => {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  const createCommentMarkup = () => {
    // Add safety check to ensure rejected_comments is an array
    if (!Array.isArray(rejected_comments)) {
      return null
    }

    const comments = rejected_comments.map((comment, i) => {
      return (
        <Comment
          key={i}
          acceptButton
          acceptButtonText="accept"
          acceptClickHandler={onCommentAccepted}
          isMetaCheckbox
          toggleIsMetaHandler={toggleIsMetaHandler}
          comment={comment}
        />
      )
    })
    return comments
  }

  return (
    <div data-testid="rejected-comments">
      {rejected_comments !== null && Array.isArray(rejected_comments)
        ? createCommentMarkup()
        : 'Loading rejected comments...'}
    </div>
  )
}

export default ModerateCommentsRejected
