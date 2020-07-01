// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import dateSetupUtil from '../../../util/data-export-date-setup'
import React from 'react'
import { connect } from 'react-redux'
import { populateConversationStatsStore } from '../../../actions'
import NumberCards from './conversation-stats-number-cards'
import Voters from './voters'
import Commenters from './commenters'
import { Heading, Box, jsx } from 'theme-ui'

@connect(state => state.stats)
class ConversationStats extends React.Component {
  constructor(props) {
    super(props)
    var times = dateSetupUtil()
    this.chartSize = 500
    this.chartMargins = { top: 20, right: 20, bottom: 50, left: 70 }
    this.state = Object.assign({}, times)
  }

  handleUntilButtonClicked() {
    const year = this.refs.exportSelectYear.value
    const month = this.refs.exportSelectMonth.value
    const dayOfMonth = this.refs.exportSelectDay.value
    const tz = this.refs.exportSelectHour.value
    const dateString = [month, dayOfMonth, year, tz].join(' ')
    const dddate = new Date(dateString)
    const until = Number(dddate)
    this.setState(
      {
        until: until
      },
      function () {
        this.loadStats()
      }
    )
  }

  loadStats() {
    const { match } = this.props

    var until = this.state.until
    this.props.dispatch(
      populateConversationStatsStore(match.params.conversation_id, until)
    )
  }

  componentWillMount() {
    this.loadStats()
    this.getStatsRepeatedly = setInterval(() => {
      this.loadStats()
    }, 10000)
  }

  componentWillUnmount() {
    clearInterval(this.getStatsRepeatedly)
  }

  render() {
    const { conversation_stats } = this.props
    const loading =
      !conversation_stats.firstCommentTimes ||
      !conversation_stats.firstVoteTimes

    if (loading) return <Box>Loading...</Box>

    return (
      <div>
        <Heading
          as="h3"
          sx={{
            fontSize: [3, null, 4],
            lineHeight: 'body',
            mb: [3, null, 4]
          }}>
          Monitor
        </Heading>
        <NumberCards data={conversation_stats} />
        <Voters
          firstVoteTimes={conversation_stats.firstVoteTimes}
          size={this.chartSize}
          margin={this.chartMargins}
        />
        <Commenters
          firstCommentTimes={conversation_stats.firstCommentTimes}
          size={this.chartSize}
          margin={this.chartMargins}
        />
      </div>
    )
  }
}

export default ConversationStats
