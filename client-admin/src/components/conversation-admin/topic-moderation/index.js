/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../NoPermission'
import React, { useEffect, useRef } from 'react'
import { useSelector } from 'react-redux'
import { Heading, Flex, Box } from 'theme-ui'
import { Routes, Route, Link, useParams, useLocation } from 'react-router-dom'
import { useUser } from '../../../util/auth'

import TopicTree from './TopicTree'
import TopicStats from './TopicStats'
import ProximityVisualization from './ProximityVisualization'
import TopicDetail from './TopicDetail'

const pollFrequency = 60000

const TopicModeration = () => {
  const params = useParams()
  const location = useLocation()
  const user = useUser()
  const zid_metadata = useSelector((state) => state.zid_metadata)
  const topics = useSelector((state) => state.topic_mod_topics)
  const stats = useSelector((state) => state.topic_mod_stats)
  const getTopicsRepeatedly = useRef(null)

  const loadTopics = () => {
    // Dispatch actions to load topics data
    // TODO: Implement actions for loading topic moderation data
    console.log('Loading topics for conversation:', params.conversation_id)
  }

  useEffect(() => {
    loadTopics()
    // Temporarily disable polling to debug crash
    // getTopicsRepeatedly.current = setInterval(() => {
    //   loadTopics()
    // }, pollFrequency)

    return () => {
      clearInterval(getTopicsRepeatedly.current)
    }
  }, [params.conversation_id])

  // Check if zid_metadata is still loading
  if (!zid_metadata || zid_metadata.loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <div>Loading...</div>
      </Box>
    )
  }

  if (
    ComponentHelpers.shouldShowPermissionsError({
      user: user,
      zid_metadata: zid_metadata,
      loading: zid_metadata.loading
    })
  ) {
    return <NoPermission />
  }

  const { conversation_id } = params
  const baseUrl = `/m/${conversation_id}/topics`
  const url = location.pathname.split('/')[4]

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Topic Moderation
      </Heading>
      <Flex sx={{ mb: [4] }}>
        <Link
          sx={{
            mr: [4],
            variant: url ? 'links.nav' : 'links.activeNav'
          }}
          to={baseUrl}>
          Topics Tree
        </Link>
        <Link
          sx={{
            mr: [4],
            variant: url === 'proximity' ? 'links.activeNav' : 'links.nav'
          }}
          to={`${baseUrl}/proximity`}>
          Proximity Map
        </Link>
        <Link
          sx={{
            mr: [4],
            variant: url === 'stats' ? 'links.activeNav' : 'links.nav'
          }}
          to={`${baseUrl}/stats`}>
          Statistics
        </Link>
      </Flex>
      <Box>
        <Routes>
          <Route path="/" element={<TopicTree conversation_id={conversation_id} />} />
          <Route path="proximity" element={<ProximityVisualization />} />
          <Route path="stats" element={<TopicStats conversation_id={conversation_id} />} />
          <Route path="topic/:topicKey" element={<TopicDetail />} />
        </Routes>
      </Box>
    </Box>
  )
}

export default TopicModeration
