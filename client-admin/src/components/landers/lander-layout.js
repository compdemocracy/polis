import React from 'react'
import PropTypes from 'prop-types'
import Header from './lander-header'
import Footer from './lander-footer'
import { Box } from 'theme-ui'

const Layout = ({ children }) => {
  const globalWidth = '45em'
  return (
    <Box
      sx={{
        margin: `0 auto`,
        maxWidth: globalWidth,
        padding: `0 1.0875rem 1.45rem`
      }}>
      <Header globalWidth={globalWidth} />
      <Box>{children}</Box>
      <Footer />
    </Box>
  )
}

Layout.propTypes = {
  children: PropTypes.element
}

export default Layout
