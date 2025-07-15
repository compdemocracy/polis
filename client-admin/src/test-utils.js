/* globals jest */
import PropTypes from 'prop-types'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from './theme'
import rootReducer from './reducers'
import { AuthContext } from 'react-oidc-context'

// Mock oidc-client-ts
jest.mock('oidc-client-ts', () => ({
  WebStorageStateStore: jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
    getAllKeys: jest.fn()
  })),
  // Mock other exports if needed
  UserManager: jest.fn().mockImplementation(() => ({}))
}))

// Mock Auth hook for react-oidc-context
export const mockAuth = {
  isAuthenticated: false,
  isLoading: false,
  error: null,
  user: null,
  signinRedirect: jest.fn(),
  signoutRedirect: jest.fn(),
  removeUser: jest.fn(),
  signinSilent: jest.fn()
}

// Mock AuthProvider
const MockAuthProvider = ({ children, mockAuthValue = mockAuth }) => {
  return <AuthContext.Provider value={mockAuthValue}>{children}</AuthContext.Provider>
}

MockAuthProvider.propTypes = {
  children: PropTypes.node.isRequired,
  mockAuthValue: PropTypes.object
}

jest.mock('react-oidc-context', () => ({
  AuthProvider: MockAuthProvider,
  useAuth: () => mockAuth,
  hasAuth: true
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
