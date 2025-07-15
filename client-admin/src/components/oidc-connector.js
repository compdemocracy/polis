// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect, useRef } from 'react'
import { useAuth } from 'react-oidc-context'
import { setOidcTokenGetter, setOidcActions } from '../util/net'

const OidcConnector = () => {
  const auth = useAuth()
  const authWasReady = useRef(false)

  useEffect(() => {
    console.log('🔐 OidcConnector useEffect running:', {
      isAuthenticated: auth.isAuthenticated,
      isLoading: auth.isLoading,
      hasError: !!auth.error,
      timestamp: new Date().toISOString()
    })

    // Always set up auth actions for error handling and sign-in
    setOidcActions({
      signinRedirect: auth.signinRedirect,
      removeUser: auth.removeUser
    })

    // Set up the token getter function for the network utility when authenticated
    if (process.env.AUTH_CLIENT_ID && auth.isAuthenticated && !auth.isLoading) {
      console.log('✅ Setting up token getter - user is authenticated')

      const tokenGetter = async () => {
        try {
          // The access_token is available on the user object
          if (auth.user?.access_token) {
            console.log('🔑 Token obtained successfully from auth context')
            return auth.user.access_token
          }
          // Fallback to signinSilent if needed, though usually not necessary
          // if the user object is populated.
          console.log('🔑 Token not in context, trying signinSilent...')
          await auth.signinSilent()
          return auth.user?.access_token
        } catch (error) {
          console.error('❌ Failed to get access token in tokenGetter:', error)
          throw error
        }
      }

      setOidcTokenGetter(tokenGetter)
      console.log('✅ Token getter has been set')

      // Dispatch event when auth becomes ready for the first time
      if (!authWasReady.current) {
        authWasReady.current = true
        console.log('🎉 Dispatching authReady event')
        window.dispatchEvent(new Event('polisAuthReady'))
      }
    } else if (!auth.isAuthenticated && !auth.isLoading) {
      console.log('🔒 User not authenticated, clearing token getter')
      // Clear the token getter when not authenticated
      setOidcTokenGetter(null)
      authWasReady.current = false
    } else {
      console.log('⏳ Waiting for auth to settle...', {
        isAuthenticated: auth.isAuthenticated,
        isLoading: auth.isLoading
      })
    }
  }, [auth])

  // This component doesn't render anything
  return null
}

export default OidcConnector
