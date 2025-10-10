// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box, Button, Text, Flex } from 'theme-ui'
import { useAuth } from 'react-oidc-context'
import { useParams } from 'react-router'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'

import { hasDelphiEnabled, isAdminOrMod, useUser } from '../../../util/auth'
import { useConversationData } from '../../../util/conversation_data'
import PolisNet from '../../../util/net'
import Url from '../../../util/url'

const modMap = {
  0: 'Showing only moderated comments',
  '-1': 'Showing moderated and unmoderated comments',
  '-2': 'Showing all comments, including those moderated out'
}

const formatTimestamp = (timestamp) => {
  const date = new Date(parseInt(timestamp))
  const now = new Date()
  const diffMs = now - date
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffMinutes = Math.floor(diffMs / (1000 * 60))

  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`
  } else {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
}

const ReportLink = ({ title, href, urlPrefix }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: ['column', 'row', 'row'],
      alignItems: ['flex-start', 'center', 'center'],
      mb: [2, 1, 1]
    }}>
    <Text
      sx={{
        fontSize: [1],
        color: 'textSecondary',
        mb: [1, 0, 0],
        mr: [0, 2, 2]
      }}>
      {title}:
    </Text>
    <a
      target="_blank"
      rel="noreferrer"
      href={href}
      sx={{
        color: 'primary',
        textDecoration: 'none',
        fontSize: [0, 1, 1],
        '&:hover': {
          textDecoration: 'underline'
        }
      }}>
      {urlPrefix}
    </a>
  </Box>
)

ReportLink.propTypes = {
  title: PropTypes.string.isRequired,
  href: PropTypes.string.isRequired,
  urlPrefix: PropTypes.string.isRequired
}

const ReportsList = () => {
  const params = useParams()
  const { isAuthenticated, user: authUser } = useAuth()
  const userContext = useUser()
  const conversationData = useConversationData()
  const [mod_level, setModLevel] = useState(-2)

  const [state, setState] = useState({
    loading: true,
    reports: [],
    dataLoaded: false
  })

  const [expandedReports, setExpandedReports] = useState(new Set())

  const getData = () => {
    const reportsPromise = PolisNet.polisGet('/api/v3/reports', {
      conversation_id: params.conversation_id
    })
    reportsPromise.then((reports) => {
      setState({
        loading: false,
        reports: reports,
        dataLoaded: true
      })
    })
  }

  useEffect(() => {
    // Load data if user is now a moderator and data hasn't been loaded
    if (!state.dataLoaded && isAdminOrMod(userContext, conversationData)) {
      getData()
    }
  }, [conversationData, isAuthenticated, userContext, state.dataLoaded])

  const createReportClicked = () => {
    PolisNet.polisPost('/api/v3/reports', {
      conversation_id: params.conversation_id,
      mod_level
    }).then(() => {
      getData()
    })
  }

  const toggleReportExpansion = (reportId) => {
    setExpandedReports((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(reportId)) {
        newSet.delete(reportId)
      } else {
        newSet.add(reportId)
      }
      return newSet
    })
  }

  if (state.loading) {
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
        Reports
      </Heading>
      <Box sx={{ mb: [3, null, 4] }}>
        {hasDelphiEnabled(authUser) && (
          <Box>
            Select which comments will be visible in this report:
            <select
              defaultValue={-2}
              onChange={(e) => setModLevel(e.target.value)}
              style={{ display: 'block', margin: '1em 0' }}>
              <option value={-2}>Include all comments</option>
              <option value={-1}>Include all comments except for moderation rejections</option>
              <option value={0}>Include only moderator accepted comments</option>
            </select>
          </Box>
        )}
        <Button onClick={createReportClicked}>Create report url</Button>
      </Box>
      {state.reports
        .sort((a, b) => parseInt(b.modified) - parseInt(a.modified))
        .map((report) => {
          const isExpanded = expandedReports.has(report.report_id)
          const handleCardClick = () => {
            toggleReportExpansion(report.report_id)
          }

          return (
            <Box key={report.report_id} sx={{ mb: [3] }}>
              <Box
                data-testid="report-list-item"
                sx={{
                  variant: 'cards.primary',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    boxShadow: 'md',
                    transform: 'translateY(-2px)'
                  }
                }}
                onClick={handleCardClick}>
                <Flex sx={{ flexDirection: 'column', mb: [2] }}>
                  <Text
                    sx={{
                      fontSize: [2, 3],
                      fontWeight: 'bold',
                      color: 'text',
                      mb: [1]
                    }}>
                    Modified {formatTimestamp(report.modified)}
                  </Text>
                  <Text
                    sx={{
                      fontSize: [1],
                      color: 'textSecondary',
                      fontStyle: 'italic'
                    }}>
                    Report ID: {report.report_id}
                  </Text>
                </Flex>

                {hasDelphiEnabled(authUser) && (
                  <Box sx={{ mt: [2] }}>
                    <Text
                      sx={{
                        fontSize: [1],
                        color: 'textSecondary',
                        fontStyle: 'italic'
                      }}>
                      {modMap[String(report.mod_level)] || modMap[Number(report.mod_level)]}
                    </Text>
                  </Box>
                )}
              </Box>

              {/* Expandable Panel */}
              {isExpanded && (
                <Box
                  sx={{
                    variant: 'cards.compact',
                    mt: [2],
                    overflowX: 'auto',
                    animation: 'slideDown 0.3s ease-out',
                    '@keyframes slideDown': {
                      from: {
                        opacity: 0,
                        transform: 'translateY(-10px)',
                        maxHeight: 0
                      },
                      to: {
                        opacity: 1,
                        transform: 'translateY(0)',
                        maxHeight: '200px'
                      }
                    }
                  }}>
                  <Text
                    sx={{
                      fontSize: [1],
                      fontWeight: 'bold',
                      color: 'text',
                      mb: [2]
                    }}>
                    Report URLs
                  </Text>
                  <ReportLink
                    title="Standard Report"
                    href={`${Url.reportUrlPrefix}report/${report.report_id}`}
                    urlPrefix={`${Url.reportUrlPrefix}report/${report.report_id}`}
                  />
                  <ReportLink
                    title="Data Export"
                    href={`${Url.reportUrlPrefix}exportReport/${report.report_id}`}
                    urlPrefix={`${Url.reportUrlPrefix}exportReport/${report.report_id}`}
                  />
                  {hasDelphiEnabled(authUser) && (
                    <>
                      <ReportLink
                        title="Topic"
                        href={`${Url.reportUrlPrefix}topicReport/${report.report_id}`}
                        urlPrefix={`${Url.reportUrlPrefix}topicReport/${report.report_id}`}
                      />
                      <ReportLink
                        title="Topics Viz"
                        href={`${Url.reportUrlPrefix}topicsVizReport/${report.report_id}`}
                        urlPrefix={`${Url.reportUrlPrefix}topicsVizReport/${report.report_id}`}
                      />
                      <ReportLink
                        title="Topic Stats"
                        href={`${Url.reportUrlPrefix}topicStats/${report.report_id}`}
                        urlPrefix={`${Url.reportUrlPrefix}topicStats/${report.report_id}`}
                      />
                      <ReportLink
                        title="Topic Map Narrative"
                        href={`${Url.reportUrlPrefix}topicMapNarrativeReport/${report.report_id}`}
                        urlPrefix={`${Url.reportUrlPrefix}topicMapNarrativeReport/${report.report_id}`}
                      />
                    </>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
    </Box>
  )
}

export default ReportsList
