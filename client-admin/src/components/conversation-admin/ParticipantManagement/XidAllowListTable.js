import { Box, Text } from 'theme-ui'

// Placeholder table for XID Allow List; data population will be added later
const XidAllowListTable = () => {
  return (
    <Box sx={{ mb: [3] }}>
      <Text sx={{ color: 'mediumGray', mb: [2], display: 'block' }}>
        This view will list XIDs allowed to participate. Population coming soon.
      </Text>

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
            <Box as="th" sx={{ px: [2, 3], py: [2], textAlign: 'left', fontWeight: 'bold', fontSize: [1] }}>
              XID
            </Box>
          </Box>
        </Box>
        <Box as="tbody">
          {/* Rows will be populated in a subsequent change */}
        </Box>
      </Box>
    </Box>
  )
}

export default XidAllowListTable


