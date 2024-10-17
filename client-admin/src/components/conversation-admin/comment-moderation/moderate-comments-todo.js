// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import {
  changeCommentStatusToAccepted,
  changeCommentStatusToRejected,
  changeCommentCommentIsMeta
} from '../../../actions'
import Comment from './comment'

function ModerateCommentsTodo({ dispatch, unmoderated_comments = [] }) {
  const [currentItem, setCurrentItem] = useState(0)
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.code === 'KeyA') {
        onCommentAccepted(unmoderated_comments[currentItem])
      }
      if (e.code === 'KeyR') {
        onCommentRejected(unmoderated_comments[currentItem])
      }
      if (e.code === 'KeyW') {
        setCurrentItem(Math.max(0, currentItem - 1))
      }
      if (unmoderated_comments && e.code === 'KeyS') {
        setCurrentItem(Math.min(unmoderated_comments.slice(0, max).length - 1, currentItem + 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentItem, unmoderated_comments]);

  const max = 100;

  useEffect(() => {
    if (unmoderated_comments && currentItem > unmoderated_comments.slice(0, max).length - 1) {
      setCurrentItem(Math.min(unmoderated_comments.slice(0, max).length - 1, currentItem))
    }
  }, [unmoderated_comments?.length ?? 0])

  function onCommentAccepted(comment) {
    dispatch(changeCommentStatusToAccepted(comment))
  }

  function onCommentRejected(comment) {
    dispatch(changeCommentStatusToRejected(comment))
  }

  function toggleIsMetaHandler(comment, is_meta) {
    dispatch(changeCommentCommentIsMeta(comment, is_meta))
  }

  function createCommentMarkup(max) {

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
          currentItem={currentItem === i}
        />
      )
    })

  }

  return (
    <div>
      <div>
        <p> Displays maximum {max} comments </p>
        {unmoderated_comments !== null
          ? createCommentMarkup(max)
          : 'Loading unmoderated comments...'}
      </div>
    </div>
  )
}

ModerateCommentsTodo.propTypes = {
  dispatch: PropTypes.func,
  unmoderated_comments: PropTypes.arrayOf(PropTypes.object)
}

const mapStateToProps = (state) => ({
  dispatch: state.mod_comments_unmoderated.dispatch,
  unmoderated_comments: state.mod_comments_unmoderated.unmoderated_comments,
});

export default connect(mapStateToProps)(ModerateCommentsTodo)