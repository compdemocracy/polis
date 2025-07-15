// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { populateUserStore } from './actions'
import { isAuthReady } from './util/net'

import { Routes, Route, Navigate } from 'react-router'
import { jsx } from 'theme-ui'

import { withAuth0 } from '@auth0/auth0-react'
import OidcConnector from './components/oidc-connector'
import Spinner from './components/framework/spinner'

/* landers */
import Home from './components/landers/home'
import TOS from './components/landers/tos'
import Privacy from './components/landers/privacy'
import SignIn from './components/landers/signin'
import SignOut from './components/landers/signout'

// /conversation-admin
import ConversationAdminContainer from './components/conversation-admin/index'

import Conversations from './components/conversations-and-account/conversations'
import Account from './components/conversations-and-account/account'
import Integrate from './components/conversations-and-account/integrate'

import MainLayout from './components/main-layout'

const AUTH_LOADING_TIMEOUT = 3000

const ProtectedRoute = ({ isAuthed, isLoading }) => {
  const [loadingTimeout, setLoadingTimeout] = React.useState(false)

  React.useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => {
        setLoadingTimeout(true)
      }, AUTH_LOADING_TIMEOUT)

      return () => clearTimeout(timer)
    } else {
      setLoadingTimeout(false)
    }
  }, [isLoading])

  if (isLoading && !loadingTimeout) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '200px'
        }}>
        <Spinner />
      </div>
    )
  }

  return isAuthed ? <MainLayout /> : <Navigate to="/signin" replace />
}

ProtectedRoute.propTypes = {
  isAuthed: PropTypes.bool.isRequired,
  isLoading: PropTypes.bool.isRequired
}

@connect((state) => {
  return state.user
})
class App extends React.Component {
  constructor(props) {
    super(props)

    // Bind the method once for reuse
    this.mediaQueryChanged = this.mediaQueryChanged.bind(this)

    // Set up media query
    const mql = window.matchMedia(`(min-width: 800px)`)
    mql.addListener(this.mediaQueryChanged)

    this.state = {
      sidebarOpen: false,
      mql: mql,
      docked: mql.matches
    }
  }

  loadUserData() {
    this.props.dispatch(populateUserStore())
  }

  isAuthed() {
    // Use Auth0 authentication state
    return this.props.auth0.isAuthenticated && !this.props.auth0.error
  }

  isLoading() {
    // Use Auth0 loading state
    return this.props.auth0.isLoading
  }

  componentDidMount() {
    // Listen for auth ready event
    this.handleAuthReady = () => {
      console.log('🎉 Auth ready event received in App')
      this.loadUserDataIfNeeded()
    }
    window.addEventListener('polisAuthReady', this.handleAuthReady)

    this.loadUserDataIfNeeded()
  }

  componentDidUpdate(prevProps) {
    // Load user data when auth state changes from loading to authenticated
    const wasLoading = prevProps.auth0.isLoading
    const isNowAuthenticated = this.props.auth0.isAuthenticated && !this.props.auth0.isLoading

    if (wasLoading && isNowAuthenticated) {
      this.loadUserDataIfNeeded()
    }
  }

  loadUserDataIfNeeded() {
    const authSystemReady = isAuthReady()

    console.log('👤 loadUserDataIfNeeded:', {
      authIsLoading: this.props.auth0.isLoading,
      isAuthenticated: this.props.auth0.isAuthenticated,
      authSystemReady,
      willLoad: !this.props.auth0.isLoading && this.props.auth0.isAuthenticated && authSystemReady
    })

    if (!this.props.auth0.isLoading && this.props.auth0.isAuthenticated && authSystemReady) {
      console.log('📡 Loading user data')
      this.loadUserData()
    } else if (
      !this.props.auth0.isLoading &&
      this.props.auth0.isAuthenticated &&
      !authSystemReady
    ) {
      console.log('⏳ Auth system not ready yet for user data')
    }
  }

  componentWillUnmount() {
    this.state.mql.removeListener(this.mediaQueryChanged)

    // Clean up event listener
    if (this.handleAuthReady) {
      window.removeEventListener('polisAuthReady', this.handleAuthReady)
    }
  }

  mediaQueryChanged() {
    this.setState({ sidebarDocked: this.state.mql.matches })
  }

  onSetSidebarOpen(open) {
    this.setState({ sidebarOpen: open })
  }

  handleMenuButtonClick() {
    this.setState({ sidebarOpen: !this.state.sidebarOpen })
  }

  render() {
    const isAuthed = this.isAuthed()
    const isLoading = this.isLoading()

    return (
      <>
        <OidcConnector />
        <Routes>
          {/* Public routes */}
          <Route path="/home" element={<Home />} />
          <Route path="/signin" element={<SignIn {...this.props} authed={isAuthed} />} />
          <Route path="/signout" element={<SignOut {...this.props} />} />
          <Route path="/tos" element={<TOS />} />
          <Route path="/privacy" element={<Privacy />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute isAuthed={isAuthed} isLoading={isLoading} />}>
            <Route path="/" element={<Conversations />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/integrate" element={<Integrate />} />
            <Route path="/account" element={<Account />} />
            <Route path="/m/:conversation_id/*" element={<ConversationAdminContainer />} />
          </Route>
        </Routes>
      </>
    )
  }
}

App.propTypes = {
  dispatch: PropTypes.func,
  isLoggedIn: PropTypes.bool,
  location: PropTypes.shape({
    pathname: PropTypes.string
  }),
  user: PropTypes.shape({
    uid: PropTypes.string,
    email: PropTypes.string,
    created: PropTypes.number,
    hname: PropTypes.string
  }),
  auth0: PropTypes.shape({
    isAuthenticated: PropTypes.bool,
    isLoading: PropTypes.bool,
    error: PropTypes.object,
    loginWithRedirect: PropTypes.func,
    logout: PropTypes.func
  })
}

export default withAuth0(App)
