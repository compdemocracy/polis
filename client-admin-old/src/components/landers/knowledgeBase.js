import React from 'react'
import PropTypes from 'prop-types'
import { Box, Link } from 'theme-ui'
import emoji from 'react-easy-emoji'

const KnowledgeBase = ({ e, url, txt }) => {
  return (
    <Box sx={{ my: [3] }}>
      <Link target="_blank" href={url}>
        <span style={{ marginRight: 12 }}>{emoji(e)}</span>
        {txt}
      </Link>
    </Box>
  )
}

KnowledgeBase.propTypes = {
  e: PropTypes.string.isRequired,
  url: PropTypes.string.isRequired,
  txt: PropTypes.string.isRequired
}

export default KnowledgeBase
