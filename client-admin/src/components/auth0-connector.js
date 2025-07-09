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
          console.log('✅ Token retrieved successfully:', {
            hasToken: !!token,
            tokenLength: token ? token.length : 0,
            tokenStart: token ? token.substring(0, 20) + '...' : 'null'
          });
          return token;
        } catch (error) {
          console.error('❌ Failed to get access token in tokenGetter:', error);
          throw error;
        }
      }
      
      setAuth0TokenGetter(tokenGetter);
      console.log('✅ Auth0 token getter has been set');
      
      // Robust readiness check - test multiple times to ensure stability
      const testTokenReliability = async (attempt = 1, maxAttempts = 3) => {
        try {
          console.log(`🧪 Token reliability test ${attempt}/${maxAttempts}`);
          const token = await tokenGetter();
          
          if (!token) {
            throw new Error('Token getter returned null/undefined');
          }
          
          // If this is the last test, we're confident it's working
          if (attempt >= maxAttempts) {
            console.log('🚀 Auth0 token getter is reliably working, firing auth0Ready event');
            
            // Set a global flag for components that mount after this event
            window.auth0Ready = true;
            
            // Trigger a custom event to notify the app that auth is ready
            window.dispatchEvent(new CustomEvent('auth0Ready', { 
              detail: { 
                tokenAvailable: true,
                testedReliably: true 
              } 
            }));
            return;
          }
          
          // Test again after a short delay
          setTimeout(() => testTokenReliability(attempt + 1, maxAttempts), 50);
          
        } catch (error) {
          console.error(`🧪 Token reliability test ${attempt} failed:`, error);
          
          if (attempt >= maxAttempts) {
            console.error('❌ Auth0 token getter failed reliability tests');
            // Don't fire auth0Ready event - let components handle the lack of auth
            return;
          }
          
          // Retry after a longer delay on failure
          setTimeout(() => testTokenReliability(attempt + 1, maxAttempts), 200);
        }
      };
      
      // Start the reliability testing
      testTokenReliability();
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