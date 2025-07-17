// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect, useRef } from 'react'
import { useAuth } from 'react-oidc-context'
import { setOidcTokenGetter, setOidcActions } from '../util/net'

const OidcConnector = () => {
  const auth = useAuth()
  const authWasReady = useRef(false)

  useEffect(() => {
    // Always set up auth actions for error handling and sign-in
    setOidcActions({
      signinRedirect: auth.signinRedirect,
      removeUser: auth.removeUser
    })

    // Set up the token getter function for the network utility when authenticated
    if (process.env.AUTH_CLIENT_ID && auth.isAuthenticated && !auth.isLoading) {
      const tokenGetter = async () => {
        try {
          // The access_token is available on the user object
          if (auth.user?.access_token) {
            return auth.user.access_token
          }
          // Fallback to signinSilent if needed, though usually not necessary
          // if the user object is populated.
          await auth.signinSilent()
          return auth.user?.access_token
        } catch (error) {
          console.error('❌ Failed to get access token in tokenGetter:', error)
          throw error
        }
      }

      setOidcTokenGetter(tokenGetter)

      // Dispatch event when auth becomes ready for the first time
      if (!authWasReady.current) {
        authWasReady.current = true
        window.dispatchEvent(new Event('polisAuthReady'))
      }
    } else if (!auth.isAuthenticated && !auth.isLoading) {
      // Clear the token getter when not authenticated
      setOidcTokenGetter(null)
      authWasReady.current = false
    }
  }, [auth])

  // This component doesn't render anything
  return null
}

export default OidcConnector
