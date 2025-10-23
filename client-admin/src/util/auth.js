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
  const userContext = useContext(UserContext)
  if (userContext === undefined) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return userContext
}

export const hasDelphiEnabled = (authUser) => {
  const decoded = decodedJwt(authUser)
  return decoded && decoded[`${process.env.AUTH_NAMESPACE}delphi_enabled`]
}

export const decodedJwt = (authUser) => {
  if (authUser && authUser?.access_token) {
    return jwtDecode(authUser.access_token)
  }
  return null
}

const getAdminUids = () => {
  // Derive admin UID list from env as produced by webpack DefinePlugin JSON.stringify
  const adminUidsRaw = process.env.ADMIN_UIDS
  if (typeof adminUidsRaw === 'string' && adminUidsRaw.trim() !== '') {
    try {
      const parsed = JSON.parse(adminUidsRaw)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Ignore invalid JSON
    }
  }
  return []
}

export const isSuperAdmin = (userContext) => {
  return getAdminUids().includes(userContext?.user?.uid)
}

export const checkConvoPermissions = (userContext, conversationData) => {
  const isSuper = isSuperAdmin(userContext)
  const isOwner = conversationData?.is_owner || false
  const isMod = conversationData?.is_mod || false
  const shouldShow = isSuper || isOwner || isMod

  return shouldShow
}

export const isAdminOrMod = (userContext, conversationData) => {
  return isSuperAdmin(userContext) || conversationData?.is_mod || conversationData?.is_owner
}
