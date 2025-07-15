/* globals jest */
import React from 'react'
import PropTypes from 'prop-types'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from './theme'
import rootReducer from './reducers'

// Mock Auth0 hook
export const mockAuth0 = {
  isAuthenticated: false,
  isLoading: false,
  error: null,
  loginWithRedirect: jest.fn(),
  logout: jest.fn(),
  getAccessTokenSilently: jest.fn(),
  user: null
}

// Mock Auth0Provider to avoid secure origin requirement
const MockAuth0Provider = ({ children }) => {
  return <>{children}</>
}

MockAuth0Provider.propTypes = {
  children: PropTypes.node.isRequired
}

jest.mock('@auth0/auth0-react', () => ({
  Auth0Provider: MockAuth0Provider,
  useAuth0: () => mockAuth0,
  withAuth0: (Component) => (props) => <Component {...props} auth0={mockAuth0} />
}))

// Create store with Redux Toolkit (same as production)
export const createTestStore = (preloadedState = {}) => {
  const defaultState = {
    user: {
      user: null,
      loading: false,
      error: null
    },
    zid_metadata: {
      zid_metadata: {},
      loading: false,
      error: null
    },
    conversations: {
      conversations: null,
      loading: false,
      error: null
    },
    stats: {
      conversation_stats: {},
      loading: false,
      error: null
    },
    seed_comments: {
      seedText: '',
      loading: false,
      error: null,
      success: false
    },
    mod_comments_unmoderated: {
      unmoderated_comments: [],
      loading: false,
      error: null
    },
    mod_comments_accepted: {
      accepted_comments: [],
      loading: false,
      error: null
    },
    mod_comments_rejected: {
      rejected_comments: [],
      loading: false,
      error: null
    },
    ...preloadedState
  }

  return configureStore({
    reducer: rootReducer,
    preloadedState: defaultState,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          // Ignore these action types
          ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
          // Ignore these field paths in all actions
          ignoredActionPaths: ['meta.arg', 'payload.timestamp'],
          // Ignore these paths in the state
          ignoredPaths: ['items.dates']
        }
      })
  })
}

// Render with all providers
export const renderWithProviders = (
  ui,
  {
    preloadedState = {},
    store = createTestStore(preloadedState),
    route = '/',
    ...renderOptions
  } = {}
) => {
  window.history.pushState({}, 'Test page', route)

  function Wrapper({ children }) {
    return (
      <ThemeUIProvider theme={theme}>
        <Provider store={store}>
          <Router
            future={{
              v7_startTransition: true,
              v7_relativeSplatPath: true
            }}>
            {children}
          </Router>
        </Provider>
      </ThemeUIProvider>
    )
  }

  Wrapper.propTypes = {
    children: PropTypes.node.isRequired
  }

  return { store, ...render(ui, { wrapper: Wrapper, ...renderOptions }) }
}

// Mock PolisNet for API calls
export const mockPolisNet = () => {
  jest.mock('./util/net', () => ({
    ...jest.requireActual('./util/net'),
    default: {
      polisGet: jest.fn().mockResolvedValue({}),
      polisPost: jest.fn().mockResolvedValue({}),
      polisPut: jest.fn().mockResolvedValue({})
    },
    isAuthReady: jest.fn().mockReturnValue(true)
  }))
}
