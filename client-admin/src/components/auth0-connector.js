// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { setAuth0TokenGetter, setAuth0Actions } from '../util/net'

const Auth0Connector = () => {
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error } = useAuth0()

  useEffect(() => {
    console.log('🔍 Auth0Connector - State changed:', {
      isAuthenticated,
      isLoading,
      hasError: !!error,
      hasGetTokenFunction: !!getAccessTokenSilently,
      authClientId: process.env.AUTH_CLIENT_ID
    });

    if (process.env.AUTH_CLIENT_ID && isAuthenticated) {
      console.log('✅ Setting up Auth0 token getter - user is authenticated');
      
      // Set up the token getter function for the network utility
      const tokenGetter = async () => {
        try {
          console.log('🔍 Token getter called - attempting to get token');
          const token = await getAccessTokenSilently({
            authorizationParams: {
              audience: process.env.AUTH_AUDIENCE,
              scope: 'openid profile email',
            }
          });
          console.log('✅ Token retrieved successfully');
          return token;
        } catch (error) {
          console.error('❌ Failed to get access token in tokenGetter:', error);
          throw error;
        }
      }
      
      setAuth0TokenGetter(tokenGetter);
      console.log('✅ Auth0 token getter has been set');
      
      // Dispatch auth0Ready event to notify other components
      window.auth0Ready = true;
      const event = new CustomEvent('auth0Ready', { detail: { isAuthenticated: true } });
      window.dispatchEvent(event);
      console.log('🚀 Dispatched auth0Ready event');
    } else {
      console.log('⏳ Not setting up token getter yet:', {
        hasClientId: !!process.env.AUTH_CLIENT_ID,
        isAuthenticated,
        reason: !process.env.AUTH_CLIENT_ID ? 'No client ID' : 'Not authenticated'
      });
    }

    // Always set up auth actions for error handling
    setAuth0Actions(loginWithRedirect);
  }, [getAccessTokenSilently, isAuthenticated, loginWithRedirect, isLoading, error])

  // This component doesn't render anything
  return null
}

export default Auth0Connector 