import { Component } from 'react'
import { Flex, Box } from 'theme-ui'

import { Link } from 'react-router'
import Logomark from '../framework/Logomark'
import theme from '../../theme'

class Header extends Component {
  render() {
    return (
      <Box>
        <Flex
          sx={{
            margin: `0 auto`,
            width: '100%',
            paddingTop: '2rem',
            paddingBottom: '1.45rem',
            justifyContent: 'space-between'
          }}>
          <Box sx={{ zIndex: 1000 }}>
            <Link sx={{ variant: 'links.nav' }} to="/home2">
              <Logomark
                style={{ marginRight: 10, position: 'relative', top: 6 }}
                fill={theme.colors.primary}
              />
              Polis
            </Link>
          </Box>
          <Box>
            <Link sx={{ variant: 'links.nav' }} to="/signin">
              Sign in
            </Link>
          </Box>
        </Flex>
      </Box>
    )
  }
}

export default Header
