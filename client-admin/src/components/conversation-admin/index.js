// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import { connect } from 'react-redux'
import { Flex, Box, jsx } from 'theme-ui'
import { populateZidMetadataStore, resetMetadataStore } from '../../actions'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'

import ConversationConfig from './conversation-config'
import ConversationStats from './stats'
import { withAuth0 } from '@auth0/auth0-react'

import ModerateComments from './comment-moderation/'

// import DataExport from "./data-export";
import ShareAndEmbed from './share-and-embed'

import Reports from './report/reports'

@connect((state) => state.zid_metadata)
class ConversationAdminContainer extends React.Component {
  constructor(props) {
    super(props)
  }

  loadZidMetadata() {
    this.props.dispatch(populateZidMetadataStore(this.props.params.conversation_id))
  }

  resetMetadata() {
    this.props.dispatch(resetMetadataStore())
  }

  componentDidMount() {
    if (!this.props.loading && this.props.auth0.isAuthenticated) {
      this.loadZidMetadata()
    }
  }

  componentWillUnmount() {
    this.resetMetadata()
  }

  componentDidUpdate(prevProps) {
    if (prevProps.params.conversation_id !== this.props.params.conversation_id) {
      this.loadZidMetadata()
    }
    if (!prevProps.auth0.isAuthenticated && this.props.auth0.isAuthenticated) {
      this.loadZidMetadata()
    }
  }

  render() {
    const { location, params } = this.props
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
        </Box>
        <Box sx={{ p: [4], flex: '0 0 auto', maxWidth: '60em', mx: [4] }}>
          <Routes>
            <Route path="/" element={<ConversationConfig />} />
            <Route path="share" element={<ShareAndEmbed />} />
            <Route path="reports" element={<Reports />} />
            <Route path="comments/*" element={<ModerateComments />} />
            <Route path="stats" element={<ConversationStats />} />
            {/* <Route path="export" element={<DataExport />} /> */}
          </Routes>
        </Box>
      </Flex>
    )
  }
}

function ConversationAdminContainerWrapper(props) {
  const params = useParams()
  const location = useLocation()
  return <ConversationAdminContainer {...props} params={params} location={location} />
}

export default withAuth0(ConversationAdminContainerWrapper)
