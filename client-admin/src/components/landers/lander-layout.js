import PropTypes from 'prop-types'
import Header from './lander-header'
import Footer from './lander-footer'
import { Box } from 'theme-ui'

const Layout = ({ children }) => {
  return (
    <Box
      sx={{
        margin: `0 auto`,
        maxWidth: ['100%', '100%', '45em'],
        width: '100%',
        padding: ['0 1rem 1rem', '0 1.5rem 1.45rem', '0 1.0875rem 1.45rem']
      }}>
      <Header />
      <Box>{children}</Box>
      <Footer />
    </Box>
  )
}

Layout.propTypes = {
  children: PropTypes.element
}

export default Layout
