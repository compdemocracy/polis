import { BrowserRouter as Router } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { ConversationDataProvider } from '../../../util/conversation_data'
import { mockAuth } from '../../../test-utils'
import { UserProvider } from '../../../util/auth'
import * as actions from '../../../actions'
import PolisNet from '../../../util/net'
import ReportsList from './ReportsList'
import theme from '../../../theme'

// Mock dependencies
jest.mock('../../../util/net')
jest.mock('../../../actions', () => ({
  populateConversationDataStore: jest.fn()
}))

// Mock Auth
jest.mock('react-oidc-context', () => ({
  useAuth: () => mockAuth
}))

// Mock useParams
const mockParams = { conversation_id: 'test123' }
jest.mock('react-router', () => ({
  ...jest.requireActual('react-router'),
  useParams: () => mockParams
}))

// Create a mock store with Redux Toolkit
const createMockStore = (initialState = {}) => {
  const defaultState = {
    user: {
      user: {
        uid: 123,
        email: 'test@example.com'
      },
      loading: false,
      error: null
    },
    conversationData: {
      conversation_id: 'test123',
      is_mod: false,
      loading: false
    },
    ...initialState
  }

  const mockReducer = (state = defaultState, action) => {
    if (action.type === 'UPDATE_CONVERSATION_DATA') {
      return {
        ...state,
        conversationData: {
          ...state.conversationData,
          ...action.payload
        }
      }
    }
    return state
  }
  return configureStore({
    reducer: mockReducer,
    preloadedState: defaultState
  })
}

// Wrapper to provide all contexts
const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return {
    store: mockStore,
    ...render(
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <ThemeUIProvider theme={theme}>
          <Provider store={mockStore}>
            <UserProvider>
              <ConversationDataProvider>{component}</ConversationDataProvider>
            </UserProvider>
          </Provider>
        </ThemeUIProvider>
      </Router>
    )
  }
}

