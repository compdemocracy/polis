// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'

import { createRoot } from 'react-dom/client'
import { ThemeUIProvider } from 'theme-ui'
import { Auth0Provider } from '@auth0/auth0-react'
import { Provider } from 'react-redux'
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router'
import App from './app'
import store from './store'
import theme from './theme'

// OIDC configuration - now required
const auth0Domain = process.env.AUTH_ISSUER ? new URL(process.env.AUTH_ISSUER).host : undefined

const auth0ClientId = process.env.AUTH_CLIENT_ID
const auth0Audience = process.env.AUTH_AUDIENCE

if (!auth0Domain || !auth0ClientId || !auth0Audience) {
  console.error('OIDC configuration is incomplete. Please check environment variables:')
  console.error('AUTH_ISSUER:', process.env.AUTH_ISSUER)
  console.error('AUTH_CLIENT_ID:', auth0ClientId)
  console.error('AUTH_AUDIENCE:', auth0Audience)
  throw new Error('OIDC configuration is required')
}

const Auth0ProviderWithRedirectCallback = ({ children }) => {
  const navigate = useNavigate()

  const onRedirectCallback = (appState) => {
    navigate(appState?.returnTo || window.location.pathname)
  }

  return (
    <Auth0Provider
      domain={auth0Domain}
      clientId={auth0ClientId}
      cacheLocation="localstorage"
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Audience,
        scope: 'openid profile email'
      }}
      onRedirectCallback={onRedirectCallback}>
      {children}
    </Auth0Provider>
  )
}

Auth0ProviderWithRedirectCallback.propTypes = {
  children: PropTypes.node.isRequired
}

const Root = () => (
  <ThemeUIProvider theme={theme}>
    <Provider store={store}>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <Auth0ProviderWithRedirectCallback>
          <Routes>
            <Route path="/*" element={<App />} />
          </Routes>
        </Auth0ProviderWithRedirectCallback>
      </Router>
    </Provider>
  </ThemeUIProvider>
)

const root = createRoot(document.getElementById('root'))
root.render(<Root />)
