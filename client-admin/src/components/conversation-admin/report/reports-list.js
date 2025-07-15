// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PolisNet from '../../../util/net'
import { useState, useEffect } from 'react'
import Url from '../../../util/url'
import { useSelector, useDispatch } from 'react-redux'
import { Heading, Box, Button } from 'theme-ui'
import { useAuth } from 'react-oidc-context'
import { populateZidMetadataStore } from '../../../actions'
import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import { useParams } from 'react-router'

const ReportsList = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const { isAuthenticated } = useAuth()
  const zid_metadata = useSelector((state) => state.zid_metadata)

  const [state, setState] = useState({
    loading: true,
    reports: [],
    dataLoaded: false
  })

  const getData = () => {
    const reportsPromise = PolisNet.polisGet('/api/v3/reports', {
      conversation_id: params.conversation_id
    })
    reportsPromise.then((reports) => {
      setState({
        loading: false,
        reports: reports,
        dataLoaded: true
      })
    })
  }

  const loadInitialData = () => {
    if (isAuthenticated) {
      dispatch(populateZidMetadataStore(params.conversation_id))
    }
  }

  useEffect(() => {
    loadInitialData()

    // Check if user is already a moderator on mount
    if (zid_metadata?.zid_metadata?.is_mod && !state.dataLoaded) {
      getData()
    }
  }, [])

  useEffect(() => {
    const currentIsMod = zid_metadata?.zid_metadata?.is_mod

    // Load data if user is now a moderator and data hasn't been loaded
    if (currentIsMod && !state.dataLoaded) {
      getData()
    }

    if (isAuthenticated && !zid_metadata?.zid_metadata) {
      loadInitialData()
    }
  }, [zid_metadata, isAuthenticated])

  const createReportClicked = () => {
    PolisNet.polisPost('/api/v3/reports', {
      conversation_id: params.conversation_id
    }).then(() => {
      getData()
    })
  }

  if (
    ComponentHelpers.shouldShowPermissionsError({
      zid_metadata: zid_metadata.zid_metadata,
      loading: zid_metadata.loading
    })
  ) {
    return <NoPermission />
  }

  if (state.loading) {
    return <div>Loading Reports...</div>
  }

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Report
      </Heading>
      <Box sx={{ mb: [3, null, 4] }}>
        <Button onClick={createReportClicked}>Create report url</Button>
      </Box>
      {state.reports.map((report) => {
        return (
          <Box sx={{ mb: [2] }} key={report.report_id} data-testid="report-list-item">
            <a target="_blank" rel="noreferrer" href={Url.urlPrefix + 'report/' + report.report_id}>
              {Url.urlPrefix}report/{report.report_id}
            </a>
          </Box>
        )
      })}
    </Box>
  )
}

export default ReportsList
