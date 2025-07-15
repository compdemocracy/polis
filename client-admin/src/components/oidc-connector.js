// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect, useRef } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { setOidcTokenGetter, setOidcActions } from '../util/net'

const OidcConnector = () => {
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error } =
    useAuth0()
  const authWasReady = useRef(false)

  useEffect(() => {
    console.log('🔐 OidcConnector useEffect running:', {
      isAuthenticated,
      isLoading,
      hasError: !!error,
      timestamp: new Date().toISOString()
    })

    // Always set up auth actions for error handling
    setOidcActions(loginWithRedirect)

    // Set up the token getter function for the network utility when authenticated
    if (process.env.AUTH_CLIENT_ID && isAuthenticated && !isLoading) {
      console.log('✅ Setting up token getter - user is authenticated')

      const tokenGetter = async () => {
        try {
          console.log('🔑 Token getter called, fetching token...')
          const token = await getAccessTokenSilently({
            authorizationParams: {
              audience: process.env.AUTH_AUDIENCE,
              scope: 'openid profile email'
            }
          })
          console.log('🔑 Token obtained successfully')
          return token
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
    } else if (!isAuthenticated && !isLoading) {
      console.log('🔒 User not authenticated, clearing token getter')
      // Clear the token getter when not authenticated
      setOidcTokenGetter(null)
      authWasReady.current = false
    } else {
      console.log('⏳ Waiting for auth to settle...', { isAuthenticated, isLoading })
    }
  }, [getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error])

  // This component doesn't render anything
  return null
}

export default OidcConnector
