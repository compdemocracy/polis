// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import dateSetupUtil from '../../../util/data-export-date-setup'
import React from 'react'
import { connect } from 'react-redux'
import { populateConversationStatsStore, populateZidMetadataStore } from '../../../actions'
import { withAuth0 } from '@auth0/auth0-react'
import NumberCards from './conversation-stats-number-cards'
import Voters from './voters'
import Commenters from './commenters'
import { Heading, Box, jsx } from 'theme-ui'
import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import { useParams } from 'react-router'
import PropTypes from 'prop-types'

@connect((state) => state.stats)
@connect((state) => state.zid_metadata)
@connect((state) => state.stats)
class ConversationStats extends React.Component {
  constructor(props) {
    super(props)
    const times = dateSetupUtil()
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
    const { params } = this.props

    const until = this.state.until
    this.props.dispatch(populateConversationStatsStore(params.conversation_id, until))
  }

  componentDidMount() {
    // Check if we already have metadata loaded for this conversation
    const { zid_metadata, params } = this.props
    if (zid_metadata?.conversation_id === params.conversation_id && zid_metadata?.is_mod) {
      this.startPolling()
    } else {
      // Try to load initial data when component mounts
      this.loadInitialDataIfNeeded()
    }
  }

  componentDidUpdate(prevProps) {
    // Try again if auth state changes
    const authStateChanged =
      prevProps.auth0?.isLoading !== this.props.auth0?.isLoading ||
      prevProps.auth0?.isAuthenticated !== this.props.auth0?.isAuthenticated

    if (authStateChanged) {
      this.loadInitialDataIfNeeded()
    }

    // Also handle metadata loading and polling logic
    const { zid_metadata, params } = this.props
    const prevIsMod = prevProps.zid_metadata?.is_mod
    const currentIsMod = zid_metadata?.is_mod
    const prevConversationId = prevProps.params?.conversation_id
    const currentConversationId = params?.conversation_id

    // Start polling when:
    // 1. is_mod changes from false/undefined to true, OR
    // 2. conversation changes and user is mod, OR
    // 3. metadata is loaded for current conversation and user is mod but polling hasn't started
    const shouldStartPolling =
      zid_metadata?.conversation_id === currentConversationId &&
      currentIsMod &&
      !this.getStatsRepeatedly &&
      ((!prevIsMod && currentIsMod) ||
        prevConversationId !== currentConversationId ||
        prevProps.zid_metadata?.conversation_id !== currentConversationId)

    if (shouldStartPolling) {
      this.startPolling()
    }
  }

  loadInitialDataIfNeeded() {
    // Only load if we have a conversation ID and Auth0 is ready (not loading)
    if (this.props.params.conversation_id && this.props.auth0 && !this.props.auth0.isLoading) {
      this.loadInitialData()
    }
  }

  loadInitialData() {
    this.props.dispatch(populateZidMetadataStore(this.props.params.conversation_id))

    // Don't check zid_metadata?.is_mod here since the dispatch is async
    // Let componentDidUpdate handle starting polling once metadata loads
  }

  componentWillUnmount() {
    this.stopPolling()
  }

  stopPolling() {
    if (this.getStatsRepeatedly) {
      clearInterval(this.getStatsRepeatedly)
    }
  }

  startPolling() {
    // Clear any existing interval
    if (this.getStatsRepeatedly) {
      clearInterval(this.getStatsRepeatedly)
    }

    // Initial load
    this.loadStats()

    // Start polling
    this.getStatsRepeatedly = setInterval(() => {
      this.loadStats()
    }, 10000)
  }

  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />
    }

    const { conversation_stats } = this.props
    const loading = !conversation_stats.firstCommentTimes || !conversation_stats.firstVoteTimes

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

ConversationStats.propTypes = {
  dispatch: PropTypes.func,
  zid_metadata: PropTypes.object,
  conversation_stats: PropTypes.object,
  auth0: PropTypes.object,
  params: PropTypes.shape({
    conversation_id: PropTypes.string
  })
}

const ConversationStatsWrapper = (props) => {
  const params = useParams()
  return <ConversationStats {...props} params={params} />
}

export default withAuth0(ConversationStatsWrapper)
