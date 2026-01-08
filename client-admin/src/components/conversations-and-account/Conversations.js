// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useState, useEffect, useCallback } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { handleCreateConversationSubmit, populateConversationsStore } from '../../actions'
import PolisNet, { isAuthReady } from '../../util/net'

import Url from '../../util/url'
import { useAuth } from 'react-oidc-context'
import { Box, Heading, Button, Text, Link, Image, Close } from 'theme-ui'
import Conversation from './Conversation'
import { useLocation, useNavigate } from 'react-router'
import { isSuperAdmin } from '../../util/auth'
import Pagination from '../conversation-admin/Pagination'

const Conversations = () => {
  const dispatch = useDispatch()
  const location = useLocation()
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()
  const { conversations, loading, error } = useSelector((state) => state.conversations)

  const userState = useSelector((state) => state.user)
  const superAdmin = isSuperAdmin(userState)

  const [interstitialVisible, setInterstitialVisible] = useState(false)
  const [activeView, setActiveView] = useState('my') // 'my' | 'all'
  const [allConversations, setAllConversations] = useState(null)
  const [allLoading, setAllLoading] = useState(false)
  const [allError, setAllError] = useState(null)
  const [allPagination, setAllPagination] = useState(null)

  const [filters, setFilters] = useState({
    owner_email: '',
    is_active: '', // '', true, false
    recently_updated_days: '',
    recently_created_days: '',
    min_comment_count: '',
    min_participant_count: ''
  })
  const [sort, setSort] = useState({ sort_by: 'updated', sort_dir: 'desc' })

  const [filterState] = useState({
    filterMinParticipantCount: 0,
    sort: 'participant_count'
  })

  const loadConversationsIfNeeded = useCallback(() => {
    const authSystemReady = isAuthReady()

    if (!isLoading && isAuthenticated && authSystemReady) {
      if (activeView === 'my') {
        if (!loading && !conversations) {
          dispatch(populateConversationsStore())
        }
      } else if (activeView === 'all' && superAdmin) {
        if (!allLoading && !allConversations) {
          setAllLoading(true)
          setAllError(null)
          const qs = new URLSearchParams()
          if (filters.owner_email) qs.set('owner_email', filters.owner_email)
          if (filters.is_active !== '') qs.set('is_active', String(filters.is_active))
          if (filters.recently_updated_days)
            qs.set('recently_updated_days', String(filters.recently_updated_days))
          if (filters.recently_created_days)
            qs.set('recently_created_days', String(filters.recently_created_days))
          if (filters.min_comment_count)
            qs.set('min_comment_count', String(filters.min_comment_count))
          if (filters.min_participant_count)
            qs.set('min_participant_count', String(filters.min_participant_count))
          if (sort.sort_by) qs.set('sort_by', sort.sort_by)
          if (sort.sort_dir) qs.set('sort_dir', sort.sort_dir)
          // pagination
          if (allPagination?.limit) qs.set('limit', String(allPagination.limit))
          if (allPagination?.offset !== undefined) qs.set('offset', String(allPagination.offset))

          PolisNet.getAccessTokenSilentlySPA()
            .then((token) =>
              fetch(`/api/v3/all_conversations?${qs.toString()}`, {
                method: 'GET',
                headers: {
                  ...(token && { Authorization: `Bearer ${token}` })
                }
              })
            )
            .then((r) => r.json())
            .then((json) => {
              // API returns { conversations: [], pagination: {...} }
              setAllConversations(json?.conversations || [])
              setAllPagination(json?.pagination || null)
            })
            .catch((e) => setAllError(e))
            .finally(() => setAllLoading(false))
        }
      }
    }
  }, [
    isLoading,
    isAuthenticated,
    loading,
    conversations,
    activeView,
    superAdmin,
    allLoading,
    allConversations,
    dispatch
  ])

  useEffect(() => {
    // Listen for auth ready event
    const handleAuthReady = () => {
      loadConversationsIfNeeded()
    }

    window.addEventListener('polisAuthReady', handleAuthReady)

    if (isAuthenticated && !isLoading) {
      loadConversationsIfNeeded()

      return () => {
        window.removeEventListener('polisAuthReady', handleAuthReady)
      }
    }

    return () => {
      window.removeEventListener('polisAuthReady', handleAuthReady)
    }
  }, [loadConversationsIfNeeded, isAuthenticated, isLoading])

  const onNewClicked = (isActive = true) => {
    dispatch(handleCreateConversationSubmit(navigate, isActive))
  }

  const goToConversation = (conversation_id) => {
    return () => {
      if (location.pathname === 'other-conversations') {
        window.open(`${Url.urlPrefix}${conversation_id}`, '_blank')
        return
      }
      navigate(`/m/${conversation_id}`)
    }
  }

  const filterCheck = (c) => {
    let include = true

    if (c.participant_count < filterState.filterMinParticipantCount) {
      include = false
    }

    if (location.pathname === 'other-conversations') {
      // filter out conversations i do own
      include = !c.is_owner
    }

    if (location.pathname !== 'other-conversations' && !c.is_owner) {
      // if it's not other convos and i'm not the owner, don't show it
      // filter out convos i don't own
      include = false
    }

    return include
  }

  const err = activeView === 'all' ? allError : error

  const renderSwitcher = () => {
    if (!superAdmin) return null
    return (
      <Box sx={{ mb: [3, null, 4] }}>
        <Text
          as="span"
          onClick={() => setActiveView('my')}
          sx={{
            mr: 3,
            cursor: 'pointer',
            fontWeight: activeView === 'my' ? 'bold' : 'normal',
            textDecoration: activeView === 'my' ? 'underline' : 'none'
          }}>
          My Conversations
        </Text>
        <Text
          as="span"
          onClick={() => setActiveView('all')}
          sx={{
            cursor: 'pointer',
            fontWeight: activeView === 'all' ? 'bold' : 'normal',
            textDecoration: activeView === 'all' ? 'underline' : 'none'
          }}>
          All Conversations
        </Text>
      </Box>
    )
  }

  const renderAllControls = () => {
    if (!(activeView === 'all' && superAdmin)) return null
    return (
      <Box sx={{ mb: [3] }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Owner email contains..."
            value={filters.owner_email}
            onChange={(e) => setFilters((f) => ({ ...f, owner_email: e.target.value }))}
          />
          <select
            value={filters.is_active}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                is_active: e.target.value === '' ? '' : e.target.value === 'true'
              }))
            }>
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
          <input
            type="number"
            min="0"
            placeholder="Min comments"
            value={filters.min_comment_count}
            onChange={(e) => setFilters((f) => ({ ...f, min_comment_count: e.target.value }))}
            style={{ width: 120 }}
          />
          <input
            type="number"
            min="0"
            placeholder="Min participants"
            value={filters.min_participant_count}
            onChange={(e) => setFilters((f) => ({ ...f, min_participant_count: e.target.value }))}
            style={{ width: 140 }}
          />
          <input
            type="number"
            min="0"
            placeholder="Updated in last N days"
            value={filters.recently_updated_days}
            onChange={(e) => setFilters((f) => ({ ...f, recently_updated_days: e.target.value }))}
            style={{ width: 200 }}
          />
          <input
            type="number"
            min="0"
            placeholder="Created in last N days"
            value={filters.recently_created_days}
            onChange={(e) => setFilters((f) => ({ ...f, recently_created_days: e.target.value }))}
            style={{ width: 200 }}
          />
          <select
            value={sort.sort_by}
            onChange={(e) => setSort((s) => ({ ...s, sort_by: e.target.value }))}>
            <option value="updated">Sort: Updated</option>
            <option value="created">Sort: Created</option>
            <option value="participant_count">Sort: Participants</option>
            <option value="comment_count">Sort: Comments</option>
          </select>
          <select
            value={sort.sort_dir}
            onChange={(e) => setSort((s) => ({ ...s, sort_dir: e.target.value }))}>
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
          <Button
            onClick={() => {
              setAllConversations(null)
              loadConversationsIfNeeded()
            }}>
            Apply
          </Button>
        </Box>
        {allPagination ? (
          <Pagination
            pagination={allPagination}
            loading={allLoading}
            onPageChange={(newOffset, newLimit) => {
              setAllPagination((p) => ({ ...(p || {}), offset: newOffset, limit: newLimit }))
              setAllConversations(null)
              loadConversationsIfNeeded()
            }}
          />
        ) : null}
      </Box>
    )
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
        All Conversations
      </Heading>
      {interstitialVisible && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            bg: 'rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
          <Box
            sx={{
              bg: 'background',
              p: 4,
              borderRadius: '8px',
              boxShadow: '0 0 20px rgba(0,0,0,0.3)',
              width: ['90%', '70%', '60%'],
              maxWidth: '1200px',
              maxHeight: '90vh',
              overflowY: 'auto',
              position: 'relative'
            }}>
            <Close
              onClick={() => {
                onNewClicked()
                setInterstitialVisible(false)
              }}
              sx={{
                position: 'absolute',
                top: '15px',
                right: '15px',
                cursor: 'pointer',
                color: 'textSecondary'
              }}
            />
            <Heading as="h2" sx={{ mb: 3, fontSize: 5, color: 'primary' }}>
              Introducing Polis 2: AI-Powered Insights
            </Heading>
            <Text sx={{ mb: 4, fontSize: 2, mt: 4 }}>
              Unlock deeper understanding from your conversations with Polis 2, our advanced
              analytics, moderation, and AI reporting suite.
            </Text>

            <Box sx={{ display: 'grid', gridTemplateColumns: ['1fr', '1fr 1fr'], gap: 4, mb: 4 }}>
              <Box>
                <Heading as="h4" sx={{ mb: 2 }}>
                  Advanced Statistical Analysis
                </Heading>
                <Image src="/bg_map.png" sx={{ width: '100%', borderRadius: '4px', mb: 2 }} />
                <Text>
                  Go beyond opinion groups with interactive topic maps and advanced data
                  visualizations. See how ideas connect and identify key areas of contention and
                  consensus.
                </Text>
              </Box>
              <Box>
                <Heading as="h4" sx={{ mb: 2 }}>
                  AI-Generated Reports
                </Heading>
                <Image
                  src="/bg_collective.png"
                  sx={{ width: '100%', borderRadius: '4px', mb: 2 }}
                />
                <Text>
                  Let Polis 2 do the heavy lifting. Get AI-generated summaries, consensus
                  statements, and detailed reports on conversation dynamics and key topics.
                </Text>
              </Box>
            </Box>

            <Box sx={{ bg: 'muted', p: 3, borderRadius: '4px', mb: 4 }}>
              <Heading as="h4" sx={{ mb: 2 }}>
                Key Polis 2 Features:
              </Heading>
              <ul sx={{ pl: 3, m: 0 }}>
                <li>Conversation Summaries</li>
                <li>Automated Topic Reporting</li>
                <li>Identification of Consensus Statements</li>
                <li>Divisive Comment Analysis</li>
              </ul>
            </Box>

            <Text sx={{ mb: 4, textAlign: 'center', fontSize: 2 }}>
              Ready to supercharge your analysis?
              <br />
              <Link
                href="https://pro.pol.is/"
                target="_blank"
                rel="noopener noreferrer"
                sx={{ fontWeight: 'bold' }}>
                Upgrade to a Pro plan to access Polis 2.
              </Link>
            </Text>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3 }}>
              <Button
                variant="secondary"
                onClick={() => {
                  onNewClicked()
                  setInterstitialVisible(false)
                }}
                sx={{
                  cursor: 'pointer'
                }}>
                Maybe Later
              </Button>
              <Button
                onClick={() => {
                  onNewClicked()
                  setInterstitialVisible(false)
                }}
                sx={{
                  cursor: 'pointer',
                  bg: 'primary',
                  '&:hover': {
                    bg: 'text'
                  }
                }}>
                Create Conversation
              </Button>
            </Box>
          </Box>
        </Box>
      )}
      <Box sx={{ mb: [3, null, 4] }}>
        <Button onClick={() => setInterstitialVisible(true)}>Create new conversation</Button>
      </Box>
      {renderSwitcher()}
      {renderAllControls()}
      <Box>
        <Box sx={{ mb: [3] }}>
          {activeView === 'all'
            ? allLoading
              ? 'Loading conversations...'
              : null
            : loading
              ? 'Loading conversations...'
              : null}
        </Box>
        {err ? <Text>{'Error loading conversations'}</Text> : null}
        {activeView === 'all' && superAdmin ? (
          <Box>
            {/* Headers for desktop table view */}
            <Box
              sx={{
                display: ['none', 'grid'],
                gridTemplateColumns: '3fr 1fr 1fr 1.5fr 1.5fr 2fr 1fr',
                gap: 3,
                p: 2,
                borderBottom: '2px solid',
                borderColor: 'lightGray',
                fontWeight: 'bold'
              }}>
              <Text>Topic</Text>
              <Text sx={{ textAlign: 'right' }}>Participants</Text>
              <Text sx={{ textAlign: 'right' }}>Comments</Text>
              <Text sx={{ textAlign: 'right' }}>Updated</Text>
              <Text sx={{ textAlign: 'right' }}>Created</Text>
              <Text>Owner Email</Text>
              <Text sx={{ textAlign: 'center' }}>Active</Text>
            </Box>
            {/* Conversation list (cards on mobile, rows on desktop) */}
            {(allConversations || []).map((c) => (
              <Box
                key={c.conversation_id}
                onClick={goToConversation(c.conversation_id)}
                sx={{
                  cursor: 'pointer',
                  p: 3,
                  border: '1px solid',
                  borderColor: 'lightGray',
                  borderRadius: 4,
                  mb: 3,
                  '&:hover': { bg: 'lightGray' },
                  display: ['block', 'grid'],
                  gap: [2, 3],
                  gridTemplateColumns: [null, '3fr 1fr 1fr 1.5fr 1.5fr 2fr 1fr'],
                  alignItems: 'center',
                  // Reset some card styles for table view
                  '@media (min-width: 48em)': {
                    border: 'none',
                    borderBottom: '1px solid',
                    borderRadius: 0,
                    mb: 0,
                    p: 2
                  }
                }}>
                <Box>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Topic: </Text>
                  {c.topic}
                </Box>
                <Box sx={{ textAlign: [null, 'right'] }}>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>
                    Participants:{' '}
                  </Text>
                  {c.participant_count || 0}
                </Box>
                <Box sx={{ textAlign: [null, 'right'] }}>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Comments: </Text>
                  {c.comment_count || 0}
                </Box>
                <Box sx={{ textAlign: [null, 'right'] }}>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Updated: </Text>
                  {new Date(c.modified).toLocaleDateString('en-US', {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  })}
                </Box>
                <Box sx={{ textAlign: [null, 'right'] }}>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Created: </Text>
                  {new Date(c.created).toLocaleDateString('en-US', {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  })}
                </Box>
                <Box>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Owner: </Text>
                  {c.owner_email || ''}
                </Box>
                <Box sx={{ textAlign: 'center' }}>
                  <Text sx={{ display: ['inline', 'none'], fontWeight: 'bold' }}>Active: </Text>
                  {c.is_active ? '✅' : '❌'}
                </Box>
              </Box>
            ))}
          </Box>
        ) : conversations ? (
          conversations.map((c, i) => {
            return filterCheck(c) ? (
              <Conversation
                key={c.conversation_id}
                c={c}
                i={i}
                goToConversation={goToConversation(c.conversation_id)}
              />
            ) : null
          })
        ) : null}
      </Box>
    </Box>
  )
}

export default Conversations
