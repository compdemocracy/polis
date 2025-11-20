// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Flex, Box } from 'theme-ui'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'
import { useAuth } from 'react-oidc-context'
import { useEffect, useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'

import { checkConvoPermissions, useUser, hasDelphiEnabled } from '../../util/auth'
import { populateConversationDataStore, resetMetadataStore } from '../../actions'
import { ConversationDataProvider, useConversationData } from '../../util/conversation_data'
import ConversationConfig from './ConversationConfig'
import ConversationStats from './stats'
import InviteCodes from './InviteCodes'
import InviteTree from './InviteTree'
import ModerateComments from './comment-moderation/'
import NoPermission from './NoPermission'
import ParticipantManagement from './ParticipantManagement'
import Reports from './report/Reports'
import ShareAndEmbed from './ShareAndEmbed'
import Spinner from '../framework/Spinner'
import TopicModeration from './topic-moderation/'

const ConversationAdmin = () => {
  const params = useParams()
  const location = useLocation()
  const conversationData = useConversationData()
  const userContext = useUser()
  const { user: authUser } = useAuth()

  const [permissionState, setPermissionState] = useState('CHECKING') // CHECKING, PERMITTED, DENIED

  useEffect(() => {
    // This effect determines the user's permission level for the conversation.
    // It runs when the user or conversation changes, or when the metadata loads.
    // It's "sticky": once permission is PERMITTED or DENIED, it won't change
    // until the user or conversation_id changes, avoiding flicker from
    // optimistic updates.

    if (conversationData.loading || !conversationData || !userContext.user) {
      // Not ready to check permissions yet.
      return
    }

    if (permissionState === 'CHECKING') {
      const hasPermission = checkConvoPermissions(userContext, conversationData)
      setPermissionState(hasPermission ? 'PERMITTED' : 'DENIED')
    }
  }, [userContext, conversationData, permissionState])

  useEffect(() => {
    // Reset permission check when conversation changes
    setPermissionState('CHECKING')
  }, [params.conversation_id])

  const url = location.pathname.split('/')[3]
  const baseUrl = `/m/${params.conversation_id}`

  const renderContent = () => {
    switch (permissionState) {
      case 'CHECKING':
        return <Spinner />
      case 'DENIED':
        return <NoPermission />
      case 'PERMITTED':
        return (
          <Routes>
            <Route path="/" element={<ConversationConfig />} />
            <Route path="share" element={<ShareAndEmbed />} />
            <Route path="reports/*" element={<Reports />} />
            <Route path="comments/*" element={<ModerateComments />} />
            <Route path="stats" element={<ConversationStats />} />
            <Route
              path="topics/*"
              element={
                <TopicModeration
                  conversation_id={params.conversation_id}
                  baseUrl={`${baseUrl}/topics`}
                  location={location}
                />
              }
            />
            <Route path="invite-tree" element={<InviteTree />} />
            <Route path="invite-codes" element={<InviteCodes />} />
            {hasDelphiEnabled(authUser) && (
              <Route path="participants" element={<ParticipantManagement />} />
            )}
          </Routes>
        )
      default:
        return null
    }
  }

  return (
    <Flex
      sx={{
        flexDirection: ['column', 'column', 'row'], // Column on mobile/tablet/iPad, row on desktop
        width: '100%',
        maxWidth: '100vw',
        overflowX: 'hidden'
      }}>
      {/* Conversation Navigation - horizontal on mobile/tablet/iPad, sidebar on large desktop */}
      <Box
        sx={{
          py: [2, 2, 4],
          px: [2, 3, 4],
          flex: '0 0 auto',
          width: ['100%', '100%', 'auto'],
          borderBottom: ['2px solid', '2px solid', 'none'],
          borderBottomColor: ['secondary', 'secondary', 'transparent'],
          display: 'flex',
          flexDirection: ['row', 'row', 'column'],
          columnGap: [2, 3, 0],
          rowGap: [2, 2, 0],
          flexWrap: ['wrap', 'wrap', 'nowrap'],
          justifyContent: ['flex-start', 'flex-start', 'flex-start'],
          overflowX: ['auto', 'auto', 'visible'],
          minWidth: 0
        }}>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link sx={{ variant: 'links.nav' }} to={`/`}>
            All
          </Link>
        </Box>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link sx={{ variant: url ? 'links.nav' : 'links.activeNav' }} to={baseUrl}>
            Configure
          </Link>
        </Box>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'share' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/share`}>
            Distribute
          </Link>
        </Box>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'comments' ? 'links.activeNav' : 'links.nav'
            }}
            data-testid="moderate-comments"
            to={`${baseUrl}/comments`}>
            Moderate
          </Link>
        </Box>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'stats' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/stats`}>
            Monitor
          </Link>
        </Box>
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'reports' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/reports`}>
            Reports
          </Link>
        </Box>
        {/* <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'topics' ? 'links.activeNav' : 'links.nav'
            }}
            data-test-id="moderate-topics"
            to={`${baseUrl}/topics`}>
            Topic Mod
          </Link>
        </Box> */}
        <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
          <Link
            sx={{
              variant: url === 'invite-tree' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/invite-tree`}>
            Invite Tree
          </Link>
        </Box>
        {conversationData?.treevite_enabled && (
          <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
            <Link
              sx={{
                variant: url === 'invite-codes' ? 'links.activeNav' : 'links.nav'
              }}
              to={`${baseUrl}/invite-codes`}>
              Invite Codes
            </Link>
          </Box>
        )}
        {hasDelphiEnabled(authUser) && (
          <Box sx={{ mb: [0, 0, 3], whiteSpace: 'nowrap' }}>
            <Link
              sx={{
                variant: url === 'participants' ? 'links.activeNav' : 'links.nav'
              }}
              to={`${baseUrl}/participants`}>
              Participants
            </Link>
          </Box>
        )}
      </Box>
      {/* Content Area */}
      <Box
        sx={{
          p: [2, 3, 4],
          flex: '1 1 auto',
          maxWidth: ['100%', '100%', '60em'],
          width: '100%',
          minWidth: 0,
          mx: [0, 0, 4],
          overflowX: 'auto', // Allow horizontal scroll if content needs it
          wordWrap: 'break-word',
          overflowWrap: 'break-word'
        }}>
        {renderContent()}
      </Box>
    </Flex>
  )
}

const ConversationAdminContainer = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const { isAuthenticated } = useAuth()
  const conversationData = useSelector((state) => state.conversationData)

  const loadConversationData = () => {
    dispatch(populateConversationDataStore(params.conversation_id))
  }

  const resetMetadata = () => {
    dispatch(resetMetadataStore())
  }

  useEffect(() => {
    if (!conversationData.loading && isAuthenticated) {
      loadConversationData()
    }
  }, [isAuthenticated])

  useEffect(() => {
    return () => {
      resetMetadata()
    }
  }, [])

  useEffect(() => {
    if (params.conversation_id) {
      loadConversationData()
    }
  }, [params.conversation_id])

  return (
    <ConversationDataProvider>
      <ConversationAdmin />
    </ConversationDataProvider>
  )
}

export default ConversationAdminContainer
