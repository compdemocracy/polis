import { render, screen, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import { AuthContext } from 'react-oidc-context'
import PropTypes from 'prop-types'

import ParticipantXids from './ParticipantXids'
import PolisNet from '../../util/net'
import theme from '../../theme'

// Mock dependencies
jest.mock('../../util/net')
jest.mock('../../util/url', () => ({
  urlPrefix: 'https://test.pol.is/'
}))

const mockAuth = {
  isLoading: false,
  isAuthenticated: true,
  user: null,
  error: null
}

const MockAuthProvider = ({ children, authValue = mockAuth }) => {
  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
}

MockAuthProvider.propTypes = {
  children: PropTypes.node.isRequired,
  authValue: PropTypes.object
}

const renderWithProviders = (component, { authValue } = {}) => {
  return render(
    <ThemeUIProvider theme={theme}>
      <MockAuthProvider authValue={authValue}>{component}</MockAuthProvider>
    </ThemeUIProvider>
  )
}

describe('ParticipantXids', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Mock Date to get consistent timestamps in tests
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-03-15T14:30:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('Initial rendering and loading', () => {
    it('renders the main heading', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-123' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)
      expect(screen.getByText('DOWNLOAD XID CSV')).toBeInTheDocument()
    })

    it('shows loading state initially', () => {
      PolisNet.polisGet.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ conversation_uuid: 'test-uuid' }), 100)
          )
      )
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)
      expect(screen.getByText('Loading conversation UUID for XID download...')).toBeInTheDocument()
    })

    it('fetches conversation UUID on mount', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-123' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/conversationUuid', {
          conversation_id: 'conv123'
        })
      })
    })

    it('waits for auth to be ready before fetching UUID', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-123' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />, {
        authValue: { isLoading: true, isAuthenticated: false }
      })

      expect(PolisNet.polisGet).not.toHaveBeenCalled()
    })
  })

  describe('Successful UUID fetch', () => {
    it('displays download link with correct filename', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-456' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByText(/xid csv download:/)
        expect(link).toBeInTheDocument()
      })
    })

    it('constructs correct download URL with UUID', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-789' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        expect(link).toHaveAttribute('href', 'https://test.pol.is/api/v3/xid/test-uuid-789-xid.csv')
      })
    })

    it('sets download attribute on link', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-789' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        expect(link).toHaveAttribute('download')
        expect(link.getAttribute('download')).toMatch(/conv123-xid\.csv$/)
      })
    })

    it('displays curl command with correct URL', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'curl-test-uuid' })
      renderWithProviders(<ParticipantXids conversation_id="conv456" />)

      await waitFor(() => {
        expect(
          screen.getByText(/curl: https:\/\/test\.pol\.is\/api\/v3\/xid\/curl-test-uuid-xid\.csv/)
        ).toBeInTheDocument()
      })
    })

    it('sets correct MIME type on download link', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        expect(link).toHaveAttribute('type', 'text/csv')
      })
    })
  })

  describe('Error handling', () => {
    it('displays error message when UUID fetch fails', async () => {
      PolisNet.polisGet.mockRejectedValue(new Error('Network error'))
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(
          screen.getByText('Could not load conversation UUID for XID download')
        ).toBeInTheDocument()
      })
    })

    it('logs error to console when fetch fails', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation()
      const error = new Error('API error')
      PolisNet.polisGet.mockRejectedValue(error)

      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Error fetching UUID:', error)
      })

      consoleError.mockRestore()
    })

    it('does not show download links when there is an error', async () => {
      PolisNet.polisGet.mockRejectedValue(new Error('Network error'))
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(
          screen.getByText('Could not load conversation UUID for XID download')
        ).toBeInTheDocument()
      })

      expect(screen.queryByText(/xid csv download:/)).not.toBeInTheDocument()
      expect(screen.queryByText(/curl:/)).not.toBeInTheDocument()
    })
  })

  describe('Filename generation', () => {
    it('generates filename with timestamp and conversation ID', async () => {
      // Using mocked date: 2024-03-15T14:30:00.000Z
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      renderWithProviders(<ParticipantXids conversation_id="my-conv-id" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        // The timestamp format is YYYY-MM-DD-HHMM
        expect(link.getAttribute('download')).toMatch(
          /^\d{4}-\d{2}-\d{2}-\d{4}-my-conv-id-xid\.csv$/
        )
      })
    })

    it('pads single-digit months and days with zeros', async () => {
      // Set date to January 5th at 09:05 UTC
      jest.setSystemTime(new Date('2024-01-05T09:05:00.000Z'))
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      renderWithProviders(<ParticipantXids conversation_id="conv" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        const filename = link.getAttribute('download')
        // Just verify padding format YYYY-MM-DD-HHMM (not exact time due to timezone)
        expect(filename).toMatch(/^\d{4}-0\d-0\d-\d{4}-conv-xid\.csv$/)
      })
    })
  })

  describe('Documentation section', () => {
    it('renders XID documentation heading', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      expect(
        screen.getByText(/WHAT IS AN XID\? GET UP AND RUNNING WITH PARTICIPANT IDENTITY!/)
      ).toBeInTheDocument()
    })

    it('renders documentation links', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      const { container } = renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      const links = container.querySelectorAll('a[target="_blank"]')
      expect(links.length).toBeGreaterThan(5) // Should have multiple external doc links
    })

    it('includes code examples for data-xid usage', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      const { container } = renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      const codeElements = container.querySelectorAll('code')
      expect(codeElements.length).toBeGreaterThan(0)

      // Check for data-xid examples
      const codeTexts = Array.from(codeElements).map((el) => el.textContent)
      expect(codeTexts.some((text) => text.includes('data-xid'))).toBe(true)
    })

    it('links to compdemocracy.org documentation', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })
      const { container } = renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      const externalLinks = container.querySelectorAll('a[href^="https://compdemocracy.org/"]')
      expect(externalLinks.length).toBeGreaterThan(5)
    })
  })

  describe('Auth state changes', () => {
    it('fetches UUID when auth changes from loading to authenticated', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })

      const { rerender } = renderWithProviders(<ParticipantXids conversation_id="conv123" />, {
        authValue: { isLoading: true, isAuthenticated: false }
      })

      expect(PolisNet.polisGet).not.toHaveBeenCalled()

      // Auth finishes loading
      rerender(
        <ThemeUIProvider theme={theme}>
          <MockAuthProvider authValue={{ isLoading: false, isAuthenticated: true }}>
            <ParticipantXids conversation_id="conv123" />
          </MockAuthProvider>
        </ThemeUIProvider>
      )

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalled()
      })
    })

    it('fetches UUID on mount with correct parameters', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid-1' })

      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/conversationUuid', {
          conversation_id: 'conv123'
        })
      })

      // Verify it was called with the correct parameters
      expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/conversationUuid', {
        conversation_id: 'conv123'
      })
    })
  })

  describe('Edge cases', () => {
    it('handles null UUID response gracefully', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: null })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(
          screen.getByText('No conversation UUID available for XID download')
        ).toBeInTheDocument()
      })
    })

    it('does not show download links when UUID is null', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: null })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(screen.queryByText(/xid csv download:/)).not.toBeInTheDocument()
      })
    })

    it('fetches UUID on initial mount', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })

      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalled()
      })

      // Verify it was called with correct parameters
      expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/conversationUuid', {
        conversation_id: 'conv123'
      })
    })
  })

  describe('URL construction', () => {
    it('uses urlPrefix from utility', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'uuid-with-prefix' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        const href = link.getAttribute('href')
        expect(href.startsWith('https://test.pol.is/')).toBe(true)
      })
    })

    it('constructs URL with UUID in correct format', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'my-special-uuid-123' })
      renderWithProviders(<ParticipantXids conversation_id="conv123" />)

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /xid csv download:/ })
        expect(link.getAttribute('href')).toBe(
          'https://test.pol.is/api/v3/xid/my-special-uuid-123-xid.csv'
        )
      })
    })
  })

  describe('PropTypes validation', () => {
    it('renders without crashing when conversation_id is provided', () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })

      expect(() => {
        renderWithProviders(<ParticipantXids conversation_id="test-id" />)
      }).not.toThrow()
    })

    it('uses conversation_id in API call', async () => {
      PolisNet.polisGet.mockResolvedValue({ conversation_uuid: 'test-uuid' })

      renderWithProviders(<ParticipantXids conversation_id="string-id-123" />)

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/conversationUuid', {
          conversation_id: 'string-id-123'
        })
      })
    })
  })
})
