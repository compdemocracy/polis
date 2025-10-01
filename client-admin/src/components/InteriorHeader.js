import PropTypes from 'prop-types'
import { Box } from 'theme-ui'
import { Link } from 'react-router'
import Logomark from './framework/Logomark'

const InteriorHeader = ({ children }) => {
  return (
    <Box sx={{ width: '100%', overflowX: 'hidden' }}>
      <Box
        sx={{
          width: '100%',
          backgroundColor: 'primary',
          color: 'background',
          zIndex: 1000,
          py: [2, 2, 3],
          px: [2, 3, 4],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: [1, 2, 3],
          minHeight: 0
        }}>
        <Link
          sx={{
            variant: 'links.header',
            display: 'flex',
            alignItems: 'center',
            gap: [1, 2, 2],
            flexShrink: 0
          }}
          to="/">
          <Logomark style={{ position: 'relative', top: 2 }} fill={'white'} />
          <Box sx={{ fontSize: [2, 2, 2], whiteSpace: 'nowrap' }}>Polis</Box>
        </Link>
        <Link
          id="signoutLink"
          sx={{
            variant: 'links.header',
            fontSize: [1, 2, 2],
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
          to="/signout">
          sign out
        </Link>
      </Box>
      <Box sx={{ width: '100%', overflowX: 'auto' }}>{children}</Box>
    </Box>
  )
}

InteriorHeader.propTypes = {
  children: PropTypes.node
}

export default InteriorHeader
