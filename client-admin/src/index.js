// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PropTypes from 'prop-types'

import { createRoot } from 'react-dom/client'
import { ThemeUIProvider } from 'theme-ui'
import { AuthProvider } from 'react-oidc-context'
import { WebStorageStateStore } from 'oidc-client-ts'
import { Provider } from 'react-redux'
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router'
import App from './app'
import store from './store'
import theme from './theme'

// OIDC configuration - now required
const authority = process.env.AUTH_ISSUER
const clientId = process.env.AUTH_CLIENT_ID
const audience = process.env.AUTH_AUDIENCE
const redirectUri = window.location.origin

if (!authority || !clientId || !audience) {
  console.error('OIDC configuration is incomplete. Please check environment variables:')
  console.error('AUTH_ISSUER:', process.env.AUTH_ISSUER)
  console.error('AUTH_CLIENT_ID:', clientId)
  console.error('AUTH_AUDIENCE:', audience)
  throw new Error('OIDC configuration is required')
}

const OidcProvider = ({ children }) => {
  const navigate = useNavigate()

  const oidcConfig = {
    authority,
    client_id: clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: `${redirectUri}/home`,
    scope: 'openid profile email',
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    extraQueryParams: { audience },
    onSigninCallback: (user) => {
      navigate(user?.state?.returnTo || window.location.pathname)
    }
  }

  return <AuthProvider {...oidcConfig}>{children}</AuthProvider>
}

OidcProvider.propTypes = {
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
        <OidcProvider>
          <Routes>
            <Route path="/*" element={<App />} />
          </Routes>
        </OidcProvider>
      </Router>
    </Provider>
  </ThemeUIProvider>
)

const root = createRoot(document.getElementById('root'))
root.render(<Root />)
