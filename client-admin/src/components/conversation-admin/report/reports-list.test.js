import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeUIProvider } from 'theme-ui'
import { BrowserRouter as Router } from 'react-router'
import theme from '../../../theme'
import ReportsList from './reports-list'
import PolisNet from '../../../util/net'
import * as actions from '../../../actions'
import { mockAuth } from '../../../test-utils'

// Mock dependencies
jest.mock('../../../util/net')
jest.mock('../../../actions', () => ({
  populateZidMetadataStore: jest.fn()
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
  const mockReducer = (state = initialState, action) => {
    if (action.type === 'UPDATE_ZID_METADATA') {
      return {
        ...state,
        zid_metadata: {
          ...state.zid_metadata,
          zid_metadata: {
            ...state.zid_metadata.zid_metadata,
            ...action.payload
          }
        }
      }
    }
    return state
  }
  return configureStore({
    reducer: mockReducer,
    preloadedState: initialState
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
          <Provider store={mockStore}>{component}</Provider>
        </ThemeUIProvider>
      </Router>
    )
  }
}

describe('ReportsList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.populateZidMetadataStore.mockReturnValue({ type: 'POPULATE_ZID_METADATA' })
    mockAuth.isAuthenticated = true
    mockAuth.isLoading = false
  })

  it('renders loading state initially', () => {
    const store = createMockStore({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: false
        },
        loading: true // Set loading to true to see loading state
      }
    })

    renderWithProviders(<ReportsList />, { store })
    expect(screen.getByText('Loading Reports...')).toBeInTheDocument()
  })

  it('loads metadata on mount when authenticated', () => {
    const store = createMockStore({
      zid_metadata: { zid_metadata: {} }
    })

    renderWithProviders(<ReportsList />, { store })
    expect(actions.populateZidMetadataStore).toHaveBeenCalledWith('test123')
  })

  it('loads reports data when user becomes moderator', async () => {
    PolisNet.polisGet = jest
      .fn()
      .mockResolvedValue([{ report_id: 'report1' }, { report_id: 'report2' }])

    const store = createMockStore({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: false
        }
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Update store to make user a moderator
    act(() => {
      store.dispatch({
        type: 'UPDATE_ZID_METADATA',
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
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: true // User is already a moderator
        }
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
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: undefined // Metadata not loaded yet
        }
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Simulate metadata loading after component mount
    act(() => {
      store.dispatch({
        type: 'UPDATE_ZID_METADATA',
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
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: true
        }
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    // Trigger getData by changing is_mod
    act(() => {
      store.dispatch({
        type: 'UPDATE_ZID_METADATA',
        payload: { is_mod: false }
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

    act(() => {
      store.dispatch({
        type: 'UPDATE_ZID_METADATA',
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
      expect(screen.getByText('Create report url')).toBeInTheDocument()
    })

    const createButton = screen.getByText('Create report url')
    fireEvent.click(createButton)

    await waitFor(() => {
      expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/reports', {
        conversation_id: 'test123',
        mod_level: -2
      })
      expect(PolisNet.polisGet).toHaveBeenCalledTimes(4) // Initial load + refresh after create (multiple renders due to hooks)
    })
  })

  it('renders report links correctly', async () => {
    PolisNet.polisGet = jest
      .fn()
      .mockResolvedValue([{ report_id: 'report1' }, { report_id: 'report2' }])

    const store = createMockStore({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: false
        }
      }
    })

    const { rerender } = renderWithProviders(<ReportsList />, { store })

    act(() => {
      store.dispatch({
        type: 'UPDATE_ZID_METADATA',
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
      const reportLinks = screen.getAllByTestId('report-list-item')
      expect(reportLinks).toHaveLength(2)
      expect(reportLinks[0]).toHaveTextContent('report/report1')
      expect(reportLinks[1]).toHaveTextContent('report/report2')
    })
  })

  it('handles no permissions correctly', () => {
    const store = createMockStore({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          is_mod: false
        },
        error: { status: 403 }
      }
    })

    renderWithProviders(<ReportsList />, { store })
    // Should render NoPermission component
    expect(screen.queryByText('Loading Reports...')).not.toBeInTheDocument()
    expect(screen.queryByText('Report')).not.toBeInTheDocument()
  })
})
