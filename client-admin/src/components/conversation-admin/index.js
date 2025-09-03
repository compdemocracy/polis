// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { Flex, Box } from 'theme-ui'
import { populateZidMetadataStore, resetMetadataStore } from '../../actions'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'
import { useAuth } from 'react-oidc-context'

import ConversationConfig from './conversation-config'
import ConversationStats from './stats'
import ModerateComments from './comment-moderation/'
import TopicModeration from './topic-moderation/'
import ShareAndEmbed from './share-and-embed'
import Reports from './report/reports'
import InviteTree from './InviteTree'
import InviteCodes from './InviteCodes'

const ConversationAdminContainer = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const location = useLocation()
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

  const url = location.pathname.split('/')[3]
  const baseUrl = `/m/${params.conversation_id}`

  return (
    <Flex>
      <Box sx={{ mr: [5], p: [4], flex: '0 0 275' }}>
        <Box sx={{ mb: [3] }}>
          <Link sx={{ variant: 'links.nav' }} to={`/`}>
            All
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
              variant: url === 'invite-tree' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${baseUrl}/invite-tree`}>
            Invite Tree
          </Link>
        </Box>
        {zid_metadata?.zid_metadata?.treevite_enabled && (
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
      <Box sx={{ p: [4], flex: '0 0 auto', maxWidth: '60em', mx: [4] }}>
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
      </Box>
    </Flex>
  )
}

export default ConversationAdminContainer
