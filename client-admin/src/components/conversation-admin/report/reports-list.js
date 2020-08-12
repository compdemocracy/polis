// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PolisNet from '../../../util/net'
import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { Heading, Box, Button } from 'theme-ui'
import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'

@connect(state => state.zid_metadata)
class ReportsList extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      loading: true,
      reports: []
    }
  }

  getData() {
    const { match } = this.props
    const reportsPromise = PolisNet.polisGet('/api/v3/reports', {
      conversation_id: match.params.conversation_id
    })
    reportsPromise.then(reports => {
      this.setState({
        loading: false,
        reports: reports
      })
    })
  }

  componentDidMount() {
    const { zid_metadata } = this.props

    if (zid_metadata.is_mod) {
      this.getData()
    }
  }

  createReportClicked() {
    const { match } = this.props
    PolisNet.polisPost('/api/v3/reports', {
      conversation_id: match.params.conversation_id
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
          <Button onClick={this.createReportClicked.bind(this)}>
            Create report url
          </Button>
        </Box>
        {this.state.reports.map(report => {
          return (
            <Box sx={{ mb: [2] }} key={report.report_id}>
              <a
                target="_blank"
                rel="noreferrer"
                href={'/report/' + report.report_id}>
                pol.is/report/{report.report_id}
              </a>
            </Box>
          )
        })}
      </Box>
    )
  }
}

ReportsList.propTypes = {
  match: PropTypes.shape({
    params: PropTypes.shape({
      conversation_id: PropTypes.string
    })
  }),
  zid_metadata: PropTypes.shape({
    is_mod: PropTypes.bool
  })
}

export default ReportsList
