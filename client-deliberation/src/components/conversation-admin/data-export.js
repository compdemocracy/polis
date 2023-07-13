// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { startDataExport } from '../../actions'
import dateSetupUtil from '../../util/data-export-date-setup'
import { Heading } from 'theme-ui'
import ComponentHelpers from '../../util/component-helpers'
import NoPermission from './no-permission'

@connect((state) => state.zid_metadata)
class DataExport extends React.Component {
  constructor(props) {
    super(props)
    const times = dateSetupUtil()
    this.state = Object.assign({}, times, { showHelpMessage: false })
  }

  handleExportClicked() {
    return () => {
      this.setState({ showHelpMessage: true })

      const year = this.exportSelectYear.value
      const month = this.exportSelectMonth.value
      const dayOfMonth = this.exportSelectDay.value
      const tz = this.exportSelectHour.value
      const format = 'csv'

      const dateString = [year, month, dayOfMonth, tz].join(' ')
      const dddate = new Date(dateString)

      this.props.dispatch(
        startDataExport(
          this.props.zid_metadata.conversation_id,
          format,
          (dddate / 1000) << 0,
          !!this.state.untilEnabled
        )
      )
    }
  }

  showHelpMessage() {
    return (
      <div>
        <p>
          Data from this conversation will be sent to your email. (This can take
          a little while, especially for larger conversations).
        </p>
      </div>
    )
  }

  handleUntilToggled() {
    this.setState({ untilEnabled: !this.state.untilEnabled })
  }

  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />
    }

    return (
      <div>
        <Heading
          as="h3"
          sx={{
            fontSize: [3, null, 4],
            lineHeight: 'body',
            mb: [3, null, 4]
          }}>
          Export
        </Heading>
        <div>
          <p> Until: </p>
          <input onClick={this.handleUntilToggled.bind(this)} type="checkbox" />
          <select
            disabled={this.state.untilEnabled ? '' : 'disabled'}
            ref={(c) => (this.exportSelectYear = c)}>
            {this.state.years.map((year, i) => {
              return (
                <option selected={year.selected} key={i} value={year.name}>
                  {year.name}
                </option>
              )
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? '' : 'disabled'}
            ref={(c) => (this.exportSelectMonth = c)}>
            {this.state.months.map((month, i) => {
              return (
                <option selected={month.selected} key={i} value={month.name}>
                  {month.name}
                </option>
              )
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? '' : 'disabled'}
            ref={(c) => (this.exportSelectDay = c)}>
            {this.state.days.map((day, i) => {
              return (
                <option selected={day.selected} key={i} value={day.name}>
                  {' '}
                  {day.name}{' '}
                </option>
              )
            })}
          </select>
          <select
            disabled={this.state.untilEnabled ? '' : 'disabled'}
            ref={(c) => (this.exportSelectHour = c)}>
            {this.state.tzs.map((tz, i) => {
              return (
                <option selected={tz.selected} key={i} value={tz.name}>
                  {' '}
                  {tz.name}{' '}
                </option>
              )
            })}
          </select>
          <p>
            By default, the entire dataset is returned. To limit the last
            timestamp returned, enter a date here.
          </p>
          <button onClick={this.handleExportClicked().bind(this)}>
            Export
          </button>
          {this.state.showHelpMessage ? this.showHelpMessage() : null}
        </div>
      </div>
    )
  }
}

DataExport.propTypes = {
  dispatch: PropTypes.func,
  zid_metadata: PropTypes.shape({
    conversation_id: PropTypes.string
  })
}

export default DataExport
