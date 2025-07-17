import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Account from './account'

// Create a mock store
const createMockStore = (user = null) => {
  return configureStore({
    reducer: () => ({
      user: {
        user,
        loading: false,
        error: null
      }
    })
  })
}

// Wrapper to provide theme and store context
const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={mockStore}>{component}</Provider>
    </ThemeUIProvider>
  )
}

describe('Account', () => {
  const mockUser = {
    uid: 123,
    hname: 'John Doe',
    email: 'john.doe@example.com',
    created: 1234567890,
    site_ids: ['site123']
  }

  it('renders loading spinner when user data is not available', () => {
    const store = createMockStore(null)
    renderWithProviders(<Account />, { store })

    // Should render Spinner component
    const spinner = screen.getByText('', { selector: 'svg' })
    expect(spinner).toBeInTheDocument()
  })

  it('renders user information when available', () => {
    const store = createMockStore(mockUser)
    renderWithProviders(<Account />, { store })

    expect(screen.getByText('Account')).toBeInTheDocument()
    expect(screen.getByText('Hi John!')).toBeInTheDocument()
    expect(screen.getByText('John Doe')).toBeInTheDocument()
    expect(screen.getByText('john.doe@example.com')).toBeInTheDocument()
  })

  it('handles user with single name correctly', () => {
    const singleNameUser = { ...mockUser, hname: 'Madonna' }
    const store = createMockStore(singleNameUser)
    renderWithProviders(<Account />, { store })

    expect(screen.getByText('Hi Madonna!')).toBeInTheDocument()
  })

  it('handles user with multiple names correctly', () => {
    const multiNameUser = { ...mockUser, hname: 'Mary Jane Watson Parker' }
    const store = createMockStore(multiNameUser)
    renderWithProviders(<Account />, { store })

    expect(screen.getByText('Hi Mary!')).toBeInTheDocument()
    expect(screen.getByText('Mary Jane Watson Parker')).toBeInTheDocument()
  })

  it('displays heading with correct styling', () => {
    const store = createMockStore(mockUser)
    renderWithProviders(<Account />, { store })

    const heading = screen.getByRole('heading', { name: 'Account' })
    expect(heading).toBeInTheDocument()
    expect(heading.tagName).toBe('H3')
  })

  it('renders when user has empty email', () => {
    const userWithoutEmail = { ...mockUser, email: '' }
    const store = createMockStore(userWithoutEmail)
    renderWithProviders(<Account />, { store })

    expect(screen.getByText('Hi John!')).toBeInTheDocument()
    // Empty string should still be rendered
    const emailElements = screen.getAllByText('')
    expect(emailElements.length).toBeGreaterThan(0)
  })

  it('renders when user object exists but hname is empty', () => {
    const userWithoutName = { ...mockUser, hname: '' }
    const store = createMockStore(userWithoutName)
    renderWithProviders(<Account />, { store })

    // Should show spinner when hname is falsy
    const spinner = screen.getByText('', { selector: 'svg' })
    expect(spinner).toBeInTheDocument()
  })
})
