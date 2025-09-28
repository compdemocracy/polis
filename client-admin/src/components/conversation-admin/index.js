// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Flex, Box } from 'theme-ui'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'
import { useAuth } from 'react-oidc-context'
import { useEffect, useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'

import { checkConvoPermissions, useUser } from '../../util/auth'
import { populateZidMetadataStore, resetMetadataStore } from '../../actions'
import { ZidMetadataProvider, useZidMetadata } from '../../util/zid'
import ConversationConfig from './ConversationConfig'
import ConversationStats from './stats'
import InviteCodes from './InviteCodes'
import InviteTree from './InviteTree'
import ModerateComments from './comment-moderation/'
import NoPermission from './NoPermission'
import Reports from './report/Reports'
import ShareAndEmbed from './ShareAndEmbed'
import Spinner from '../framework/Spinner'
import TopicModeration from './topic-moderation/'

const ConversationAdmin = () => {
  const params = useParams()
  const location = useLocation()
  const zid_metadata = useZidMetadata()
  const user = useUser()

  const [permissionState, setPermissionState] = useState('CHECKING') // CHECKING, PERMITTED, DENIED

  useEffect(() => {
    // This effect determines the user's permission level for the conversation.
    // It runs when the user or conversation changes, or when the metadata loads.
    // It's "sticky": once permission is PERMITTED or DENIED, it won't change
    // until the user or conversation_id changes, avoiding flicker from
    // optimistic updates.

    if (zid_metadata.loading || !zid_metadata || !user.user) {
      // Not ready to check permissions yet.
      return
    }

    if (permissionState === 'CHECKING') {
      const hasPermission = checkConvoPermissions(user, zid_metadata)
      setPermissionState(hasPermission ? 'PERMITTED' : 'DENIED')
    }
  }, [user, zid_metadata, permissionState])

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
          </Routes>
        )
      default:
        return null
    }
  }

  return (
    <Flex>
      <Box sx={{ mr: [5], p: [4], flex: '0 0 275' }}>
        <Box sx={{ mb: [3] }}>
          <Link sx={{ variant: 'links.nav' }} to={`/`}>
            All
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link sx={{ variant: url ? 'links.nav' : 'links.activeNav' }} to={baseUrl}>
            Configure
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'share' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/share`}>
            Distribute
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'comments' ? 'links.activeNav' : 'links.nav'
            }}
            data-testid="moderate-comments"
            to={`${baseUrl}/comments`}>
            Moderate
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'stats' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/stats`}>
            Monitor
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'reports' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/reports`}>
            Report
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'topics' ? 'links.activeNav' : 'links.nav'
            }}
            data-test-id="moderate-topics"
            to={`${baseUrl}/topics`}>
            Topic Mod
          </Link>
        </Box>
        <Box sx={{ mb: [3] }}>
          <Link
            sx={{
              variant: url === 'invite-tree' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/invite-tree`}>
            Invite Tree
          </Link>
        </Box>
        {zid_metadata?.treevite_enabled && (
          <Box sx={{ mb: [3] }}>
            <Link
              sx={{
                variant: url === 'invite-codes' ? 'links.activeNav' : 'links.nav'
              }}
              to={`${baseUrl}/invite-codes`}>
              Invite Codes
            </Link>
          </Box>
        )}
      </Box>
      <Box sx={{ p: [4], flex: '0 0 auto', maxWidth: '60em', mx: [4] }}>{renderContent()}</Box>
    </Flex>
  )
}

const ConversationAdminContainer = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const { isAuthenticated } = useAuth()
  const zid_metadata = useSelector((state) => state.zid_metadata)

  const loadZidMetadata = () => {
    dispatch(populateZidMetadataStore(params.conversation_id))
  }

  const resetMetadata = () => {
    dispatch(resetMetadataStore())
  }

  useEffect(() => {
    if (!zid_metadata.loading && isAuthenticated) {
      loadZidMetadata()
    }
  }, [isAuthenticated])

  useEffect(() => {
    return () => {
      resetMetadata()
    }
  }, [])

  useEffect(() => {
    if (params.conversation_id) {
      loadZidMetadata()
    }
  }, [params.conversation_id])

  return (
    <ZidMetadataProvider>
      <ConversationAdmin />
    </ZidMetadataProvider>
  )
}

export default ConversationAdminContainer
