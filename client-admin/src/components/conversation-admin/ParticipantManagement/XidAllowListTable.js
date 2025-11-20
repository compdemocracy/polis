import { Box, Text, Button, Flex } from 'theme-ui'
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import PolisNet from '../../../util/net'
import Spinner from '../../framework/Spinner'
import Pagination from '../Pagination'
import UploadXidsModal from './UploadXidsModal'

const XidAllowListTable = ({ conversationId }) => {
  const [xids, setXids] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [limit] = useState(50)
  const [downloadLoading, setDownloadLoading] = useState(false)
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false)

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

  const handleDownloadCsv = async () => {
    if (!conversationId) return
    try {
      setDownloadLoading(true)
      const token = await PolisNet.getAccessTokenSilentlySPA()

      const url = `/api/v3/xidAllowList/csv?conversation_id=${encodeURIComponent(
        conversationId
      )}`

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          ...(token && { Authorization: `Bearer ${token}` })
        }
      })

      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg || `Failed to download CSV (status ${res.status})`)
      }

      const blob = await res.blob()
      const blobUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = blobUrl
      a.download = `xid_allow_list_${conversationId}_${ts}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(blobUrl)
    } catch (e) {
      alert(e?.message || 'Failed to download CSV')
    } finally {
      setDownloadLoading(false)
    }
  }

  const handleUploadXids = async (xidsList, replaceAll = false) => {
    if (!conversationId || !xidsList || xidsList.length === 0) {
      return
    }

    try {
      setLoading(true)
      await PolisNet.polisPost('/api/v3/xidAllowList', {
        xid_allow_list: xidsList,
        conversation_id: conversationId,
        replace_all: replaceAll
      })

      // Close modal and reload list after successful upload
      setIsUploadModalOpen(false)
      await loadXidAllowList(0) // Reload after upload
    } catch (e) {
      alert(e?.responseText || e?.message || 'Failed to upload XIDs')
    } finally {
      setLoading(false)
    }
  }

  if (loading && !xids.length) {
    return <Spinner />
  }

  if (error) {
    return <Text sx={{ color: 'error', mb: [3] }}>{error}</Text>
  }

  if (xids.length === 0) {
    return (
      <>
        <Flex sx={{ justifyContent: 'flex-end', mb: [2], gap: [2] }}>
          <Button
            variant="outline"
            size="small"
            onClick={() => setIsUploadModalOpen(true)}
            disabled={!conversationId}>
            Upload XIDs
          </Button>
          <Button
            variant="outline"
            size="small"
            onClick={handleDownloadCsv}
            disabled={downloadLoading || !conversationId}>
            {downloadLoading ? 'Preparing…' : 'Download CSV'}
          </Button>
        </Flex>
        <UploadXidsModal
          isOpen={isUploadModalOpen}
          onClose={() => setIsUploadModalOpen(false)}
          onUpload={handleUploadXids}
          conversationId={conversationId}
        />
        <Text sx={{ color: 'mediumGray', mb: [3] }}>
          No XIDs in the allow list for this conversation.
        </Text>
      </>
    )
  }

  return (
    <>
      <Flex sx={{ justifyContent: 'flex-end', mb: [2], gap: [2] }}>
        <Button
          variant="outline"
          size="small"
          onClick={() => setIsUploadModalOpen(true)}
          disabled={!conversationId}>
          Upload XIDs
        </Button>
        <Button
          variant="outline"
          size="small"
          onClick={handleDownloadCsv}
          disabled={downloadLoading || !conversationId}>
          {downloadLoading ? 'Preparing…' : 'Download CSV'}
        </Button>
      </Flex>
      <UploadXidsModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUpload={handleUploadXids}
        conversationId={conversationId}
      />
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
