// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PolisNet from '../../../util/net'
import React from 'react'
import PropTypes from 'prop-types'
import Url from '../../../util/url'
import { connect } from 'react-redux'
import { Heading, Box, Button } from 'theme-ui'
import { withAuth0 } from '@auth0/auth0-react'
import { populateZidMetadataStore } from '../../../actions'
import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import { useParams } from 'react-router'

@connect((state) => state.zid_metadata)
class ReportsList extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      loading: true,
      reports: [],
      dataLoaded: false
    }
  }

  getData() {
    const { params } = this.props
    const reportsPromise = PolisNet.polisGet('/api/v3/reports', {
      conversation_id: params.conversation_id
    })
    reportsPromise.then((reports) => {
      this.setState({
        loading: false,
        reports: reports,
        dataLoaded: true
      })
    })
  }

  loadInitialData() {
    const { auth0, dispatch, params } = this.props
    if (auth0.isAuthenticated) {
      dispatch(populateZidMetadataStore(params.conversation_id))
    }
  }

  componentDidMount() {
    this.loadInitialData()

    // Check if user is already a moderator on mount
    const { zid_metadata } = this.props
    if (zid_metadata?.is_mod && !this.state.dataLoaded) {
      this.getData()
    }
  }

  componentDidUpdate(prevProps) {
    const { zid_metadata, auth0 } = this.props
    const currentIsMod = zid_metadata?.is_mod

    // Load data if user is now a moderator and data hasn't been loaded
    if (currentIsMod && !this.state.dataLoaded) {
      this.getData()
    }

    if (!prevProps.auth0.isAuthenticated && auth0.isAuthenticated) {
      this.loadInitialData()
    }
  }

  createReportClicked() {
    const { params } = this.props
    PolisNet.polisPost('/api/v3/reports', {
      conversation_id: params.conversation_id
    }).then(() => {
      this.getData()
    })
  }

  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />
    }

    if (this.state.loading) {
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
          <Button onClick={this.createReportClicked.bind(this)}>Create report url</Button>
        </Box>
        {this.state.reports.map((report) => {
          return (
            <Box sx={{ mb: [2] }} key={report.report_id} data-testid="report-list-item">
              <a
                target="_blank"
                rel="noreferrer"
                href={Url.urlPrefix + 'report/' + report.report_id}>
                {Url.urlPrefix}report/{report.report_id}
              </a>
            </Box>
          )
        })}
      </Box>
    )
  }
}

ReportsList.propTypes = {
  dispatch: PropTypes.func,
  params: PropTypes.shape({
    conversation_id: PropTypes.string
  }),
  zid_metadata: PropTypes.shape({
    is_mod: PropTypes.bool
  }),
  auth0: PropTypes.object
}

const ReportsListWrapper = (props) => {
  const params = useParams()
  return <ReportsList {...props} params={params} />
}

export default withAuth0(ReportsListWrapper)
