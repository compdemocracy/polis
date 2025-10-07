// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box } from 'theme-ui'
import { useAuth } from 'react-oidc-context'
import { useParams } from 'react-router'
import { useSelector, useDispatch } from 'react-redux'
import { useState, useEffect, useRef } from 'react'

import { populateConversationStatsStore } from '../../../actions'
import { useConversationData } from '../../../util/conversation_data'
import Commenters from './Commenters'
import dateSetupUtil from '../../../util/data-export-date-setup'
import NumberCards from './NumberCards'
import Voters from './Voters'

const ConversationStats = () => {
  const dispatch = useDispatch()
  const params = useParams()
  const { isAuthenticated, isLoading } = useAuth()
  const stats = useSelector((state) => state.stats)
  const conversationData = useConversationData()
  const { conversation_stats } = stats
  const times = dateSetupUtil()

  // Responsive chart sizing based on viewport
  const getChartSize = () => {
    if (typeof window === 'undefined') return 350
    const width = window.innerWidth
    if (width < 480) return Math.min(width - 64, 350) // Mobile: viewport - padding
    if (width < 768) return 400 // Tablet
    return 500 // Desktop
  }

  const [chartSize, setChartSize] = useState(getChartSize())
  const chartMargins = { top: 20, right: 20, bottom: 50, left: 70 }

  const [state] = useState({
    ...times,
    until: undefined
  })

  const getStatsRepeatedlyRef = useRef(null)

  // Update chart size on window resize
  useEffect(() => {
    const handleResize = () => {
      setChartSize(getChartSize())
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const loadStats = () => {
    const until = state.until
    dispatch(populateConversationStatsStore(params.conversation_id, until))
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
    return () => {
      stopPolling()
    }
  }, [])

  useEffect(() => {
    // Also handle metadata loading and polling logic
    const currentIsMod = conversationData?.is_mod
    const currentConversationId = params?.conversation_id

    // Start polling when metadata is loaded for current conversation and user is mod
    const shouldStartPolling =
      conversationData?.conversation_id === currentConversationId &&
      currentIsMod &&
      !getStatsRepeatedlyRef.current

    if (shouldStartPolling) {
      startPolling()
    }
  }, [isLoading, isAuthenticated, conversationData, params.conversation_id])

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
