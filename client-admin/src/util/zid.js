import { createContext, useContext } from 'react'
import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'

const ZidMetadataContext = createContext(null)

export const ZidMetadataProvider = ({ children }) => {
  const zid_metadata = useSelector((state) => state.zid_metadata)
  return <ZidMetadataContext.Provider value={zid_metadata}>{children}</ZidMetadataContext.Provider>
}

ZidMetadataProvider.propTypes = {
  children: PropTypes.node.isRequired
}

export const useZidMetadata = () => {
  const context = useContext(ZidMetadataContext)
  if (context === undefined) {
    throw new Error('useZidMetadata must be used within a ZidMetadataProvider')
  }
  return context
}
