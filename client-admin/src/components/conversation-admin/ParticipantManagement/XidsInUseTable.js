import { Box, Button, Flex } from 'theme-ui'
import PropTypes from 'prop-types'
import { useState } from 'react'
import PolisNet from '../../../util/net'

const XidsInUseTable = ({ xids = [], conversationId }) => {
  const [downloadLoading, setDownloadLoading] = useState(false)

  const handleDownloadCsv = async () => {
    if (!conversationId) return
    try {
      setDownloadLoading(true)
      const token = await PolisNet.getAccessTokenSilentlySPA()

      const url = `/api/v3/xids/csv?conversation_id=${encodeURIComponent(
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
      a.download = `xids_in_use_${conversationId}_${ts}.csv`
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

  return (
    <>
      <Flex sx={{ justifyContent: 'flex-end', mb: [2] }}>
        <Button
          variant="outline"
          size="small"
          onClick={handleDownloadCsv}
          disabled={downloadLoading || !conversationId}>
          {downloadLoading ? 'Preparing…' : 'Download CSV'}
        </Button>
      </Flex>
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
              fontSize: [1],
              borderRight: '1px solid',
              borderColor: 'mediumGray'
            }}>
            XID
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
            Votes
          </Box>
        </Box>
      </Box>
      <Box as="tbody">
        {xids.map((xidRecord, index) => (
          <Box
            key={`${xidRecord.pid}-${index}`}
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
                borderColor: 'lightGray'
              }}>
              {xidRecord.pid}
            </Box>
            <Box
              as="td"
              sx={{
                px: [2, 3],
                py: [2],
                fontSize: [1],
                wordBreak: 'break-all',
                borderRight: '1px solid',
                borderColor: 'lightGray'
              }}>
              {xidRecord.xid}
            </Box>
            <Box
              as="td"
              sx={{
                px: [2, 3],
                py: [2],
                fontSize: [1]
              }}>
              {xidRecord.vote_count ?? 0}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
    </>
  )
}

XidsInUseTable.propTypes = {
  xids: PropTypes.arrayOf(
    PropTypes.shape({
      pid: PropTypes.number.isRequired,
      xid: PropTypes.string.isRequired,
      vote_count: PropTypes.number
    })
  ),
  conversationId: PropTypes.string
}

export default XidsInUseTable
