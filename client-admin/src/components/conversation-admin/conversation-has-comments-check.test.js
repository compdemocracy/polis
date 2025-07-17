import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import ConversationHasCommentsCheck from './conversation-has-comments-check'
import { mockAuth } from '../../test-utils'

// Mock the useAuth hook directly for this test file
jest.mock('react-oidc-context', () => ({
  useAuth: () => mockAuth
}))

// Create a minimal mock store
const createMockStore = (initialState = {}) => {
  return configureStore({
    reducer: {
      mod_comments_accepted: (state = { accepted_comments: [] }) => state,
      mod_comments_rejected: (state = { rejected_comments: [] }) => state,
      mod_comments_unmoderated: (state = { unmoderated_comments: [] }) => state
    },
    preloadedState: {
      mod_comments_accepted: { accepted_comments: [] },
      mod_comments_rejected: { rejected_comments: [] },
      mod_comments_unmoderated: { unmoderated_comments: [] },
      ...initialState
    }
  })
}

const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return render(<Provider store={mockStore}>{component}</Provider>)
}

describe('ConversationHasCommentsCheck', () => {
  beforeEach(() => {
    // Reset Auth mock state
    mockAuth.isLoading = false
    mockAuth.isAuthenticated = true
  })

  it('should show loading state when comments are null', () => {
    // Test the loading state when comments haven't been loaded yet
    const store = createMockStore({
      mod_comments_accepted: { accepted_comments: null, loading: true },
      mod_comments_rejected: { rejected_comments: null, loading: true },
      mod_comments_unmoderated: { unmoderated_comments: null, loading: true }
    })

    renderWithProviders(
      <ConversationHasCommentsCheck conversation_id="test123" strict_moderation={false} />,
      { store }
    )

    expect(screen.getByText(/Loading accepted comments.../)).toBeInTheDocument()
  })

  it('should display warning when no comments exist', () => {
    // Test the "no comments" warning when all comment arrays are empty
    const store = createMockStore({
      mod_comments_accepted: { accepted_comments: [], loading: false },
      mod_comments_rejected: { rejected_comments: [], loading: false },
      mod_comments_unmoderated: { unmoderated_comments: [], loading: false }
    })

    renderWithProviders(
      <ConversationHasCommentsCheck conversation_id="test123" strict_moderation={false} />,
      { store }
    )

    expect(screen.getByText(/This conversation has no comments/)).toBeInTheDocument()
    expect(screen.getByText(/Go to 'Configure' and then 'Seed Comments'/)).toBeInTheDocument()
  })

  it('should display warning for strict moderation with unmoderated comments', () => {
    // Test strict moderation warning when there are unmoderated comments but no accepted ones
    const store = createMockStore({
      mod_comments_accepted: { accepted_comments: [], loading: false },
      mod_comments_rejected: { rejected_comments: [], loading: false },
      mod_comments_unmoderated: {
        unmoderated_comments: [{ id: 1, text: 'test comment' }],
        loading: false
      }
    })

    renderWithProviders(
      <ConversationHasCommentsCheck conversation_id="test123" strict_moderation={true} />,
      { store }
    )

    expect(screen.getByText(/This conversation has no visible comments/)).toBeInTheDocument()
    expect(screen.getByText(/moderate the comments that exist/)).toBeInTheDocument()
  })

  it('should not display warning when there are visible comments', () => {
    // Test that no warning is shown when there are accepted comments
    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: [{ id: 1, text: 'accepted comment' }],
        loading: false
      },
      mod_comments_rejected: { rejected_comments: [], loading: false },
      mod_comments_unmoderated: { unmoderated_comments: [], loading: false }
    })

    renderWithProviders(
      <ConversationHasCommentsCheck conversation_id="test123" strict_moderation={false} />,
      { store }
    )

    expect(screen.queryByText(/This conversation has no comments/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Loading accepted comments/)).not.toBeInTheDocument()
  })

  it('should show loading when Auth is still loading', () => {
    // Test loading state when Auth is still initializing
    mockAuth.isLoading = true

    const store = createMockStore({
      mod_comments_accepted: { accepted_comments: [], loading: false },
      mod_comments_rejected: { rejected_comments: [], loading: false },
      mod_comments_unmoderated: { unmoderated_comments: [], loading: false }
    })

    renderWithProviders(
      <ConversationHasCommentsCheck conversation_id="test123" strict_moderation={false} />,
      { store }
    )

    expect(screen.getByText(/Loading accepted comments.../)).toBeInTheDocument()
  })
})
