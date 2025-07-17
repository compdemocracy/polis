import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserRouter } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import App from './app'
import rootReducer from './reducers'
import theme from './theme'
import { mockAuth } from './test-utils'

// Mock the useAuth hook directly for this test file
jest.mock('react-oidc-context', () => ({
  useAuth: () => mockAuth
}))

// Mock the conversations component to avoid deep component tree issues
jest.mock('./components/conversations-and-account/conversations', () => {
  return function MockConversations() {
    return <div>All Conversations</div>
  }
})

// Create store with Redux Toolkit (same as production)
const store = configureStore({
  reducer: rootReducer
})

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
    mockAuth.isAuthenticated = false
    mockAuth.isLoading = true
    mockAuth.error = null
  })

  test('shows loading spinner when Auth is loading', () => {
    mockAuth.isLoading = true
    mockAuth.isAuthenticated = false

    const { container } = renderWithProviders(<App />)

    // Should show loading spinner container
    const spinnerContainer = container.querySelector('div[style*="display: flex"]')
    expect(spinnerContainer).toBeInTheDocument()
    // And it should contain an SVG
    const svg = spinnerContainer?.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  test('redirects to signin when not authenticated and not loading', () => {
    mockAuth.isLoading = false
    mockAuth.isAuthenticated = false

    renderWithProviders(<App />)

    // Should show the Sign In page heading
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    // And the Sign In button
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  test('shows protected content when authenticated and not loading', () => {
    mockAuth.isLoading = false
    mockAuth.isAuthenticated = true

    renderWithProviders(<App />)

    // Should show the main app content (conversations page)
    expect(screen.getByText(/All Conversations/i)).toBeInTheDocument()
  })
})
