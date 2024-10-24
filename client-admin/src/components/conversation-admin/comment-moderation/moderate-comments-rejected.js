// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import {
  changeCommentStatusToAccepted,
  changeCommentCommentIsMeta
} from '../../../actions'
import { connect } from 'react-redux'
import Comment from './comment'

function ModerateCommentsRejected({ dispatch, rejected_comments = [] }) {
  const [currentItem, setCurrentItem] = useState(0)
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.code === 'KeyA') {
        onCommentAccepted(rejected_comments[currentItem])
      }
      if (e.code === 'KeyW') {
        setCurrentItem(Math.max(0, currentItem - 1))
      }
      if (rejected_comments && e.code === 'KeyS') {
        setCurrentItem(Math.min(rejected_comments.length - 1, currentItem + 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentItem, rejected_comments]);

  useEffect(() => {
    if (rejected_comments && currentItem > rejected_comments.length - 1) {
      setCurrentItem(Math.min(rejected_comments.length - 1, currentItem))
    }
  }, [rejected_comments?.length ?? 0])


  function onCommentAccepted(comment) {
    dispatch(changeCommentStatusToAccepted(comment))
  }

  function toggleIsMetaHandler(comment, is_meta) {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  function createCommentMarkup() {
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
          currentItem={currentItem === i}
        />
      )
    })
    return comments
  }

  return (
    <div>
      {rejected_comments !== null
        ? createCommentMarkup()
        : 'Loading rejected comments...'}
    </div>
  )
}

ModerateCommentsRejected.propTypes = {
  dispatch: PropTypes.func,
  rejected_comments: PropTypes.arrayOf(PropTypes.object)
}
const mapStateToProps = (state) => ({
  dispatch: state.mod_comments_rejected.dispatch,
  rejected_comments: state.mod_comments_rejected.rejected_comments,
});
export default connect(mapStateToProps)(ModerateCommentsRejected)
