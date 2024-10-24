// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { Flex, Box, Text, Button, Card, Link } from 'theme-ui'

class Comment extends React.Component {
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment)
  }

  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment)
  }

  onIsMetaClicked() {
    this.props.toggleIsMetaHandler(this.props.comment, this.is_meta.checked)
  }

  render() {
    return (
      <Card
        sx={{
          mb: [3],
          p: [1],
          width: '35em',
          maxWidth: '100%',
          boxShadow: this.props.currentItem ? 'lightseagreen 0px 0px 0px 2px;' : ''
        }}
        className={this.props.currentItem ? 'current-item' : ''}>
        <Box>
          <Text sx={{ mb: [3], color: 'red', fontSize: 12 }}>{this.props.comment.active ? null : 'Comment flagged as toxic by Jigsaw Perspective API. Comment not shown to participants. Accept to override.'}</Text>
          <Text sx={{ mb: [3] }}>{this.props.comment.txt}</Text>
          <Flex
            sx={{
              justifyContent: 'space-between',
              alignItems: 'center',
              width: '100%'
            }}>
            <Flex
              sx={{
                flexWrap: 'wrap',
                gap: [2, 3]
              }}>
              {this.props.acceptButton ? (
                <Button
                  onClick={this.onAcceptClicked.bind(this)}>
                  {this.props.acceptButtonText} (A)
                </Button>
              ) : null}
              {this.props.rejectButton ? (
                <Button onClick={this.onRejectClicked.bind(this)}>
                  {this.props.rejectButtonText} (R)
                </Button>
              ) : null}
            </Flex>
              <Link
                target="_blank"
                sx={{ mr: [2] }}
                href="https://compdemocracy.org/metadata">
                {this.props.isMetaCheckbox ? 'metadata' : null}
              </Link>
              {this.props.isMetaCheckbox ? (
                <input
                  type="checkbox"
                  label="metadata"
                  ref={(c) => (this.is_meta = c)}
                  checked={this.props.comment.is_meta}
                  onChange={this.onIsMetaClicked.bind(this)}
                />
              ) : null}
            </Flex>
          </Flex>
        </Box>
      </Card>
    )
  }
}

Comment.propTypes = {
  dispatch: PropTypes.func,
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
  }),
  currentItem: PropTypes.bool
}

export default connect((state) => {
  return {
    conversation: state.zid_metadata.zid_metadata
  }
})(Comment)
