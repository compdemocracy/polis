import { Box } from 'theme-ui'
import PropTypes from 'prop-types'

const XidsInUseTable = ({ xids = [] }) => {
  return (
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
                wordBreak: 'break-all'
              }}>
              {xidRecord.xid}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

XidsInUseTable.propTypes = {
  xids: PropTypes.arrayOf(
    PropTypes.shape({
      pid: PropTypes.number.isRequired,
      xid: PropTypes.string.isRequired
    })
  )
}

export default XidsInUseTable
