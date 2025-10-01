import { BrowserRouter as Router } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { ConversationDataProvider } from '../../util/conversation_data'
import ShareAndEmbed from './ShareAndEmbed'
import theme from '../../theme'

// Mock the child components
jest.mock('./ConversationHasCommentsCheck', () => {
  return function MockConversationHasCommentsCheck() {
    return <div>ConversationHasCommentsCheck</div>
  }
})

jest.mock('./ParticipantXids', () => {
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
const createMockStore = (conversationData = {}) => {
  return configureStore({
    reducer: () => ({
      conversationData: {
        conversation_id: 'test123',
        is_mod: true,
        parent_url: null,
        strict_moderation: false,
        ...conversationData
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
        <Provider store={mockStore}>
          <ConversationDataProvider>{component}</ConversationDataProvider>
        </Provider>
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

  it('renders regardless of is_mod flag (permission checking happens at parent level)', () => {
    const store = createMockStore({ is_mod: false })
    renderWithProviders(<ShareAndEmbed />, { store })
    // ShareAndEmbed doesn't check permissions itself - that's handled by the parent ConversationAdmin
    // So it should still render even with is_mod: false
    expect(screen.getByText('Distribute')).toBeInTheDocument()
  })

  it('includes /alpha/ in participant URL when treevite_enabled is true', () => {
    const store = createMockStore({ treevite_enabled: true })
    renderWithProviders(<ShareAndEmbed />, { store })

    const link = screen.getByRole('link', { name: /test123/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('/alpha/test123'))
  })
})
