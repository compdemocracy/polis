// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import dateSetupUtil from '../../../util/data-export-date-setup'
import { useState, useEffect, useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { populateConversationStatsStore, populateZidMetadataStore } from '../../../actions'
import { useAuth } from 'react-oidc-context'
import NumberCards from './conversation-stats-number-cards'
import Voters from './voters'
import Commenters from './commenters'
import { Heading, Box } from 'theme-ui'
import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import { useParams } from 'react-router'

const ConversationStats = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const { isAuthenticated, isLoading } = useAuth()

  const stats = useSelector((state) => state.stats)
  const zid_metadata = useSelector((state) => state.zid_metadata)
  const { conversation_stats } = stats

  const times = dateSetupUtil()
  const chartSize = 500
  const chartMargins = { top: 20, right: 20, bottom: 50, left: 70 }

  const [state] = useState({
    ...times,
    until: undefined
  })

  const getStatsRepeatedlyRef = useRef(null)

  const loadStats = () => {
    const until = state.until
    dispatch(populateConversationStatsStore(params.conversation_id, until))
  }

  const loadInitialData = () => {
    dispatch(populateZidMetadataStore(params.conversation_id))
  }

  const loadInitialDataIfNeeded = () => {
    // Only load if we have a conversation ID and Auth is ready (not loading)
    if (params.conversation_id && !isLoading) {
      loadInitialData()
    }
  }

  const stopPolling = () => {
    if (getStatsRepeatedlyRef.current) {
      clearInterval(getStatsRepeatedlyRef.current)
      getStatsRepeatedlyRef.current = null
    }
  }

  const startPolling = () => {
    // Clear any existing interval
    stopPolling()

    // Initial load
    loadStats()

    // Start polling
    getStatsRepeatedlyRef.current = setInterval(() => {
      loadStats()
    }, 10000)
  }

  useEffect(() => {
    // Check if we already have metadata loaded for this conversation
    if (
      zid_metadata?.zid_metadata?.conversation_id === params.conversation_id &&
      zid_metadata?.zid_metadata?.is_mod
    ) {
      startPolling()
    } else {
      // Try to load initial data when component mounts
      loadInitialDataIfNeeded()
    }

    return () => {
      stopPolling()
    }
  }, [])

  useEffect(() => {
    // Try again if auth state changes
    loadInitialDataIfNeeded()

    // Also handle metadata loading and polling logic
    const currentIsMod = zid_metadata?.zid_metadata?.is_mod
    const currentConversationId = params?.conversation_id

    // Start polling when metadata is loaded for current conversation and user is mod
    const shouldStartPolling =
      zid_metadata?.zid_metadata?.conversation_id === currentConversationId &&
      currentIsMod &&
      !getStatsRepeatedlyRef.current

    if (shouldStartPolling) {
      startPolling()
    }
  }, [isLoading, isAuthenticated, zid_metadata, params.conversation_id])

  if (
    ComponentHelpers.shouldShowPermissionsError({
      zid_metadata: zid_metadata.zid_metadata,
      loading: zid_metadata.loading || stats.loading
    })
  ) {
    return <NoPermission />
  }

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
        size={chartSize}
        margin={chartMargins}
      />
      <Commenters
        firstCommentTimes={conversation_stats.firstCommentTimes}
        size={chartSize}
        margin={chartMargins}
      />
    </div>
  )
}

export default ConversationStats
