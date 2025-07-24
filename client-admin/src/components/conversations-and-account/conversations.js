// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useState, useEffect, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { handleCreateConversationSubmit, populateConversationsStore } from '../../actions'
import { isAuthReady } from '../../util/net'

import Url from '../../util/url'
import { useAuth } from 'react-oidc-context'
import { Box, Heading, Button, Text } from 'theme-ui'
import Conversation from './conversation'
import { useLocation, useNavigate } from 'react-router'

const Conversations = () => {
  const dispatch = useDispatch()
  const location = useLocation()
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()
  const { conversations, loading, error } = useSelector((state) => state.conversations)

  const [filterState] = useState({
    filterMinParticipantCount: 0,
    sort: 'participant_count'
  })

  const loadConversationsIfNeeded = useCallback(() => {
    const authSystemReady = isAuthReady()

    if (!isLoading && isAuthenticated && authSystemReady && !loading && !conversations) {
      dispatch(populateConversationsStore())
    }
  }, [isLoading, isAuthenticated, loading, conversations, dispatch])

  useEffect(() => {
    // Listen for auth ready event
    const handleAuthReady = () => {
      loadConversationsIfNeeded()
    }

    window.addEventListener('polisAuthReady', handleAuthReady)

    if (isAuthenticated && !isLoading) {
      loadConversationsIfNeeded()

      return () => {
        window.removeEventListener('polisAuthReady', handleAuthReady)
      }
    }

    return () => {
      window.removeEventListener('polisAuthReady', handleAuthReady)
    }
  }, [loadConversationsIfNeeded, isAuthenticated, isLoading])

  const onNewClicked = () => {
    dispatch(handleCreateConversationSubmit(navigate))
  }

  const goToConversation = (conversation_id) => {
    return () => {
      if (location.pathname === 'other-conversations') {
        window.open(`${Url.urlPrefix}${conversation_id}`, '_blank')
        return
      }
      navigate(`/m/${conversation_id}`)
    }
  }

  const filterCheck = (c) => {
    let include = true

    if (c.participant_count < filterState.filterMinParticipantCount) {
      include = false
    }

    if (location.pathname === 'other-conversations') {
      // filter out conversations i do own
      include = !c.is_owner
    }

    if (location.pathname !== 'other-conversations' && !c.is_owner) {
      // if it's not other convos and i'm not the owner, don't show it
      // filter out convos i don't own
      include = false
    }

    return include
  }

  const err = error

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
        <Button onClick={onNewClicked}>Create new conversation</Button>
      </Box>
      <Box>
        <Box sx={{ mb: [3] }}>{loading ? 'Loading conversations...' : null}</Box>
        {err ? (
          <Text>{'Error loading conversations: ' + err.status + ' ' + err.statusText}</Text>
        ) : null}
        {conversations
          ? conversations.map((c, i) => {
              return filterCheck(c) ? (
                <Conversation
                  key={c.conversation_id}
                  c={c}
                  i={i}
                  goToConversation={goToConversation(c.conversation_id)}
                />
              ) : null
            })
          : null}
      </Box>
    </Box>
  )
}

export default Conversations
