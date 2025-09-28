// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box, Button } from 'theme-ui'
import { useAuth } from 'react-oidc-context'
import { useParams } from 'react-router'
import { useState, useEffect } from 'react'

import { hasDelphiEnabled, isAdminOrMod, useUser } from '../../../util/auth'
import { useZidMetadata } from '../../../util/zid'
import PolisNet from '../../../util/net'
import Url from '../../../util/url'

const modMap = {
  0: 'Showing only moderated comments',
  '-1': 'Showing moderated and unmoderated comments',
  '-2': 'Showing all comments, including those moderated out'
}

const ReportsList = () => {
  const params = useParams()
  const { isAuthenticated, user: authUser } = useAuth()
  const user = useUser()
  const zid_metadata = useZidMetadata()
  const [mod_level, setModLevel] = useState(-2)

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

  useEffect(() => {
    // Load data if user is now a moderator and data hasn't been loaded
    if (!state.dataLoaded && isAdminOrMod(user, zid_metadata)) {
      getData()
    }
  }, [zid_metadata, isAuthenticated, user, state.dataLoaded])

  const createReportClicked = () => {
    PolisNet.polisPost('/api/v3/reports', {
      conversation_id: params.conversation_id,
      mod_level
    }).then(() => {
      getData()
    })
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
        {hasDelphiEnabled(authUser) && (
          <Box>
            Select which comments will be visible in this report:
            <select
              onChange={(e) => setModLevel(e.target.value)}
              style={{ display: 'block', margin: '1em 0' }}>
              <option selected value={-2}>
                Include all comments
              </option>
              <option value={-1}>Include all comments except for moderation rejections</option>
              <option value={0}>Include only moderator accepted comments</option>
            </select>
          </Box>
        )}
        <Button onClick={createReportClicked}>Create report url</Button>
      </Box>
      {state.reports.map((report) => {
        return (
          <Box sx={{ mb: [2] }} key={report.report_id} data-testid="report-list-item">
            <a target="_blank" rel="noreferrer" href={Url.urlPrefix + 'report/' + report.report_id}>
              {Url.urlPrefix}report/{report.report_id}
            </a>
            {hasDelphiEnabled(authUser) && (
              <p>{modMap[String(report.mod_level)] || modMap[Number(report.mod_level)]}</p>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default ReportsList
