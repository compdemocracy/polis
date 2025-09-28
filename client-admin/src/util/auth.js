import { createContext, useContext } from 'react'
import { jwtDecode } from 'jwt-decode'
import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'

const UserContext = createContext(null)

export const UserProvider = ({ children }) => {
  const user = useSelector((state) => state.user)
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>
}

UserProvider.propTypes = {
  children: PropTypes.node.isRequired
}

export const useUser = () => {
  const context = useContext(UserContext)
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}

export const hasDelphiEnabled = (user) => {
  const decoded = decodedJwt(user)
  return decoded && decoded[`${process.env.AUTH_NAMESPACE}delphi_enabled`]
}

export const decodedJwt = (user) => {
  if (user && user?.access_token) {
    return jwtDecode(user.access_token)
  }
  return null
}
