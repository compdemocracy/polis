// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { setOidcTokenGetter, setOidcActions } from '../util/net'

const OidcConnector = () => {
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error } =
    useAuth0()

  useEffect(() => {
    if (process.env.AUTH_CLIENT_ID && isAuthenticated) {
      // Set up the token getter function for the network utility
      const tokenGetter = async () => {
        try {
          const token = await getAccessTokenSilently({
            authorizationParams: {
              audience: process.env.AUTH_AUDIENCE,
              scope: 'openid profile email'
            }
          })
          return token
        } catch (error) {
          console.error('❌ Failed to get access token in tokenGetter:', error)
          throw error
        }
      }

      setOidcTokenGetter(tokenGetter)

      // Dispatch oidcReady event to notify other components
      window.oidcReady = true
      const event = new CustomEvent('oidcReady', {
        detail: { isAuthenticated: true }
      })
      window.dispatchEvent(event)
    }

    // Always set up auth actions for error handling
    setOidcActions(loginWithRedirect)
  }, [getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error])

  // This component doesn't render anything
  return null
}

export default OidcConnector
