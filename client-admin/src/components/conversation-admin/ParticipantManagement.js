import { Heading, Box, Text, Flex, Button } from 'theme-ui'
import { useParams } from 'react-router'
import { useEffect, useMemo, useState } from 'react'
import { useDispatch } from 'react-redux'

import { useConversationData } from '../../util/conversation_data'
import { handleConversationDataUpdate } from '../../actions'
import Pagination from './Pagination'
import XidsInUseTable from './ParticipantManagement/XidsInUseTable.js'
import XidAllowListTable from './ParticipantManagement/XidAllowListTable.js'
import PolisNet from '../../util/net'
import Spinner from '../framework/Spinner'

const XID_ALLOW_LIST_FIXED = 'polis_err_xid_whitelist_fixed_after_start'

// The words for a refused settings change. The one refusal the owner can act on
// gets its own sentence; any other failure gets a plain one with no detail.
export const settingErrorMessage = (error) => {
  if (!error) return null
  if (error.status === 409 && String(error.responseText || '').includes(XID_ALLOW_LIST_FIXED)) {
    return "This setting can't change once participants have joined. Start a new conversation to use a different setting."
  }
  return "Couldn't save this change."
}

const ParticipantManagement = () => {
  const params = useParams()
  const conversationData = useConversationData()
  const dispatch = useDispatch()
  const conversationId = useMemo(
    () => conversationData?.conversation_id || params.conversation_id,
    [conversationData?.conversation_id, params.conversation_id]
  )

  const [xids, setXids] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [limit] = useState(50)

  const useXidAllowList = Boolean(conversationData?.use_xid_whitelist)
  const xidRequired = Boolean(conversationData?.xid_required)
  const [activeTab, setActiveTab] = useState('inUse') // 'inUse' | 'allowList'

  // The setting last changed from this screen; a refused update is shown under
  // it. The store clears the error when the next update starts.
  const [changedSetting, setChangedSetting] = useState(null)
  const settingError = settingErrorMessage(conversationData?.error)
  const errorFor = (field) =>
    changedSetting === field && settingError ? (
      <Text data-testid={`${field}_error`} sx={{ ml: [2], color: 'error', fontSize: [0] }}>
        {settingError}
      </Text>
    ) : null

  const handleXidAllowListToggle = () => {
    const newValue = !useXidAllowList
    setChangedSetting('use_xid_whitelist')
    dispatch(handleConversationDataUpdate(conversationData, 'use_xid_whitelist', newValue))
  }

  const handleXidRequiredToggle = () => {
    const newValue = !xidRequired
    setChangedSetting('xid_required')
    dispatch(handleConversationDataUpdate(conversationData, 'xid_required', newValue))
  }

  const loadXids = async (newOffset = 0) => {
    if (!conversationId) return
    setLoading(true)
    setError(null)

    try {
      const res = await PolisNet.polisGet('/api/v3/xids', {
        conversation_id: conversationId,
        limit,
        offset: newOffset
      })

      setXids(res?.xids || [])
      setPagination(res?.pagination || null)
    } catch (e) {
      setError(e?.responseText || e?.message || 'Failed to load XIDs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (conversationId) {
      loadXids(0)
    }
  }, [conversationId])

  const handlePageChange = (newOffset) => {
    loadXids(newOffset)
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
        Participant Management
      </Heading>
      <Text sx={{ mb: [3] }}>Manage participants for conversation {conversationId}.</Text>

      <Flex sx={{ alignItems: 'flex-start', mb: [2] }}>
        <Box sx={{ flexShrink: 0, position: 'relative', top: -0.5 }}>
          <input
            type="checkbox"
            data-testid="xid_required"
            checked={xidRequired}
            onChange={handleXidRequiredToggle}
            disabled={useXidAllowList}
          />
        </Box>
        <Box
          sx={{
            ml: [2],
            flex: '1 1 auto',
            maxWidth: ['100%', '100%', '35em'],
            wordWrap: 'break-word',
            overflowWrap: 'break-word'
          }}>
          <Text>XID Required to Vote</Text>
          {useXidAllowList && (
            <Text sx={{ ml: [2], color: 'mediumGray', fontSize: [0] }}>
              Required because XID Allow List is enabled.
            </Text>
          )}
          {errorFor('xid_required')}
        </Box>
      </Flex>

      <Flex sx={{ alignItems: 'flex-start', mb: [3] }}>
        <Box sx={{ flexShrink: 0, position: 'relative', top: -0.5 }}>
          <input
            type="checkbox"
            data-testid="use_xid_whitelist"
            checked={useXidAllowList}
            onChange={handleXidAllowListToggle}
          />
        </Box>
        <Box
          sx={{
            ml: [2],
            flex: '1 1 auto',
            maxWidth: ['100%', '100%', '35em'],
            wordWrap: 'break-word',
            overflowWrap: 'break-word'
          }}>
          <Text>Use XID Allow List</Text>
          {errorFor('use_xid_whitelist')}
        </Box>
      </Flex>

      {/* Tab controls */}
      <Flex sx={{ gap: [2], mb: [3], flexWrap: 'wrap' }}>
        <Button
          variant={activeTab === 'inUse' ? 'primary' : 'outline'}
          size="small"
          onClick={() => setActiveTab('inUse')}>
          XIDs in Use
        </Button>
        <Button
          variant={activeTab === 'allowList' ? 'primary' : 'outline'}
          size="small"
          onClick={() => setActiveTab('allowList')}>
          XIDs Allowed
        </Button>
      </Flex>

      {activeTab === 'inUse' && loading && !xids.length ? (
        <Spinner />
      ) : activeTab === 'inUse' && error ? (
        <Text sx={{ color: 'error', mb: [3] }}>{error}</Text>
      ) : activeTab === 'inUse' && xids.length === 0 ? (
        <Text sx={{ color: 'mediumGray', mb: [3] }}>No XIDs found for this conversation.</Text>
      ) : activeTab === 'inUse' ? (
        <>
          <XidsInUseTable xids={xids} conversationId={conversationId} />
          <Pagination pagination={pagination} onPageChange={handlePageChange} loading={loading} />
        </>
      ) : (
        <XidAllowListTable conversationId={conversationId} />
      )}
    </Box>
  )
}

export default ParticipantManagement