describe('ReportsList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.populateConversationDataStore.mockReturnValue({ type: 'POPULATE_CONVERSATION_DATA' })
    mockAuth.isAuthenticated = true
    mockAuth.isLoading = false
  })

  it('renders loading state initially', () => {
    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: false,
        loading: true // Set loading to true to see loading state
      }
    })

    renderWithProviders(<ReportsList />, { store })
    expect(screen.getByText('Loading Reports...')).toBeInTheDocument()
  })

  it('does not load metadata itself (parent component handles this)', () => {
    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: false,
        loading: true
      }
    })

    renderWithProviders(<ReportsList />, { store })
    // ReportsList doesn't call populateConversationDataStore - that's done by ConversationAdminContainer
    expect(actions.populateConversationDataStore).not.toHaveBeenCalled()
  })

  it('loads reports data when user becomes moderator', async () => {
    PolisNet.polisGet = jest
      .fn()
      .mockResolvedValue([{ report_id: 'report1' }, { report_id: 'report2' }])

    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: false,
        loading: true
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Update store to make user a moderator
    act(() => {
      store.dispatch({
        type: 'UPDATE_CONVERSATION_DATA',
        payload: { is_mod: true }
      })
    })

    // Force a re-render to trigger componentDidUpdate
    rerender(
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <ThemeUIProvider theme={theme}>
          <Provider store={store}>
            <ReportsList />
          </Provider>
        </ThemeUIProvider>
      </Router>
    )

    await waitFor(() => {
      expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/reports', {
        conversation_id: 'test123'
      })
    })
  })

  it('DOES load reports data when user is already a moderator on mount', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue([])

    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: true, // User is already a moderator
        loading: true
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Force a componentDidUpdate to trigger the check
    rerender(
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <ThemeUIProvider theme={theme}>
          <Provider store={store}>
            <ReportsList />
          </Provider>
        </ThemeUIProvider>
      </Router>
    )

    // Should load reports data after update
    await waitFor(() => {
      expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/reports', {
        conversation_id: 'test123'
      })
    })
  })

  it('loads reports after hard refresh when user is moderator', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue([{ report_id: 'report1' }])

    // Simulate the scenario after a hard refresh
    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: undefined, // Metadata not loaded yet
        loading: true
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Simulate metadata loading after component mount
    act(() => {
      store.dispatch({
        type: 'UPDATE_CONVERSATION_DATA',
        payload: { is_mod: true }
      })
    })

    rerender(
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <ThemeUIProvider theme={theme}>
          <Provider store={store}>
            <ReportsList />
          </Provider>
        </ThemeUIProvider>
      </Router>
    )

    await waitFor(() => {
      expect(PolisNet.polisGet).toHaveBeenCalled()
    })
  })

  it('creates a new report and refreshes the list', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue([])
    PolisNet.polisPost = jest.fn().mockResolvedValue({ report_id: 'new-report' })

    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: true,
        loading: false
      }
    })

    renderWithProviders(<ReportsList />, { store })

    await waitFor(() => {
      expect(screen.getByText('Create report url')).toBeInTheDocument()
    })

    const createButton = screen.getByText('Create report url')
    fireEvent.click(createButton)

    await waitFor(() => {
      expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/reports', {
        conversation_id: 'test123',
        mod_level: -2
      })
      // polisGet should be called at least twice: initial load + refresh after create
      expect(PolisNet.polisGet).toHaveBeenCalledTimes(2)
    })
  })

  it('renders report cards correctly', async () => {
    const mockReports = [
      {
        report_id: 'report1',
        modified: Date.now() - 3600000, // 1 hour ago
        mod_level: -2
      },
      {
        report_id: 'report2',
        modified: Date.now() - 7200000, // 2 hours ago
        mod_level: 0
      }
    ]

    PolisNet.polisGet = jest.fn().mockResolvedValue(mockReports)

    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: true,
        loading: false
      }
    })

    renderWithProviders(<ReportsList />, { store })

    await waitFor(() => {
      const reportCards = screen.getAllByTestId('report-list-item')
      expect(reportCards).toHaveLength(2)

      // Check that cards contain the report IDs
      expect(reportCards[0]).toHaveTextContent('Report ID: report1')
      expect(reportCards[1]).toHaveTextContent('Report ID: report2')

      // Check that cards contain timestamps
      expect(reportCards[0]).toHaveTextContent('Modified')
      expect(reportCards[1]).toHaveTextContent('Modified')
    })
  })

  it('allows expanding report cards to show report URLs', async () => {
    const mockReports = [
      {
        report_id: 'report1',
        modified: Date.now() - 3600000,
        mod_level: -2
      }
    ]

    PolisNet.polisGet = jest.fn().mockResolvedValue(mockReports)

    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: true,
        loading: false
      }
    })

    renderWithProviders(<ReportsList />, { store })

    await waitFor(() => {
      const reportCard = screen.getByTestId('report-list-item')
      expect(reportCard).toBeInTheDocument()

      // Initially, no report URLs should be visible
      expect(screen.queryByText('Report URLs')).not.toBeInTheDocument()

      // Click the card to expand it
      fireEvent.click(reportCard)

      // Now the report URLs should be visible
      expect(screen.getByText('Report URLs')).toBeInTheDocument()
      expect(screen.getByText('Standard Report:')).toBeInTheDocument()
      expect(screen.getByText('Data Export:')).toBeInTheDocument()
    })
  })

  it('renders regardless of is_mod flag (permission checking happens at parent level)', () => {
    const store = createMockStore({
      conversationData: {
        conversation_id: 'test123',
        is_mod: false,
        loading: true,
        error: { status: 403 }
      }
    })

    renderWithProviders(<ReportsList />, { store })
    // ReportsList doesn't check permissions itself - that's handled by the parent ConversationAdmin
    // So it will show loading state even with is_mod: false
    expect(screen.getByText('Loading Reports...')).toBeInTheDocument()
  })
})
