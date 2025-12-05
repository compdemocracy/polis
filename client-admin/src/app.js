// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useEffect, useState, useCallback } from 'react'
import PropTypes from 'prop-types'
import { useDispatch } from 'react-redux'
import { populateUserStore } from './actions'
import { isAuthReady } from './util/net'
import { UserProvider } from './util/auth'

import { Routes, Route, Navigate } from 'react-router'

import { useAuth } from 'react-oidc-context'
import OidcConnector from './components/OidcConnector'
import Spinner from './components/framework/Spinner'
import theme from './theme'

/* landers */
import Home from './components/landers/home'
import Home2 from './components/landers/home2'
import TOS from './components/landers/TOS'
import Privacy from './components/landers/Privacy'
import SignIn from './components/landers/SignIn'
import SignOut from './components/landers/SignOut'
import Donate from './components/landers/Donate'

// /conversation-admin
import ConversationAdminContainer from './components/conversation-admin/index'

import Conversations from './components/conversations-and-account/Conversations'
import Account from './components/conversations-and-account/Account'
import Integrate from './components/conversations-and-account/Integrate'

import MainLayout from './components/MainLayout'

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

const App = () => {
  const dispatch = useDispatch()
  const { isAuthenticated, isLoading, error } = useAuth()

  const [sidebarState, setSidebarState] = useState(() => {
    // Use desktop breakpoint from theme (62em = 992px) for sidebar docking
    const mql = window.matchMedia(`(min-width: ${theme.breakpoints[2]})`)
    return {
      sidebarOpen: false,
      mql: mql,
      docked: mql.matches
    }
  })

  const loadUserData = useCallback(() => {
    dispatch(populateUserStore())
  }, [dispatch])

  const isAuthed = useCallback(() => {
    return isAuthenticated && !error
  }, [isAuthenticated, error])

  const loadUserDataIfNeeded = useCallback(() => {
    const authSystemReady = isAuthReady()

    if (!isLoading && isAuthenticated && authSystemReady) {
      loadUserData()
    }
  }, [isLoading, isAuthenticated, loadUserData])

  const mediaQueryChanged = useCallback(() => {
    setSidebarState((prev) => ({ ...prev, sidebarDocked: prev.mql.matches }))
  }, [])

  useEffect(() => {
    // Set up media query listener
    const { mql } = sidebarState
    mql.addListener(mediaQueryChanged)

    return () => {
      mql.removeListener(mediaQueryChanged)
    }
  }, [sidebarState.mql, mediaQueryChanged])

  useEffect(() => {
    // Listen for auth ready event
    const handleAuthReady = () => {
      loadUserDataIfNeeded()
    }

    window.addEventListener('polisAuthReady', handleAuthReady)

    // Initial load
    loadUserDataIfNeeded()

    return () => {
      window.removeEventListener('polisAuthReady', handleAuthReady)
    }
  }, [loadUserDataIfNeeded])

  return (
    <>
      <OidcConnector />
      <UserProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/home" element={<Home />} />
          <Route path="/home2" element={<Home2 />} />
          <Route path="/signin" element={<SignIn authed={isAuthed()} />} />
          <Route path="/signout" element={<SignOut />} />
          <Route path="/tos" element={<TOS />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/donate" element={<Donate />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute isAuthed={isAuthed()} isLoading={isLoading} />}>
            <Route path="/" element={<Conversations />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/integrate" element={<Integrate />} />
            <Route path="/account" element={<Account />} />
            <Route path="/m/:conversation_id/*" element={<ConversationAdminContainer />} />
          </Route>
        </Routes>
      </UserProvider>
    </>
  )
}

export default App
