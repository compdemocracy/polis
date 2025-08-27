import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { Heading, Box, Text, Button, Select } from 'theme-ui'
import { useParams } from 'react-router'
import PolisNet from '../../util/net'
import Spinner from '../framework/spinner'
import Pagination from './Pagination'

const InviteCodes = () => {
  const params = useParams()
  const zid_metadata = useSelector((state) => state.zid_metadata)
  const enabled = Boolean(zid_metadata?.zid_metadata?.treevite_enabled)
  const conversationId = useMemo(
    () => zid_metadata?.zid_metadata?.conversation_id || params.conversation_id,
    [zid_metadata?.zid_metadata?.conversation_id, params.conversation_id]
  )

  const [invites, setInvites] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Filtering and pagination state
  const [waveFilter, setWaveFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)

  // Available waves for filter dropdown
  const [availableWaves, setAvailableWaves] = useState([])

  const loadInvites = async (newOffset = offset, resetOffset = false) => {
    if (!conversationId) return
    setLoading(true)
    setError(null)

    const actualOffset = resetOffset ? 0 : newOffset

    try {
      const params = {
        conversation_id: conversationId,
        limit,
        offset: actualOffset
      }

      if (waveFilter) params.wave_id = parseInt(waveFilter)
      if (statusFilter !== '') params.status = parseInt(statusFilter)

      const res = await PolisNet.polisGet('/api/v3/treevite/invites', params)

      setInvites(res?.invites || [])
      setPagination(res?.pagination || null)
      if (resetOffset) setOffset(0)
      else setOffset(actualOffset)
    } catch (e) {
      setError(e?.responseText || e?.message || 'Failed to load invite codes')
    } finally {
      setLoading(false)
    }
  }

  const loadWaves = async () => {
    if (!conversationId) return
    try {
      const res = await PolisNet.polisGet('/api/v3/treevite/waves', {
        conversation_id: conversationId
      })
      setAvailableWaves(Array.isArray(res) ? res : [])
    } catch {
      // Silently fail - waves are just for filtering
    }
  }

  useEffect(() => {
    if (enabled) {
      loadWaves()
      loadInvites(0, true)
    }
  }, [enabled, conversationId])

  useEffect(() => {
    if (enabled) {
      loadInvites(0, true)
    }
  }, [waveFilter, statusFilter])

  const handlePageChange = (newOffset, newLimit) => {
    loadInvites(newOffset)
  }

  const handleClearFilters = () => {
    setWaveFilter('')
    setStatusFilter('')
  }

  const getStatusText = (status) => {
    switch (status) {
      case 0:
        return 'Unused'
      case 1:
        return 'Used'
      case 2:
        return 'Revoked'
      case 3:
        return 'Expired'
      default:
        return `Status ${status}`
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 0:
        return 'green'
      case 1:
        return 'blue'
      case 2:
        return 'red'
      case 3:
        return 'orange'
      default:
        return 'gray'
    }
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
        Invite Codes
      </Heading>

      {!enabled ? (
        <Text>
          Invite Tree is not enabled. To use this feature, enable Invite Tree in the Conversation
          Configure options.
        </Text>
      ) : (
        <>
          <Box sx={{ mb: [3] }}>
            <Text sx={{ display: 'block', mb: [2] }}>
              These are the invite codes for the owner of this conversation.
            </Text>
          </Box>

          {/* Filters */}
          <Box sx={{ mb: [3], p: [3], bg: 'lightGray', borderRadius: 2 }}>
            <Text sx={{ fontWeight: 'bold', mb: [2] }}>Filters</Text>
            <Box sx={{ display: 'flex', gap: [3], alignItems: 'end', flexWrap: 'wrap' }}>
              <Box>
                <Text sx={{ display: 'block', mb: [1], fontSize: [1] }}>Wave</Text>
                <Select
                  value={waveFilter}
                  onChange={(e) => setWaveFilter(e.target.value)}
                  sx={{ minWidth: '120px' }}>
                  <option value="">All waves</option>
                  {availableWaves.map((wave) => (
                    <option key={wave.id} value={wave.wave}>
                      Wave {wave.wave}
                    </option>
                  ))}
                </Select>
              </Box>

              <Box>
                <Text sx={{ display: 'block', mb: [1], fontSize: [1] }}>Status</Text>
                <Select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  sx={{ minWidth: '140px' }}>
                  <option value="">All statuses</option>
                  <option value="0">Unused</option>
                  <option value="1">Used</option>
                  <option value="2">Revoked</option>
                  <option value="3">Expired</option>
                </Select>
              </Box>

              {(waveFilter || statusFilter !== '') && (
                <Button variant="outline" onClick={handleClearFilters} sx={{ fontSize: [1] }}>
                  Clear Filters
                </Button>
              )}
            </Box>
          </Box>

          {loading ? (
            <Spinner />
          ) : error ? (
            <Text sx={{ color: 'red' }}>{String(error)}</Text>
          ) : invites.length > 0 ? (
            <Box>
              <Text sx={{ mb: [2], fontWeight: 'bold' }}>
                {pagination?.total
                  ? `Found ${pagination.total} invite code${pagination.total !== 1 ? 's' : ''}:`
                  : `Found ${invites.length} invite code${invites.length !== 1 ? 's' : ''}:`}
              </Text>
              <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th
                      sx={{
                        textAlign: 'left',
                        borderBottom: '1px solid',
                        borderColor: 'mediumGray',
                        pb: [2],
                        pr: [3]
                      }}>
                      Code
                    </th>
                    <th
                      sx={{
                        textAlign: 'left',
                        borderBottom: '1px solid',
                        borderColor: 'mediumGray',
                        pb: [2],
                        pr: [3]
                      }}>
                      Wave
                    </th>
                    <th
                      sx={{
                        textAlign: 'left',
                        borderBottom: '1px solid',
                        borderColor: 'mediumGray',
                        pb: [2],
                        pr: [3]
                      }}>
                      Status
                    </th>
                    <th
                      sx={{
                        textAlign: 'left',
                        borderBottom: '1px solid',
                        borderColor: 'mediumGray',
                        pb: [2]
                      }}>
                      Used At
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <tr key={invite.id}>
                      <td
                        sx={{
                          borderBottom: '1px solid',
                          borderColor: 'lightGray',
                          py: [2],
                          pr: [3],
                          fontFamily: 'monospace',
                          fontSize: [1]
                        }}>
                        {invite.invite_code}
                      </td>
                      <td
                        sx={{
                          borderBottom: '1px solid',
                          borderColor: 'lightGray',
                          py: [2],
                          pr: [3]
                        }}>
                        {invite.wave || 'N/A'}
                      </td>
                      <td
                        sx={{
                          borderBottom: '1px solid',
                          borderColor: 'lightGray',
                          py: [2],
                          pr: [3],
                          color: getStatusColor(invite.status),
                          fontWeight: 'bold'
                        }}>
                        {getStatusText(invite.status)}
                      </td>
                      <td
                        sx={{
                          borderBottom: '1px solid',
                          borderColor: 'lightGray',
                          py: [2]
                        }}>
                        {invite.invite_used_at
                          ? new Date(invite.invite_used_at).toLocaleString()
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Box>

              <Pagination
                pagination={pagination}
                onPageChange={handlePageChange}
                loading={loading}
              />
            </Box>
          ) : (
            <Text>
              No invite codes found. Create waves in the Invite Tree section to generate codes.
            </Text>
          )}
        </>
      )}
    </Box>
  )
}

export default InviteCodes
