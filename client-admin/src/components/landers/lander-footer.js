import { Component } from 'react'
import { Box, Link, Heading } from 'theme-ui'

import emoji from '../../util/emoji'

class Header extends Component {
  render() {
    return (
      <Box sx={{ mt: [3, null, 4] }}>
        <Heading as="h3" sx={{ fontSize: [4], lineHeight: 'body', my: [2, null, 3] }}>
          Legal
        </Heading>
        <Box sx={{ mb: [2, null, 3], maxWidth: ['100%', '100%', '30em'] }}>
          Polis is built for the public with {emoji('❤️')} in Seattle {emoji('🇺🇸')}, with
          contributions from around the {emoji('🌍🌏🌎')}
        </Box>
        <Box sx={{ mb: [2, null, 3] }}>
          © {new Date().getFullYear()} The Authors <Link href="tos">TOS</Link>{' '}
          <Link href="privacy">Privacy</Link>
        </Box>
        <div id="polis-donate">
          <i>
            Polis is powered by support from people like you. Contribute{' '}
            <Link target="_blank" href="/donate">
              here
            </Link>
            .
          </i>
        </div>
      </Box>
    )
  }
}

export default Header
