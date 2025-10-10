import { BrowserRouter as Router } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { ConversationDataProvider } from '../../util/conversation_data'
import InviteTree from './InviteTree'
import PolisNet from '../../util/net'
import theme from '../../theme'

// Mock dependencies
jest.mock('../../util/net')
jest.mock('../framework/Spinner', () => {
  return function MockSpinner() {
    return <div data-testid="spinner">Loading...</div>
  }
})

// Mock useParams
const mockParams = { conversation_id: 'test123' }
jest.mock('react-router', () => ({
  ...jest.requireActual('react-router'),
  useParams: () => mockParams
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
    conversationData: {
      conversation_id: 'test123',
      treevite_enabled: false,
      loading: false,
      error: null,
      ...initialState
    }
  }

  return configureStore({
    reducer: () => defaultState
  })
}

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

describe('InviteTree', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Explicitly clear and reset PolisNet mocks to ensure clean state
    PolisNet.polisGet.mockClear()
    PolisNet.polisPost.mockClear()
  })

  it('renders the Invite Tree heading', () => {
    renderWithProviders(<InviteTree />)
    expect(screen.getByText('Invite Tree')).toBeInTheDocument()
  })

  describe('when invite tree is not enabled', () => {
    it('shows disabled message', () => {
      renderWithProviders(<InviteTree />)
      expect(
        screen.getByText(/Invite Tree is not enabled. To use this feature, enable Invite Tree/)
      ).toBeInTheDocument()
    })

    it('does not show waves section', () => {
      renderWithProviders(<InviteTree />)
      expect(screen.queryByText('Waves')).not.toBeInTheDocument()
    })

    it('does not load waves from API', () => {
      renderWithProviders(<InviteTree />)
      expect(PolisNet.polisGet).not.toHaveBeenCalled()
    })
  })

  describe('when invite tree is enabled', () => {
    beforeEach(() => {
      PolisNet.polisGet.mockResolvedValue([])
    })

    it('shows enabled message', () => {
      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })
      expect(
        screen.getByText(/This conversation is invite only. Participants must enter/)
      ).toBeInTheDocument()
    })

    it('loads waves on mount', async () => {
      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/treevite/waves', {
          conversation_id: 'test123'
        })
      })
    })

    it('shows loading spinner while fetching waves', async () => {
      PolisNet.polisGet.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
      )

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })

      expect(screen.getByTestId('spinner')).toBeInTheDocument()

      await waitFor(() => {
        expect(screen.queryByTestId('spinner')).not.toBeInTheDocument()
      })
    })

    it('shows error message when wave loading fails', async () => {
      PolisNet.polisGet.mockRejectedValue({ message: 'Network error' })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument()
      })
    })

    it('shows message when no waves exist', async () => {
      PolisNet.polisGet.mockResolvedValue([])

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })

      await waitFor(() => {
        expect(screen.getByText('No waves yet. Create the initial wave below.')).toBeInTheDocument()
      })
    })

    it('displays list of waves when they exist', async () => {
      const mockWaves = [
        { id: 1, wave: 1, parent_wave: 0, invites_per_user: 5, owner_invites: 10, size: 50 },
        { id: 2, wave: 2, parent_wave: 1, invites_per_user: 3, owner_invites: 0, size: 150 }
      ]
      PolisNet.polisGet.mockResolvedValue(mockWaves)

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteTree />, { store })

      await waitFor(() => {
        expect(screen.getByText(/Wave 1 \(parent 0\)/)).toBeInTheDocument()
        expect(screen.getByText(/Wave 2 \(parent 1\)/)).toBeInTheDocument()
      })
    })

    describe('Create Next Wave form', () => {
      beforeEach(() => {
        PolisNet.polisGet.mockResolvedValue([])
        PolisNet.polisPost.mockResolvedValue({ wave: 1, invites_created: 10 })
      })

      it('renders create wave form', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(screen.getByText('Create Next Wave')).toBeInTheDocument()
        })
      })

      it('renders invites per user input', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(
            screen.getByText(/Invites per user \(granted to each participant/)
          ).toBeInTheDocument()
        })
      })

      it('renders owner invites input', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(screen.getByText(/Owner invites \(additional invites for you/)).toBeInTheDocument()
        })
      })

      it('renders parent wave selector', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(screen.getByText(/Parent wave \(optional override\)/)).toBeInTheDocument()
        })
      })

      it('updates invites per user value on change', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(input, { target: { value: '5' } })
          expect(input).toHaveValue(5)
        })
      })

      it('updates owner invites value on change', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[1]
          fireEvent.change(input, { target: { value: '10' } })
          expect(input).toHaveValue(10)
        })
      })

      it('disables create button when both fields are empty', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const button = screen.getByRole('button', { name: /Create Wave/ })
          expect(button).toBeDisabled()
        })
      })

      it('enables create button when invites per user has value', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(input, { target: { value: '5' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          expect(button).not.toBeDisabled()
        })
      })

      it('enables create button when owner invites has value', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[1]
          fireEvent.change(input, { target: { value: '10' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          expect(button).not.toBeDisabled()
        })
      })

      it('creates wave when create button clicked', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const ipuInput = screen.getAllByRole('spinbutton')[0]
          const ownerInput = screen.getAllByRole('spinbutton')[1]

          fireEvent.change(ipuInput, { target: { value: '5' } })
          fireEvent.change(ownerInput, { target: { value: '10' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/treevite/waves', {
            conversation_id: 'test123',
            invites_per_user: 5,
            owner_invites: 10
          })
        })
      })

      it('includes parent wave in create request when selected', async () => {
        const mockWaves = [{ id: 1, wave: 1, parent_wave: 0, size: 50 }]
        PolisNet.polisGet.mockResolvedValue(mockWaves)

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const ipuInput = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(ipuInput, { target: { value: '5' } })

          const select = screen.getByRole('combobox')
          fireEvent.change(select, { target: { value: '0' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/treevite/waves', {
            conversation_id: 'test123',
            invites_per_user: 5,
            parent_wave: 0
          })
        })
      })

      it('shows creating state on button while creating', async () => {
        PolisNet.polisPost.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ wave: 1 }), 100))
        )

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(input, { target: { value: '5' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(screen.getByRole('button', { name: /Creating…/ })).toBeInTheDocument()
        })
      })

      it('shows success message after wave created', async () => {
        PolisNet.polisGet.mockResolvedValue([])
        PolisNet.polisPost.mockResolvedValue({ wave: 2, invites_created: 25 })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(input, { target: { value: '5' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(screen.getByText(/Created wave 2. Invites created: 25/)).toBeInTheDocument()
        })
      })

      it('reloads waves after creating new wave', async () => {
        // Clear any previous mock implementations
        PolisNet.polisGet.mockClear()
        PolisNet.polisPost.mockClear()

        // Set up specific mock implementations for this test
        PolisNet.polisGet
          .mockResolvedValueOnce([]) // First call on mount
          .mockResolvedValue([{ id: 1, wave: 1 }]) // All subsequent calls return the created wave
        PolisNet.polisPost.mockResolvedValue({ wave: 1, invites_created: 10 })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        // Wait for initial load to complete (should show "no waves" message)
        await waitFor(() => {
          expect(
            screen.getByText('No waves yet. Create the initial wave below.')
          ).toBeInTheDocument()
        })

        // Verify initial load happened
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/treevite/waves', {
          conversation_id: 'test123'
        })
        const initialCallCount = PolisNet.polisGet.mock.calls.length

        // Create wave
        const input = screen.getAllByRole('spinbutton')[0]
        fireEvent.change(input, { target: { value: '5' } })

        const button = screen.getByRole('button', { name: /Create Wave/ })
        fireEvent.click(button)

        // Wait for wave creation to complete
        await waitFor(() => {
          expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/treevite/waves', {
            conversation_id: 'test123',
            invites_per_user: 5
          })
        })

        // Wait for reload after creation by checking that the wave now appears in the list
        await waitFor(() => {
          expect(screen.getByText(/Wave 1 \(parent 0\)/)).toBeInTheDocument()
        })

        // Verify that polisGet was called at least once more after the initial load
        expect(PolisNet.polisGet.mock.calls.length).toBeGreaterThan(initialCallCount)
      })

      it('shows error message when wave creation fails', async () => {
        PolisNet.polisPost.mockRejectedValue({ message: 'Creation failed' })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const input = screen.getAllByRole('spinbutton')[0]
          fireEvent.change(input, { target: { value: '5' } })

          const button = screen.getByRole('button', { name: /Create Wave/ })
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(screen.getByText(/Creation failed/)).toBeInTheDocument()
        })
      })
    })

    describe('parent wave selector', () => {
      it('shows default option', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(screen.getByText('Latest (default)')).toBeInTheDocument()
        })
      })

      it('shows root option', async () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          expect(screen.getByText('Root (0)')).toBeInTheDocument()
        })
      })

      it('populates with existing waves', async () => {
        const mockWaves = [
          { id: 1, wave: 1, parent_wave: 0 },
          { id: 2, wave: 2, parent_wave: 1 }
        ]
        PolisNet.polisGet.mockResolvedValue(mockWaves)

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteTree />, { store })

        await waitFor(() => {
          const select = screen.getByRole('combobox')
          const options = within(select).getAllByRole('option')
          expect(options).toHaveLength(4) // Latest, Root, Wave 1, Wave 2
        })
      })
    })
  })
})

// Helper for testing select options
const within = (element) => ({
  getAllByRole: (role) => {
    const options = element.querySelectorAll('option')
    return Array.from(options)
  }
})
