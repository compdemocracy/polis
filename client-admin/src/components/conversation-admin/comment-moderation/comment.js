// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useRef } from 'react'
import PropTypes from 'prop-types'
import { Flex, Box, Text, Button, Card, Link } from 'theme-ui'

const Comment = ({
  comment,
  acceptClickHandler,
  rejectClickHandler,
  toggleIsMetaHandler,
  acceptButton,
  acceptButtonText,
  rejectButton,
  rejectButtonText,
  isMetaCheckbox
}) => {
  const isMetaRef = useRef(null)

  const onAcceptClicked = () => {
    acceptClickHandler(comment)
  }

  const onRejectClicked = () => {
    rejectClickHandler(comment)
  }

  const onIsMetaClicked = async () => {
    toggleIsMetaHandler(comment, isMetaRef.current.checked)
  }

  return (
    <Card sx={{ mb: [3], minWidth: '35em' }} data-testid="pending-comment">
      <Box>
        <Text sx={{ mb: [3], color: 'red', fontSize: 12 }}>
          {comment.active
            ? null
            : 'Comment flagged by Polis Auto Moderator API. Comment not shown to participants. Accept to override.'}
        </Text>
        <Text sx={{ mb: [3] }}>{comment.txt}</Text>
        <Flex
          sx={{
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%'
          }}>
          <Box>
            {acceptButton ? (
              <Button sx={{ mr: [3] }} onClick={onAcceptClicked}>
                {acceptButtonText}
              </Button>
            ) : null}
            {rejectButton ? (
              <Button onClick={onRejectClicked} data-testid="reject-comment">
                {rejectButtonText}
              </Button>
            ) : null}
          </Box>
          <Flex sx={{ alignItems: 'center' }}>
            <Link target="_blank" sx={{ mr: [2] }} href="https://compdemocracy.org/metadata">
              {isMetaCheckbox ? 'metadata' : null}
            </Link>
            {isMetaCheckbox ? (
              <input
                type="checkbox"
                label="metadata"
                ref={isMetaRef}
                checked={comment.is_meta}
                onChange={onIsMetaClicked}
              />
            ) : null}
          </Flex>
        </Flex>
      </Box>
    </Card>
  )
}

Comment.propTypes = {
  acceptClickHandler: PropTypes.func,
  rejectClickHandler: PropTypes.func,
  toggleIsMetaHandler: PropTypes.func,
  acceptButton: PropTypes.bool,
  acceptButtonText: PropTypes.string,
  rejectButton: PropTypes.bool,
  rejectButtonText: PropTypes.string,
  isMetaCheckbox: PropTypes.bool,
  comment: PropTypes.shape({
    active: PropTypes.bool,
    txt: PropTypes.string,
    is_meta: PropTypes.bool
  })
}

export default Comment
