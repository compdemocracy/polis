import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import SignIn from './signin'
import { mockAuth } from '../../test-utils'

// Mock the useAuth hook directly for this test file
jest.mock('react-oidc-context', () => ({
  useAuth: () => mockAuth
}))

// Mock Navigate component
const mockNavigate = jest.fn()
jest.mock('react-router', () => ({
  ...jest.requireActual('react-router'),
  Navigate: ({ to }) => {
    mockNavigate(to)
    return null
  }
}))

// Wrapper to provide theme and router context
const renderWithProviders = (component, options = {}) => {
  return render(
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}>
      <ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>
    </Router>,
    options
  )
}

describe('SignIn', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth.isAuthenticated = false
    mockAuth.isLoading = false
  })

  it('renders sign in form when not authenticated', () => {
    renderWithProviders(<SignIn authed={false} />)

    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
  })

  it('redirects to home when authenticated', () => {
    renderWithProviders(<SignIn authed={true} />)

    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('calls signinRedirect when sign in button is clicked', () => {
    renderWithProviders(<SignIn authed={false} />)

    const signInButton = screen.getByRole('button', { name: 'Sign In' })
    fireEvent.click(signInButton)

    expect(mockAuth.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: '/' }
    })
  })

  it('has correct button id for testing', () => {
    renderWithProviders(<SignIn authed={false} />)

    const signInButton = screen.getByRole('button', { name: 'Sign In' })
    expect(signInButton).toHaveAttribute('id', 'signinButton')
  })

  it('uses static layout wrapper', () => {
    const { container } = renderWithProviders(<SignIn authed={false} />)

    // Check for header elements from static layout
    const links = container.querySelectorAll('a')
    const homeLink = Array.from(links).find((link) => link.textContent.includes('Polis'))
    expect(homeLink).toBeInTheDocument()
  })

  it('renders h1 with correct font size', () => {
    renderWithProviders(<SignIn authed={false} />)

    const heading = screen.getByRole('heading', { level: 1, name: 'Sign In' })
    expect(heading).toBeInTheDocument()
  })
})
