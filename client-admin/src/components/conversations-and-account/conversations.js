// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { handleCreateConversationSubmit, populateConversationsStore } from '../../actions'
import { isAuthReady } from '../../util/net'

import Url from '../../util/url'
import { withAuth0 } from '@auth0/auth0-react'
import { Box, Heading, Button, Text } from 'theme-ui'
import Conversation from './conversation'
import { useLocation, useNavigate } from 'react-router'

@connect((state) => state.conversations)
class Conversations extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      filterMinParticipantCount: 0,
      sort: 'participant_count'
    }
  }

  componentDidMount() {
    console.log('🗂️ Conversations componentDidMount:', {
      isAuthenticated: this.props.auth0.isAuthenticated,
      isLoading: this.props.auth0.isLoading,
      timestamp: new Date().toISOString()
    })

    // Listen for auth ready event
    this.handleAuthReady = () => {
      console.log('🎉 Auth ready event received in Conversations')
      this.loadConversationsIfNeeded()
    }
    window.addEventListener('polisAuthReady', this.handleAuthReady)

    this.loadConversationsIfNeeded()
  }

  componentWillUnmount() {
    // Clean up event listener
    if (this.handleAuthReady) {
      window.removeEventListener('polisAuthReady', this.handleAuthReady)
    }
  }

  componentDidUpdate(prevProps) {
    // Load conversations when auth state changes from loading to authenticated
    const wasLoading = prevProps.auth0.isLoading
    const isNowAuthenticated = this.props.auth0.isAuthenticated && !this.props.auth0.isLoading

    console.log('🗂️ Conversations componentDidUpdate:', {
      wasLoading,
      isNowAuthenticated,
      currentAuth: {
        isAuthenticated: this.props.auth0.isAuthenticated,
        isLoading: this.props.auth0.isLoading
      },
      timestamp: new Date().toISOString()
    })

    if (wasLoading && isNowAuthenticated) {
      this.loadConversationsIfNeeded()
    }
  }

  onNewClicked() {
    this.props.dispatch(handleCreateConversationSubmit(this.props.navigate))
  }

  loadConversationsIfNeeded() {
    const { auth0, loading, conversations } = this.props
    const authSystemReady = isAuthReady()

    console.log('🗂️ loadConversationsIfNeeded:', {
      authIsLoading: auth0.isLoading,
      isAuthenticated: auth0.isAuthenticated,
      authSystemReady,
      dataLoading: loading,
      hasConversations: !!conversations,
      willLoad:
        !auth0.isLoading && auth0.isAuthenticated && authSystemReady && !loading && !conversations
    })

    if (
      !auth0.isLoading &&
      auth0.isAuthenticated &&
      authSystemReady &&
      !loading &&
      !conversations
    ) {
      console.log('📡 Dispatching populateConversationsStore')
      this.props.dispatch(populateConversationsStore())
    } else if (!auth0.isLoading && auth0.isAuthenticated && !authSystemReady) {
      console.log('⏳ Auth system not ready yet, will retry when ready')
      // The auth system will trigger a re-render when ready via the oidc-connector
    }
  }

  loadConversations() {
    const { auth0, loading, conversations } = this.props
    if (!auth0.isLoading && auth0.isAuthenticated && !loading && !conversations) {
      this.props.dispatch(populateConversationsStore())
    }
  }

  goToConversation = (conversation_id) => {
    return () => {
      if (this.props.location.pathname === 'other-conversations') {
        window.open(`${Url.urlPrefix}${conversation_id}`, '_blank')
        return
      }
      this.props.navigate(`/m/${conversation_id}`)
    }
  }

  filterCheck(c) {
    let include = true

    if (c.participant_count < this.state.filterMinParticipantCount) {
      include = false
    }

    if (this.props.location.pathname === 'other-conversations') {
      // filter out conversations i do own
      include = !c.is_owner
    }

    if (this.props.location.pathname !== 'other-conversations' && !c.is_owner) {
      // if it's not other convos and i'm not the owner, don't show it
      // filter out convos i don't own
      include = false
    }

    return include
  }

  async firePopulateInboxAction() {
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
          <Button onClick={this.onNewClicked.bind(this)}>Create new conversation</Button>
        </Box>
        <Box>
          <Box sx={{ mb: [3] }}>{this.props.loading ? 'Loading conversations...' : null}</Box>
          {err ? (
            <Text>{'Error loading conversations: ' + err.status + ' ' + err.statusText}</Text>
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
  location: PropTypes.shape({
    pathname: PropTypes.string
  }),
  navigate: PropTypes.func,
  auth0: PropTypes.object
}

const ConversationsWrapper = (props) => {
  const location = useLocation()
  const navigate = useNavigate()
  return <Conversations {...props} location={location} navigate={navigate} />
}

export default withAuth0(ConversationsWrapper)
