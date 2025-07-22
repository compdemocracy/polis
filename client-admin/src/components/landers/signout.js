// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { useNavigate } from 'react-router'

const SignOut = () => {
  const auth = useAuth()
  const navigate = useNavigate()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const performSignout = async () => {
      if (isSigningOut || error) return

      try {
        setIsSigningOut(true)
        setError(null)
        
        // Clear local storage and cookies first
        localStorage.clear()
        sessionStorage.clear()
        
        // The Auth0 simulator does not include "end_session_endpoint" in the discovery document,
        // so we need to handle signout manually.
        if (process.env.AUTH_CLIENT_ID === 'dev-client-id') {
          await auth.removeUser();
          setTimeout(() => {
            navigate('/home');
          }, 1000);
        } else {
          await auth.signoutRedirect({ post_logout_redirect_uri: `${window.location.origin}/home` });
        }
      } catch (err) {
        console.error('Signout error:', err)
        setError(err.message || 'Signout failed')
        setIsSigningOut(false)
        
        // Fallback: redirect to home page after a delay
        setTimeout(() => {
          navigate('/home')
        }, 2000)
      }
    }

    performSignout()
  }, [auth, navigate, isSigningOut, error])

  if (error) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <div>Signout error: {error}</div>
        <div>Redirecting to home page...</div>
      </div>
    )
  }

  return <div>Signing out...</div>
}

export default SignOut
