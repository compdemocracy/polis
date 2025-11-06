import { Box, Text } from 'theme-ui'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import PolisNet from '../../../util/net'
import Spinner from '../../framework/Spinner'
import Pagination from '../Pagination'

const XidAllowListTable = ({ conversationId }) => {
  const [xids, setXids] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [limit] = useState(50)

  const loadXidAllowList = async (newOffset = 0) => {
    if (!conversationId) return
    setLoading(true)
    setError(null)

    try {
      const res = await PolisNet.polisGet('/api/v3/xidAllowList', {
        conversation_id: conversationId,
        limit,
        offset: newOffset
      })

      setXids(res?.xids || [])
      setPagination(res?.pagination || null)
    } catch (e) {
      setError(e?.responseText || e?.message || 'Failed to load XID Allow List')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (conversationId) {
      loadXidAllowList(0)
    }
  }, [conversationId])

  const handlePageChange = (newOffset) => {
    loadXidAllowList(newOffset)
  }

  if (loading && !xids.length) {
    return <Spinner />
  }

  if (error) {
    return <Text sx={{ color: 'error', mb: [3] }}>{error}</Text>
  }

  if (xids.length === 0) {
    return (
      <Text sx={{ color: 'mediumGray', mb: [3] }}>
        No XIDs in the allow list for this conversation.
      </Text>
    )
  }

  return (
    <>
      <Box
        as="table"
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          mb: [3]
        }}>
        <Box
          as="thead"
          sx={{
            backgroundColor: 'lightGray',
            borderBottom: '2px solid',
            borderColor: 'mediumGray'
          }}>
          <Box as="tr">
            <Box
              as="th"
              sx={{
                px: [2, 3],
                py: [2],
                textAlign: 'left',
                fontWeight: 'bold',
                fontSize: [1],
                borderRight: '1px solid',
                borderColor: 'mediumGray'
              }}>
              PID
            </Box>
            <Box
              as="th"
              sx={{
                px: [2, 3],
                py: [2],
                textAlign: 'left',
                fontWeight: 'bold',
                fontSize: [1]
              }}>
              XID
            </Box>
          </Box>
        </Box>
        <Box as="tbody">
          {xids.map((xidRecord, index) => (
            <Box
              key={`${xidRecord.xid}-${index}`}
              as="tr"
              sx={{
                borderBottom: '1px solid',
                borderColor: 'lightGray',
                '&:hover': {
                  backgroundColor: 'lightGray'
                }
              }}>
              <Box
                as="td"
                sx={{
                  px: [2, 3],
                  py: [2],
                  fontSize: [1],
                  borderRight: '1px solid',
                  borderColor: 'lightGray',
                  color: xidRecord.pid ? 'text' : 'mediumGray',
                  fontStyle: xidRecord.pid ? 'normal' : 'italic'
                }}>
                {xidRecord.pid ?? '—'}
              </Box>
              <Box
                as="td"
                sx={{
                  px: [2, 3],
                  py: [2],
                  fontSize: [1],
                  wordBreak: 'break-all'
                }}>
                {xidRecord.xid}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
      <Pagination pagination={pagination} onPageChange={handlePageChange} loading={loading} />
    </>
  )
}

XidAllowListTable.propTypes = {
  conversationId: PropTypes.string
}

// Expected xids format: [{pid: number | null, xid: string}, ...]

export default XidAllowListTable
