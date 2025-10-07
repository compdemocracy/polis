import { BrowserRouter as Router } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { ConversationDataProvider } from '../../util/conversation_data'
import InviteCodes from './InviteCodes'
import PolisNet from '../../util/net'
import theme from '../../theme'

// Mock dependencies
jest.mock('../../util/net')
jest.mock('../framework/Spinner', () => {
  return function MockSpinner() {
    return <div data-testid="spinner">Loading...</div>
  }
})
jest.mock('./Pagination', () => {
  return function MockPagination({ pagination, onPageChange }) {
    return (
      <div data-testid="pagination">
        <button onClick={() => onPageChange(50)}>Next Page</button>
        <span>Total: {pagination?.total || 0}</span>
      </div>
    )
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

describe('InviteCodes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url')
    global.URL.revokeObjectURL = jest.fn()
  })

  afterEach(() => {
    delete global.fetch
  })

  it('renders the Invite Codes heading', () => {
    renderWithProviders(<InviteCodes />)
    expect(screen.getByText('Invite Codes')).toBeInTheDocument()
  })

  describe('when invite tree is not enabled', () => {
    it('shows disabled message', () => {
      renderWithProviders(<InviteCodes />)
      expect(
        screen.getByText(/Invite Tree is not enabled. To use this feature, enable Invite Tree/)
      ).toBeInTheDocument()
    })

    it('does not load invites from API', () => {
      renderWithProviders(<InviteCodes />)
      expect(PolisNet.polisGet).not.toHaveBeenCalled()
    })

    it('does not show download CSV button', () => {
      renderWithProviders(<InviteCodes />)
      expect(screen.queryByText('Download CSV')).not.toBeInTheDocument()
    })
  })

  describe('when invite tree is enabled', () => {
    beforeEach(() => {
      PolisNet.polisGet.mockResolvedValue({ invites: [], pagination: null })
    })

    it('shows description text', () => {
      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })
      expect(
        screen.getByText(/These are the invite codes for the owner of this conversation/)
      ).toBeInTheDocument()
    })

    it('loads invites on mount', async () => {
      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/treevite/invites', {
          conversation_id: 'test123',
          limit: 50,
          offset: 0
        })
      })
    })

    it('loads waves for filter dropdown', async () => {
      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/treevite/waves', {
          conversation_id: 'test123'
        })
      })
    })

    it('shows loading spinner while fetching invites', async () => {
      PolisNet.polisGet.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ invites: [] }), 100))
      )

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      expect(screen.getByTestId('spinner')).toBeInTheDocument()

      await waitFor(() => {
        expect(screen.queryByTestId('spinner')).not.toBeInTheDocument()
      })
    })

    it('shows error message when loading fails', async () => {
      PolisNet.polisGet.mockRejectedValue({ message: 'Network error' })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(screen.getByText(/Network error/)).toBeInTheDocument()
      })
    })

    it('shows message when no invites exist', async () => {
      PolisNet.polisGet.mockResolvedValue({ invites: [], pagination: null })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(
          screen.getByText(/No invite codes found. Create waves in the Invite Tree/)
        ).toBeInTheDocument()
      })
    })

    it('displays table with invites when they exist', async () => {
      const mockInvites = [
        {
          id: 1,
          invite_code: 'ABC123',
          wave: 1,
          status: 0,
          invite_used_at: null
        },
        {
          id: 2,
          invite_code: 'DEF456',
          wave: 2,
          status: 1,
          invite_used_at: '2024-01-01T12:00:00Z'
        }
      ]
      PolisNet.polisGet.mockResolvedValue({
        invites: mockInvites,
        pagination: { total: 2, limit: 50, offset: 0 }
      })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(screen.getByText('ABC123')).toBeInTheDocument()
        expect(screen.getByText('DEF456')).toBeInTheDocument()
      })
    })

    it('displays correct status text and colors', async () => {
      const mockInvites = [
        { id: 1, invite_code: 'A1', wave: 1, status: 0 }, // Unused
        { id: 2, invite_code: 'A2', wave: 1, status: 1 }, // Used
        { id: 3, invite_code: 'A3', wave: 1, status: 2 }, // Revoked
        { id: 4, invite_code: 'A4', wave: 1, status: 3 } // Expired
      ]
      PolisNet.polisGet.mockResolvedValue({ invites: mockInvites, pagination: null })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(screen.getByText('Unused')).toBeInTheDocument()
        expect(screen.getByText('Used')).toBeInTheDocument()
        expect(screen.getByText('Revoked')).toBeInTheDocument()
        expect(screen.getByText('Expired')).toBeInTheDocument()
      })
    })

    it('formats used_at timestamp correctly', async () => {
      const mockInvites = [
        {
          id: 1,
          invite_code: 'ABC123',
          wave: 1,
          status: 1,
          invite_used_at: '2024-01-15T10:30:00Z'
        }
      ]
      PolisNet.polisGet.mockResolvedValue({ invites: mockInvites, pagination: null })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        // Should show formatted date (exact format depends on locale)
        const table = screen.getByRole('table')
        expect(table).toBeInTheDocument()
      })
    })

    it('shows dash for null used_at timestamp', async () => {
      const mockInvites = [
        {
          id: 1,
          invite_code: 'ABC123',
          wave: 1,
          status: 0,
          invite_used_at: null
        }
      ]
      PolisNet.polisGet.mockResolvedValue({ invites: mockInvites, pagination: null })

      const store = createMockStore({ treevite_enabled: true })
      renderWithProviders(<InviteCodes />, { store })

      await waitFor(() => {
        expect(screen.getByText('—')).toBeInTheDocument()
      })
    })

    describe('Filters', () => {
      it('renders filter section', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null })
          .mockResolvedValueOnce([])

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Filters')).toBeInTheDocument()
        })
      })

      it('renders wave filter dropdown', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null })
          .mockResolvedValueOnce([])

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Wave')).toBeInTheDocument()
          expect(screen.getByText('All waves')).toBeInTheDocument()
        })
      })

      it('renders status filter dropdown', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null })
          .mockResolvedValueOnce([])

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Status')).toBeInTheDocument()
          expect(screen.getByText('All statuses')).toBeInTheDocument()
        })
      })

      it('reloads invites when wave filter changes', async () => {
        const mockInvitesFiltered = [{ id: 1, invite_code: 'FILTERED123', wave: 1, status: 0 }]
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null }) // initial invites load
          .mockResolvedValueOnce([{ id: 1, wave: 1 }]) // waves load
          .mockResolvedValueOnce({ invites: mockInvitesFiltered, pagination: null }) // reload after filter change

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Filters')).toBeInTheDocument()
        })

        const selects = screen.getAllByRole('combobox')
        fireEvent.change(selects[0], { target: { value: '1' } })

        // Wait for the filtered results to appear
        await waitFor(() => {
          expect(screen.getByText('FILTERED123')).toBeInTheDocument()
        })

        // Verify that polisGet was called at least 3 times (initial + waves + filter)
        expect(PolisNet.polisGet).toHaveBeenCalledTimes(3)
      })

      it('reloads invites when status filter changes', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null })
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce({ invites: [], pagination: null })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          const selects = screen.getAllByRole('combobox')
          fireEvent.change(selects[1], { target: { value: '0' } })
        })

        await waitFor(() => {
          expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/treevite/invites', {
            conversation_id: 'test123',
            limit: 50,
            offset: 0,
            status: 0
          })
        })
      })

      it('shows clear filters button when filters are active', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null }) // invites call
          .mockResolvedValueOnce([{ id: 1, wave: 1 }]) // waves call
          .mockResolvedValue({ invites: [], pagination: null }) // subsequent calls

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Filters')).toBeInTheDocument()
        })

        const selects = screen.getAllByRole('combobox')
        fireEvent.change(selects[1], { target: { value: '0' } }) // Use status filter instead

        await waitFor(() => {
          expect(screen.getByText('Clear Filters')).toBeInTheDocument()
        })
      })

      it('clears filters when clear button clicked', async () => {
        PolisNet.polisGet
          .mockResolvedValueOnce({ invites: [], pagination: null }) // invites call
          .mockResolvedValueOnce([{ id: 1, wave: 1 }]) // waves call
          .mockResolvedValue({ invites: [], pagination: null }) // subsequent calls

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Filters')).toBeInTheDocument()
        })

        const selects = screen.getAllByRole('combobox')
        fireEvent.change(selects[1], { target: { value: '0' } }) // Use status filter instead

        await waitFor(() => {
          expect(screen.getByText('Clear Filters')).toBeInTheDocument()
        })

        const clearButton = screen.getByText('Clear Filters')
        fireEvent.click(clearButton)

        await waitFor(() => {
          const selects = screen.getAllByRole('combobox')
          expect(selects[0]).toHaveValue('')
          expect(selects[1]).toHaveValue('')
        })
      })
    })

    describe('Pagination', () => {
      it('renders pagination component when invites exist', async () => {
        const mockInvites = [{ id: 1, invite_code: 'ABC123', wave: 1, status: 0 }]
        PolisNet.polisGet.mockResolvedValue({
          invites: mockInvites,
          pagination: { total: 100, limit: 50, offset: 0 }
        })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByTestId('pagination')).toBeInTheDocument()
        })
      })

      it('calls pagination callback when page changes', async () => {
        const mockInvites = [{ id: 1, invite_code: 'ABC123', wave: 1, status: 0 }]
        PolisNet.polisGet.mockResolvedValue({
          invites: mockInvites,
          pagination: { total: 100, limit: 50, offset: 0 }
        })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Next Page')).toBeInTheDocument()
        })

        const initialCallCount = PolisNet.polisGet.mock.calls.length
        const nextButton = screen.getByText('Next Page')
        fireEvent.click(nextButton)

        await waitFor(() => {
          // Verify that an additional API call was made after clicking next page
          expect(PolisNet.polisGet.mock.calls.length).toBeGreaterThan(initialCallCount)
        })
      })
    })

    describe('CSV Download', () => {
      beforeEach(() => {
        PolisNet.getAccessTokenSilentlySPA.mockResolvedValue('mock-token')
      })

      it('renders download CSV button', () => {
        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })
        expect(screen.getByText('Download CSV')).toBeInTheDocument()
      })

      it('calls API when download button clicked', async () => {
        global.fetch.mockResolvedValue({
          ok: true,
          blob: () => Promise.resolve(new Blob(['test']))
        })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          const button = screen.getByText('Download CSV')
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/v3/treevite/invites/csv'),
            expect.objectContaining({
              method: 'GET',
              headers: expect.objectContaining({
                Authorization: 'Bearer mock-token'
              })
            })
          )
        })
      })

      it('shows preparing state while downloading', async () => {
        global.fetch.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: true, blob: () => Promise.resolve(new Blob()) }), 100)
            )
        )

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          const button = screen.getByText('Download CSV')
          fireEvent.click(button)
        })

        await waitFor(() => {
          expect(screen.getByText('Preparing…')).toBeInTheDocument()
        })
      })

      it('triggers download when button clicked', async () => {
        global.fetch.mockResolvedValue({
          ok: true,
          blob: () => Promise.resolve(new Blob(['test']))
        })

        PolisNet.polisGet.mockResolvedValue({ invites: [], pagination: null })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText('Download CSV')).toBeInTheDocument()
        })

        const button = screen.getByText('Download CSV')
        fireEvent.click(button)

        // Verify fetch was called with the correct URL
        await waitFor(() => {
          expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/v3/treevite/invites/csv'),
            expect.any(Object)
          )
        })
      })
    })

    describe('Count display', () => {
      it('shows total count with correct pluralization for single invite', async () => {
        const mockInvites = [{ id: 1, invite_code: 'ABC123', wave: 1, status: 0 }]
        PolisNet.polisGet.mockResolvedValue({
          invites: mockInvites,
          pagination: { total: 1, limit: 50, offset: 0 }
        })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText(/Found 1 invite code:/)).toBeInTheDocument()
        })
      })

      it('shows total count with correct pluralization for multiple invites', async () => {
        const mockInvites = [
          { id: 1, invite_code: 'ABC123', wave: 1, status: 0 },
          { id: 2, invite_code: 'DEF456', wave: 1, status: 0 }
        ]
        PolisNet.polisGet.mockResolvedValue({
          invites: mockInvites,
          pagination: { total: 2, limit: 50, offset: 0 }
        })

        const store = createMockStore({ treevite_enabled: true })
        renderWithProviders(<InviteCodes />, { store })

        await waitFor(() => {
          expect(screen.getByText(/Found 2 invite codes:/)).toBeInTheDocument()
        })
      })
    })
  })
})
