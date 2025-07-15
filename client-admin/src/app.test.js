import React from 'react'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createStore, applyMiddleware } from 'redux'
import { thunk } from 'redux-thunk'
import { BrowserRouter } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import App from './app'
import PolisReducers from './reducers/index'
import theme from './theme'

// Mock the Auth0 hook
const mockAuth0 = {
  isAuthenticated: false,
  isLoading: true,
  error: null,
  loginWithRedirect: jest.fn(),
  logout: jest.fn(),
  getAccessTokenSilently: jest.fn()
}

// Mock Auth0Provider to avoid secure origin requirement
const MockAuth0Provider = ({ children }) => {
  return <>{children}</>
}

jest.mock('@auth0/auth0-react', () => ({
  Auth0Provider: MockAuth0Provider,
  useAuth0: () => mockAuth0,
  withAuth0: (Component) => (props) => <Component {...props} auth0={mockAuth0} />
}))

// Mock the conversations component to avoid deep component tree issues
jest.mock('./components/conversations-and-account/conversations', () => {
  return function MockConversations() {
    return <div>All Conversations</div>
  }
})

// Create store with thunk middleware
const store = createStore(PolisReducers, applyMiddleware(thunk))

const renderWithProviders = (component) => {
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={store}>
        <BrowserRouter>{component}</BrowserRouter>
      </Provider>
    </ThemeUIProvider>
  )
}

describe('App Authentication Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset mock state
    mockAuth0.isAuthenticated = false
    mockAuth0.isLoading = true
    mockAuth0.error = null
  })

  test('shows loading spinner when Auth0 is loading', () => {
    mockAuth0.isLoading = true
    mockAuth0.isAuthenticated = false

    const { container } = renderWithProviders(<App />)

    // Should show loading spinner container
    const spinnerContainer = container.querySelector('div[style*="display: flex"]')
    expect(spinnerContainer).toBeInTheDocument()
    // And it should contain an SVG
    const svg = spinnerContainer?.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  test('redirects to signin when not authenticated and not loading', () => {
    mockAuth0.isLoading = false
    mockAuth0.isAuthenticated = false

    renderWithProviders(<App />)

    // Should show the Sign In page heading
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    // And the Sign In button
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  test('shows protected content when authenticated and not loading', () => {
    mockAuth0.isLoading = false
    mockAuth0.isAuthenticated = true

    renderWithProviders(<App />)

    // Should show the main app content (conversations page)
    expect(screen.getByText(/All Conversations/i)).toBeInTheDocument()
  })
})
