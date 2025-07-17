import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeUIProvider } from 'theme-ui'
import { BrowserRouter as Router } from 'react-router'
import theme from '../../theme'
import ShareAndEmbed from './share-and-embed'

// Mock the child components
jest.mock('./conversation-has-comments-check', () => {
  return function MockConversationHasCommentsCheck() {
    return <div>ConversationHasCommentsCheck</div>
  }
})

jest.mock('./participant-xids', () => {
  return function MockParticipantXids() {
    return <div>ParticipantXids</div>
  }
})

// Mock useParams
const mockParams = { conversation_id: 'test123' }
jest.mock('react-router', () => ({
  ...jest.requireActual('react-router'),
  useParams: () => mockParams
}))

// Create a mock store
const createMockStore = (zidMetadata = {}) => {
  return configureStore({
    reducer: () => ({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: true,
          parent_url: null,
          strict_moderation: false,
          ...zidMetadata
        }
      }
    })
  })
}

// Wrapper to provide theme, store and router context
const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return render(
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}>
      <ThemeUIProvider theme={theme}>
        <Provider store={mockStore}>{component}</Provider>
      </ThemeUIProvider>
    </Router>
  )
}

describe('ShareAndEmbed', () => {
  it('renders without crashing', () => {
    renderWithProviders(<ShareAndEmbed />)
    expect(screen.getByText('Distribute')).toBeInTheDocument()
  })

  it('displays share link', () => {
    renderWithProviders(<ShareAndEmbed />)
    expect(screen.getByText('Share')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /test123/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('test123'))
  })

  it('displays embed code', () => {
    renderWithProviders(<ShareAndEmbed />)
    expect(screen.getByText('Embed')).toBeInTheDocument()
    expect(screen.getByText(/data-conversation_id='test123'/)).toBeInTheDocument()
  })

  it('shows parent URL when embedded', () => {
    const store = createMockStore({ parent_url: 'https://example.com/article' })
    renderWithProviders(<ShareAndEmbed />, { store })

    const embeddedText = screen.getByTestId('embed-page')
    expect(embeddedText).toHaveTextContent('Embedded on:')
    const parentLink = screen.getByRole('link', { name: 'https://example.com/article' })
    expect(parentLink).toHaveAttribute('href', 'https://example.com/article')
    expect(parentLink).toHaveAttribute('target', 'blank')
  })

  it('does not show parent URL when not embedded', () => {
    renderWithProviders(<ShareAndEmbed />)
    expect(screen.queryByText('Embedded on:')).not.toBeInTheDocument()
  })

  it('shows link to integrate page', () => {
    renderWithProviders(<ShareAndEmbed />)
    const integrateLink = screen.getByRole('link', {
      name: /I want to integrate pol.is on my entire site/
    })
    expect(integrateLink).toHaveAttribute('href', '/integrate')
  })

  it('renders child components', () => {
    renderWithProviders(<ShareAndEmbed />)
    expect(screen.getByText('ConversationHasCommentsCheck')).toBeInTheDocument()
    expect(screen.getByText('ParticipantXids')).toBeInTheDocument()
  })

  it('handles no permissions gracefully', () => {
    const store = createMockStore({ is_mod: false })
    renderWithProviders(<ShareAndEmbed />, { store })
    // Should render NoPermission component
    expect(screen.queryByText('Distribute')).not.toBeInTheDocument()
  })
})
