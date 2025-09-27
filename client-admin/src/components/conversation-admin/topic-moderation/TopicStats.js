/* eslint-disable */
// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { connect } from 'react-redux'
import { jsx, Box, Flex, Heading, Text, Card } from 'theme-ui'

const mapStateToProps = (state) => {
  return {
    zid_metadata: state.zid_metadata
  }
}

@connect(mapStateToProps)
class TopicStats extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      stats: null,
      loading: true,
      error: null
    }
  }

  componentDidMount() {
    this.loadStats()
  }

  async loadStats() {
    try {
      this.setState({ loading: true, error: null })
      const conversation_id = this.props.conversation_id

      console.log('TopicStats loadStats - conversation_id:', conversation_id)

      // Fetch moderation statistics
      const response = await fetch(`/api/v3/topicMod/stats?conversation_id=${conversation_id}`)
      const data = await response.json()

      if (data.status === 'success') {
        this.setState({
          stats: data.stats,
          loading: false
        })
      } else {
        this.setState({
          error: data.message || 'Failed to load statistics',
          loading: false
        })
      }
    } catch (err) {
      this.setState({
        error: 'Network error loading statistics',
        loading: false
      })
    }
  }

  renderStatCard(title, value, color = 'primary') {
    return (
      <Card sx={{ p: 3, textAlign: 'center', minWidth: '150px' }}>
        <Text sx={{ fontSize: 3, fontWeight: 'bold', color: color }}>{value}</Text>
        <Text sx={{ fontSize: 1, color: 'textSecondary', mt: 1 }}>{title}</Text>
      </Card>
    )
  }

  render() {
    const { loading, error, stats } = this.state

    if (loading) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text>Loading statistics...</Text>
        </Box>
      )
    }

    if (error) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text sx={{ color: 'error' }}>Error: {error}</Text>
        </Box>
      )
    }

    if (!stats) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Text>No statistics available.</Text>
        </Box>
      )
    }

    const completionRate =
      stats.total_topics > 0
        ? (((stats.total_topics - stats.pending) / stats.total_topics) * 100).toFixed(1)
        : 0

    return (
      <Box>
        <Heading as="h3" sx={{ mb: 4 }}>
          Topic Moderation Statistics
        </Heading>

        <Flex sx={{ gap: 3, mb: 4, flexWrap: 'wrap' }}>
          {this.renderStatCard('Total Topics', stats.total_topics)}
          {this.renderStatCard('Pending', stats.pending, 'gray')}
          {this.renderStatCard('Accepted', stats.accepted, 'green')}
          {this.renderStatCard('Rejected', stats.rejected, 'red')}
          {this.renderStatCard('Meta', stats.meta, 'orange')}
          {this.renderStatCard('Completion Rate', `${completionRate}%`, 'blue')}
        </Flex>

        <Box sx={{ mt: 4 }}>
          <Heading as="h4" sx={{ mb: 3, fontSize: 2 }}>
            Moderation Progress
          </Heading>

          <Box sx={{ bg: 'muted', borderRadius: 'default', p: 3 }}>
            <Flex sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Text sx={{ fontWeight: 'bold' }}>Overall Progress</Text>
              <Text sx={{ fontSize: 1 }}>{completionRate}% Complete</Text>
            </Flex>

            <Box
              sx={{
                bg: 'background',
                borderRadius: 'default',
                overflow: 'hidden',
                height: '20px'
              }}>
              <Flex sx={{ height: '100%' }}>
                <Box
                  sx={{
                    bg: 'green',
                    width: `${stats.total_topics > 0 ? (stats.accepted / stats.total_topics) * 100 : 0}%`,
                    transition: 'width 0.3s ease'
                  }}
                />
                <Box
                  sx={{
                    bg: 'red',
                    width: `${stats.total_topics > 0 ? (stats.rejected / stats.total_topics) * 100 : 0}%`,
                    transition: 'width 0.3s ease'
                  }}
                />
                <Box
                  sx={{
                    bg: 'orange',
                    width: `${stats.total_topics > 0 ? (stats.meta / stats.total_topics) * 100 : 0}%`,
                    transition: 'width 0.3s ease'
                  }}
                />
              </Flex>
            </Box>

            <Flex sx={{ justifyContent: 'space-between', mt: 2, fontSize: 0 }}>
              <Text sx={{ color: 'green' }}>Accepted: {stats.accepted}</Text>
              <Text sx={{ color: 'red' }}>Rejected: {stats.rejected}</Text>
              <Text sx={{ color: 'orange' }}>Meta: {stats.meta}</Text>
              <Text sx={{ color: 'gray' }}>Pending: {stats.pending}</Text>
            </Flex>
          </Box>
        </Box>

        {stats.total_topics === 0 && (
          <Box sx={{ textAlign: 'center', py: 4, mt: 4 }}>
            <Text sx={{ color: 'textSecondary' }}>
              No topics have been generated for this conversation yet.
            </Text>
            <Text sx={{ fontSize: 0, color: 'textSecondary', mt: 2 }}>
              Run the Delphi pipeline to generate topics for moderation.
            </Text>
          </Box>
        )}
      </Box>
    )
  }
}

export default TopicStats
