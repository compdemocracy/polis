// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import React from 'react'
import { connect } from 'react-redux'
import { Heading, Flex, Box, jsx } from 'theme-ui'
import { Switch, Route, Link } from 'react-router-dom'

import TopicTree from './topic-tree'
import TopicDetail from './topic-detail'
import TopicStats from './topic-stats'
import ProximityVisualization from './proximity-visualization'

const mapStateToProps = (state, ownProps) => {
  return {
    topics: state.topic_mod_topics,
    stats: state.topic_mod_stats,
    zid_metadata: state.zid_metadata
  }
}

const pollFrequency = 60000

@connect((state) => state.zid_metadata)
@connect(mapStateToProps)
class TopicModeration extends React.Component {
  loadTopics() {
    // Dispatch actions to load topics data
    // TODO: Implement actions for loading topic moderation data
    console.log('Loading topics for conversation:', this.props.conversation_id)
  }

  componentDidMount() {
    this.loadTopics()
    // Temporarily disable polling to debug crash
    // this.getTopicsRepeatedly = setInterval(() => {
    //   this.loadTopics()
    // }, pollFrequency)
  }

  componentWillUnmount() {
    clearInterval(this.getTopicsRepeatedly)
  }

  render() {
    // Check if zid_metadata is still loading
    if (!this.props.zid_metadata || this.props.zid_metadata.loading) {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <div>Loading...</div>
        </Box>
      )
    }
    
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />
    }
    
    const { match, location } = this.props
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
            to={`${match.url}`}>
            Topics Tree
          </Link>
          <Link
            sx={{
              mr: [4],
              variant: url === 'proximity' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${match.url}/proximity`}>
            Proximity Map
          </Link>
          <Link
            sx={{
              mr: [4],
              variant: url === 'stats' ? 'links.activeNav' : 'links.nav'
            }}
            to={`${match.url}/stats`}>
            Statistics
          </Link>
        </Flex>
        <Box>
          <Switch>
            <Route
              exact
              path={`${match.url}`}
              render={(props) => <TopicTree {...props} conversation_id={this.props.conversation_id} />}
            />
            <Route
              exact
              path={`${match.url}/proximity`}
              render={() => <div>Proximity Visualization Coming Soon</div>}
            />
            <Route
              exact
              path={`${match.url}/stats`}
              render={(props) => <TopicStats {...props} conversation_id={this.props.conversation_id} />}
            />
            <Route
              exact
              path={`${match.url}/topic/:topicKey`}
              render={() => <div>Topic Detail Coming Soon</div>}
            />
          </Switch>
        </Box>
      </Box>
    )
  }
}

export default TopicModeration