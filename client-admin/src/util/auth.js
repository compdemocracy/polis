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

export const checkConvoPermissions = (user, zid_metadata) => {
  const isSuperAdmin = getAdminUids().includes(user?.user?.uid)
  const isOwner = zid_metadata?.is_owner || false
  const isMod = zid_metadata?.is_mod || false
  const shouldShow = isSuperAdmin || isOwner || isMod

  return shouldShow
}

export const isAdminOrMod = (user, zid_metadata) => {
  const isSuperAdminUser = getAdminUids().includes(user?.user?.uid)
  if (isSuperAdminUser) return true
  return zid_metadata?.is_mod || zid_metadata?.is_owner
}
