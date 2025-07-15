// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useSelector, useDispatch } from 'react-redux'
import { changeCommentStatusToRejected, changeCommentCommentIsMeta } from '../../../actions'
import Comment from './comment'

const ModerateCommentsAccepted = () => {
  const dispatch = useDispatch()
  const { accepted_comments } = useSelector((state) => state.mod_comments_accepted)

  const onCommentRejected = (comment) => {
    dispatch(changeCommentStatusToRejected(comment))
  }

  const toggleIsMetaHandler = (comment, is_meta) => {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  const createCommentMarkup = () => {
    // Add safety check to ensure accepted_comments is an array
    if (!Array.isArray(accepted_comments)) {
      return null
    }

    const comments = accepted_comments.map((comment, i) => {
      return (
        <Comment
          key={i}
          rejectButton
          rejectClickHandler={onCommentRejected}
          rejectButtonText="reject"
          isMetaCheckbox
          toggleIsMetaHandler={toggleIsMetaHandler}
          comment={comment}
        />
      )
    })
    return comments
  }

  return (
    <div data-testid="approved-comments">
      {accepted_comments !== null && Array.isArray(accepted_comments)
        ? createCommentMarkup()
        : 'Loading accepted comments...'}
    </div>
  )
}

export default ModerateCommentsAccepted
