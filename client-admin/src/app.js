// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { populateUserStore } from './actions'

import { Switch, Route, Link, Redirect } from 'react-router-dom'
import { Flex, Box, jsx } from 'theme-ui'

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

import InteriorHeader from './components/interior-header'

const AUTH_LOADING_TIMEOUT = 3000

const PrivateRoute = ({ component: Component, isLoading, authed, ...rest }) => {
  // If we've been loading for more than AUTH_LOADING_TIMEOUT,
  // assume something went wrong and proceed with authentication check
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

  return (
    <Route
      {...rest}
      render={(props) =>
        authed === true ? (
          <Component {...props} />
        ) : (
          <Redirect to={{ pathname: '/signin', state: { from: props.location } }} />
        )
      }
    />
  )
}

PrivateRoute.propTypes = {
  component: PropTypes.elementType,
  isLoading: PropTypes.bool,
  location: PropTypes.object,
  authed: PropTypes.bool
}

@connect((state) => {
  return state.user
})
class App extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      sidebarOpen: false
      // sidebarDocked: true,
    }
  }

  loadUserData() {
    this.props.dispatch(populateUserStore())
  }

  componentWillMount() {
    const mql = window.matchMedia(`(min-width: 800px)`)
    mql.addListener(this.mediaQueryChanged.bind(this))
    this.setState({ mql: mql, docked: mql.matches })
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
    this.mediaQueryChanged()

    // Listen for oidcReady event to ensure token getter is available
    const handleAuth0Ready = (event) => {
      if (!this.isLoading() && this.isAuthed()) {
        this.loadUserData()
      }
    }

    window.addEventListener('oidcReady', handleAuth0Ready)

    // Store the handler for cleanup
    this.oidcReadyHandler = handleAuth0Ready
  }

  componentDidUpdate(prevProps) {
    // This logic has been removed because it was creating a race condition.
    // It was calling loadUserData() before the Auth0 token getter was guaranteed to be available.
    // The 'oidcReady' event listener in componentDidMount now safely handles loading user data.
  }

  componentWillUnmount() {
    // Clean up event listener
    if (this.oidcReadyHandler) {
      window.removeEventListener('oidcReady', this.oidcReadyHandler)
    }
    this.state.mql.removeListener(this.mediaQueryChanged.bind(this))
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
    const { location } = this.props
    return (
      <>
        <OidcConnector />
        <Switch>
          <Redirect from="/:url*(/+)" to={location.pathname.slice(0, -1)} />
          <Route exact path="/home" component={Home} />
          <Route
            exact
            path="/signin"
            render={() => <SignIn {...this.props} authed={this.isAuthed()} />}
          />
          <Route
            exact
            path="/signin/*"
            render={() => <SignIn {...this.props} authed={this.isAuthed()} />}
          />
          <Route
            exact
            path="/signin/**/*"
            render={() => <SignIn {...this.props} authed={this.isAuthed()} />}
          />
          <Route exact path="/signout" render={() => <SignOut {...this.props} />} />
          <Route exact path="/signout/*" render={() => <SignOut {...this.props} />} />
          <Route exact path="/signout/**/*" render={() => <SignOut {...this.props} />} />

          <Route exact path="/tos" component={TOS} />
          <Route exact path="/privacy" component={Privacy} />

          <InteriorHeader>
            <Route
              render={(routeProps) => {
                if (routeProps.location.pathname.split('/')[1] === 'm') {
                  return null
                }
                return (
                  <Flex>
                    <Box sx={{ mr: [5], p: [4], flex: '0 0 auto' }}>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: 'links.nav' }} to={`/`}>
                          Conversations
                        </Link>
                      </Box>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: 'links.nav' }} to={`/integrate`}>
                          Integrate
                        </Link>
                      </Box>
                      <Box sx={{ mb: [3] }}>
                        <Link sx={{ variant: 'links.nav' }} to={`/account`}>
                          Account
                        </Link>
                      </Box>
                    </Box>
                    <Box
                      sx={{
                        p: [4],
                        flex: '0 0 auto',
                        maxWidth: '35em',
                        mx: [4]
                      }}>
                      <PrivateRoute
                        isLoading={this.isLoading()}
                        authed={this.isAuthed()}
                        exact
                        path="/"
                        component={Conversations}
                      />
                      <PrivateRoute
                        isLoading={this.isLoading()}
                        authed={this.isAuthed()}
                        exact
                        path="/conversations"
                        component={Conversations}
                      />
                      <PrivateRoute
                        isLoading={this.isLoading()}
                        authed={this.isAuthed()}
                        exact
                        path="/account"
                        component={Account}
                      />
                      <PrivateRoute
                        isLoading={this.isLoading()}
                        authed={this.isAuthed()}
                        exact
                        path="/integrate"
                        component={Integrate}
                      />
                    </Box>
                  </Flex>
                )
              }}
            />

            <PrivateRoute
              isLoading={this.isLoading()}
              path="/m/:conversation_id"
              authed={this.isAuthed()}
              component={ConversationAdminContainer}
            />
          </InteriorHeader>
        </Switch>
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
