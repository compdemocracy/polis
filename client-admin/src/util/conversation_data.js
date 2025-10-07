import { createContext, useContext } from 'react'
import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'

const ConversationDataContext = createContext(null)

export const ConversationDataProvider = ({ children }) => {
  const conversationData = useSelector((state) => state.conversationData)
  return (
    <ConversationDataContext.Provider value={conversationData}>
      {children}
    </ConversationDataContext.Provider>
  )
}

ConversationDataProvider.propTypes = {
  children: PropTypes.node.isRequired
}

export const useConversationData = () => {
  const context = useContext(ConversationDataContext)
  if (context === undefined) {
    throw new Error('useConversationData must be used within a ConversationDataProvider')
  }
  return context
}
