// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import {
  populateConversationsStore,
  handleCreateConversationSubmit
} from '../../actions'

import Url from '../../util/url'
import { Box, Heading, Button, Text } from 'theme-ui'
import Conversation from './conversation'

@connect((state) => state.conversations)
class Conversations extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      filterMinParticipantCount: 0,
      sort: 'participant_count'
    }
  }

  onNewClicked() {
    this.props.dispatch(handleCreateConversationSubmit())
  }

  componentDidMount() {
    this.props.dispatch(populateConversationsStore())
    // loading true or just do that in constructor
    // check your connectivity and try again
  }

  goToConversation = (conversation_id) => {
    return () => {
      if (this.props.history.pathname === 'other-conversations') {
        window.open(`${Url.urlPrefix}${conversation_id}`, '_blank')
        return
      }
      this.props.history.push(`/m/${conversation_id}`)
    }
  }

  filterCheck(c) {
    let include = true

    if (c.participant_count < this.state.filterMinParticipantCount) {
      include = false
    }

    if (this.props.history.pathname === 'other-conversations') {
      // filter out conversations i do own
      include = !c.is_owner
    }

    if (this.props.history.pathname !== 'other-conversations' && !c.is_owner) {
      // if it's not other convos and i'm not the owner, don't show it
      // filter out convos i don't own
      include = false
    }

    return include
  }

  firePopulateInboxAction() {
    this.props.dispatch(populateConversationsStore())
  }

  onFilterChange() {
    this.setState()
  }

  render() {
    const err = this.props.error
    const { conversations } = this.props

    return (
      <Box>
        <Heading
          as="h3"
          sx={{
            fontSize: [3, null, 4],
            lineHeight: 'body',
            mb: [3, null, 4]
          }}>
          All Conversations
        </Heading>
        <Box sx={{ mb: [3, null, 4] }}>
          <Button onClick={this.onNewClicked.bind(this)}>
            Create new conversation
          </Button>
        </Box>
        <Box>
          <Box sx={{ mb: [3] }}>
            {this.props.loading ? 'Loading conversations...' : null}
          </Box>
          {err ? (
            <Text>
              {'Error loading conversations: ' +
                err.status +
                ' ' +
                err.statusText}
            </Text>
          ) : null}
          {conversations
            ? conversations.map((c, i) => {
                return this.filterCheck(c) ? (
                  <Conversation
                    key={c.conversation_id}
                    c={c}
                    i={i}
                    goToConversation={this.goToConversation(c.conversation_id)}
                  />
                ) : null
              })
            : null}
        </Box>
      </Box>
    )
  }
}

Conversations.propTypes = {
  dispatch: PropTypes.func,
  error: PropTypes.shape({
    status: PropTypes.number,
    statusText: PropTypes.string
  }),
  loading: PropTypes.bool,
  conversations: PropTypes.arrayOf(
    PropTypes.shape({
      conversation_id: PropTypes.string
    })
  ),
  history: PropTypes.shape({
    pathname: PropTypes.string,
    push: PropTypes.func
  })
}

export default Conversations
