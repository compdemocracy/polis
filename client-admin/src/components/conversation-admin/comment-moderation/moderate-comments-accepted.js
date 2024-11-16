// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import {
  changeCommentStatusToRejected,
  changeCommentCommentIsMeta
} from '../../../actions'
import Comment from './comment'

function ModerateCommentsAccepted({ dispatch, accepted_comments = [] }) {

  const [currentItem, setCurrentItem] = useState(0)
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.code === 'KeyR') {
        onCommentRejected(accepted_comments[currentItem])
      }
      if (e.code === 'KeyW') {
        setCurrentItem(Math.max(0, currentItem - 1))
      }
      if (accepted_comments && e.code === 'KeyS') {
        setCurrentItem(Math.min(accepted_comments.length - 1, currentItem + 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentItem, accepted_comments]);

  useEffect(() => {
    if (accepted_comments && currentItem > accepted_comments.length - 1) {
      setCurrentItem(Math.min(accepted_comments.length - 1, currentItem))
    }
  }, [accepted_comments?.length ?? 0])

  function onCommentRejected(comment) {
    dispatch(changeCommentStatusToRejected(comment))
  }

  function toggleIsMetaHandler(comment, is_meta) {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }
  function createCommentMarkup() {
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
          currentItem={currentItem === i}
        />
      )
    })
    return comments
  }

  return (
    <div>
      {accepted_comments !== null
        ? createCommentMarkup()
        : 'Loading accepted comments...'}
    </div>
  )
}

ModerateCommentsAccepted.propTypes = {
  dispatch: PropTypes.func,
  accepted_comments: PropTypes.arrayOf(PropTypes.object)
}

const mapStateToProps = (state) => ({
  dispatch: state.mod_comments_accepted.dispatch,
  accepted_comments: state.mod_comments_accepted.accepted_comments,
});
export default connect(mapStateToProps)(ModerateCommentsAccepted)