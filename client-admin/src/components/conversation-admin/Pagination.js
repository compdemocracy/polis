import { Box, Button, Text } from 'theme-ui'
import PropTypes from 'prop-types'

const Pagination = ({ pagination, onPageChange, loading = false, pageSize = 50 }) => {
  if (!pagination || pagination.total === 0) {
    return null
  }

  const { limit, offset, total, hasMore } = pagination
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)

  const handlePrevious = () => {
    if (offset > 0) {
      const newOffset = Math.max(0, offset - limit)
      onPageChange(newOffset, limit)
    }
  }

  const handleNext = () => {
    if (hasMore) {
      const newOffset = offset + limit
      onPageChange(newOffset, limit)
    }
  }

  const handleFirst = () => {
    if (offset > 0) {
      onPageChange(0, limit)
    }
  }

  const handleLast = () => {
    if (hasMore) {
      const lastOffset = Math.floor((total - 1) / limit) * limit
      onPageChange(lastOffset, limit)
    }
  }

  const startItem = offset + 1
  const endItem = Math.min(offset + limit, total)

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        mt: [3],
        pt: [3],
        borderTop: '1px solid',
        borderColor: 'lightGray'
      }}>
      <Text sx={{ fontSize: [1] }}>
        Showing {startItem}-{endItem} of {total} items
      </Text>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: [2] }}>
        <Button
          variant="outline"
          size="small"
          onClick={handleFirst}
          disabled={offset === 0 || loading}
          sx={{
            fontSize: [0],
            px: [2],
            py: [1],
            '&:disabled': {
              backgroundColor: 'lightGray',
              borderColor: 'mediumGray',
              color: 'gray',
              cursor: 'not-allowed'
            }
          }}>
          First
        </Button>

        <Button
          variant="outline"
          size="small"
          onClick={handlePrevious}
          disabled={offset === 0 || loading}
          sx={{
            fontSize: [0],
            px: [2],
            py: [1],
            '&:disabled': {
              backgroundColor: 'lightGray',
              borderColor: 'mediumGray',
              color: 'gray',
              cursor: 'not-allowed'
            }
          }}>
          Previous
        </Button>

        <Text sx={{ fontSize: [1], mx: [2] }}>
          Page {currentPage} of {totalPages}
        </Text>

        <Button
          variant="outline"
          size="small"
          onClick={handleNext}
          disabled={!hasMore || loading}
          sx={{
            fontSize: [0],
            px: [2],
            py: [1],
            '&:disabled': {
              backgroundColor: 'lightGray',
              borderColor: 'mediumGray',
              color: 'gray',
              cursor: 'not-allowed'
            }
          }}>
          Next
        </Button>

        <Button
          variant="outline"
          size="small"
          onClick={handleLast}
          disabled={!hasMore || loading}
          sx={{
            fontSize: [0],
            px: [2],
            py: [1],
            '&:disabled': {
              backgroundColor: 'lightGray',
              borderColor: 'mediumGray',
              color: 'gray',
              cursor: 'not-allowed'
            }
          }}>
          Last
        </Button>
      </Box>
    </Box>
  )
}

Pagination.propTypes = {
  pagination: PropTypes.shape({
    limit: PropTypes.number.isRequired,
    offset: PropTypes.number.isRequired,
    total: PropTypes.number.isRequired,
    hasMore: PropTypes.bool.isRequired
  }),
  onPageChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  pageSize: PropTypes.number
}

export default Pagination
