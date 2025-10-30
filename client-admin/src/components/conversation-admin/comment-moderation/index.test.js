import { BrowserRouter as Router } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { mockAuth } from '../../../test-utils'
import * as actions from '../../../actions'
import CommentModeration from './index'
import theme from '../../../theme'

// Mock child components
jest.mock('./ModerateCommentsTodo', () => {
  return function MockModerateCommentsTodo() {
    return <div data-testid="moderate-comments-todo">Unmoderated View</div>
  }
})

jest.mock('./ModerateCommentsAccepted', () => {
  return function MockModerateCommentsAccepted() {
    return <div data-testid="moderate-comments-accepted">Accepted View</div>
  }
})

jest.mock('./ModerateCommentsRejected', () => {
  return function MockModerateCommentsRejected() {
    return <div data-testid="moderate-comments-rejected">Rejected View</div>
  }
})

// Mock actions
jest.mock('../../../actions', () => ({
  populateAllCommentStores: jest.fn()
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

const createMockStore = (initialState = {}) => {
  const defaultState = {
    mod_comments_unmoderated: {
      unmoderated_comments: [],
      loading: false,
      error: null
    },
    mod_comments_accepted: {
      accepted_comments: [],
      loading: false,
      error: null
    },
    mod_comments_rejected: {
      rejected_comments: [],
      loading: false,
      error: null
    },
    ...initialState
  }

  return configureStore({
    reducer: () => defaultState
  })
}

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

describe('CommentModeration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    actions.populateAllCommentStores.mockReturnValue({ type: 'POPULATE_ALL_COMMENTS' })
    mockAuth.isAuthenticated = true
    mockAuth.isLoading = false
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('renders the Moderate heading', () => {
    renderWithProviders(<CommentModeration />)
    expect(screen.getByText('Moderate')).toBeInTheDocument()
  })

  it('renders navigation tabs with correct labels', () => {
    renderWithProviders(<CommentModeration />)
    expect(screen.getByTestId('mod-queue')).toHaveTextContent('Unmoderated')
    expect(screen.getByTestId('filter-approved')).toHaveTextContent('Accepted')
    expect(screen.getByTestId('filter-rejected')).toHaveTextContent('Rejected')
  })

  it('displays count of unmoderated comments', () => {
    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: [
          { tid: 1, txt: 'Comment 1' },
          { tid: 2, txt: 'Comment 2' },
          { tid: 3, txt: 'Comment 3' }
        ]
      }
    })

    renderWithProviders(<CommentModeration />, { store })
    expect(screen.getByTestId('mod-queue')).toHaveTextContent('Unmoderated 3')
  })

  it('displays count of accepted comments', () => {
    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: [
          { tid: 1, txt: 'Accepted 1' },
          { tid: 2, txt: 'Accepted 2' }
        ]
      }
    })

    renderWithProviders(<CommentModeration />, { store })
    expect(screen.getByTestId('filter-approved')).toHaveTextContent('Accepted 2')
  })

  it('displays count of rejected comments', () => {
    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: [{ tid: 1, txt: 'Rejected 1' }]
      }
    })

    renderWithProviders(<CommentModeration />, { store })
    expect(screen.getByTestId('filter-rejected')).toHaveTextContent('Rejected 1')
  })

  it('does not show count when comments are not an array', () => {
    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: null
      }
    })

    renderWithProviders(<CommentModeration />, { store })
    const unmoderatodLink = screen.getByTestId('mod-queue')
    // Should just show "Unmoderated" without a count
    expect(unmoderatodLink.textContent.trim()).toBe('Unmoderated')
  })

  it('loads comments on mount', () => {
    renderWithProviders(<CommentModeration />)

    expect(actions.populateAllCommentStores).toHaveBeenCalledWith('test123', 50, 0)
  })

  it('starts polling after mount', async () => {
    renderWithProviders(<CommentModeration />)

    // Component loads comments once on mount
    expect(actions.populateAllCommentStores).toHaveBeenCalledTimes(1)

    // Advance time by 60 seconds
    jest.advanceTimersByTime(60000)

    await waitFor(() => {
      expect(actions.populateAllCommentStores).toHaveBeenCalledTimes(2)
    })

    // Advance another 60 seconds
    jest.advanceTimersByTime(60000)

    await waitFor(() => {
      expect(actions.populateAllCommentStores).toHaveBeenCalledTimes(3)
    })
  })

  it('stops polling on unmount', () => {
    const { unmount } = renderWithProviders(<CommentModeration />)

    // Component loads comments once on mount
    expect(actions.populateAllCommentStores).toHaveBeenCalledTimes(1)

    unmount()

    // Advance time after unmount
    jest.advanceTimersByTime(120000)

    // Should not have made any more calls after unmount
    expect(actions.populateAllCommentStores).toHaveBeenCalledTimes(1)
  })

  it('does not load comments when auth is loading', () => {
    mockAuth.isLoading = true

    renderWithProviders(<CommentModeration />)

    expect(actions.populateAllCommentStores).not.toHaveBeenCalled()
  })

  it('loads comments when auth finishes loading', async () => {
    mockAuth.isLoading = true

    const { rerender } = renderWithProviders(<CommentModeration />)

    expect(actions.populateAllCommentStores).not.toHaveBeenCalled()

    // Simulate auth finishing loading
    mockAuth.isLoading = false

    rerender(
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}>
        <ThemeUIProvider theme={theme}>
          <Provider store={createMockStore()}>
            <CommentModeration />
          </Provider>
        </ThemeUIProvider>
      </Router>
    )

    await waitFor(() => {
      expect(actions.populateAllCommentStores).toHaveBeenCalledWith('test123', 50, 0)
    })
  })

  it('renders navigation tabs with correct data-testids', () => {
    renderWithProviders(<CommentModeration />)

    const unmoderatodLink = screen.getByTestId('mod-queue')
    const acceptedLink = screen.getByTestId('filter-approved')
    const rejectedLink = screen.getByTestId('filter-rejected')

    expect(unmoderatodLink).toBeInTheDocument()
    expect(acceptedLink).toBeInTheDocument()
    expect(rejectedLink).toBeInTheDocument()
  })
})
