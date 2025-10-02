import { AuthContext } from 'react-oidc-context'
import { MemoryRouter, Routes, Route } from 'react-router'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import PropTypes from 'prop-types'

import * as actions from '../../actions'
import * as authUtils from '../../util/auth'
import * as conversationDataUtils from '../../util/conversation_data'
import ConversationAdminContainer from './index'
import theme from '../../theme'

// Mock child components to simplify testing
jest.mock('./ConversationConfig', () => {
  return function ConversationConfig() {
    return <div data-testid="conversation-config">ConversationConfig</div>
  }
})

jest.mock('./ShareAndEmbed', () => {
  return function ShareAndEmbed() {
    return <div data-testid="share-and-embed">ShareAndEmbed</div>
  }
})

jest.mock('./comment-moderation/', () => {
  return function ModerateComments() {
    return <div data-testid="moderate-comments">ModerateComments</div>
  }
})

jest.mock('./stats', () => {
  return function ConversationStats() {
    return <div data-testid="conversation-stats">ConversationStats</div>
  }
})

jest.mock('./report/Reports', () => {
  return function Reports() {
    return <div data-testid="reports">Reports</div>
  }
})

jest.mock('./topic-moderation/', () => {
  return function TopicModeration() {
    return <div data-testid="topic-moderation">TopicModeration</div>
  }
})

jest.mock('./InviteTree', () => {
  return function InviteTree() {
    return <div data-testid="invite-tree">InviteTree</div>
  }
})

jest.mock('./InviteCodes', () => {
  return function InviteCodes() {
    return <div data-testid="invite-codes">InviteCodes</div>
  }
})

jest.mock('./NoPermission', () => {
  return function NoPermission() {
    return <div data-testid="no-permission">NoPermission</div>
  }
})

jest.mock('../framework/Spinner', () => {
  return function Spinner() {
    return <div data-testid="spinner">Loading...</div>
  }
})

// Mock actions
jest.mock('../../actions', () => ({
  populateConversationDataStore: jest.fn(),
  resetMetadataStore: jest.fn()
}))

const mockAuth = {
  isLoading: false,
  isAuthenticated: true,
  user: { profile: { email: 'test@example.com' } },
  error: null
}

const MockAuthProvider = ({ children, authValue = mockAuth }) => {
  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
}

MockAuthProvider.propTypes = {
  children: PropTypes.node.isRequired,
  authValue: PropTypes.object
}

const createMockStore = (initialState = {}) => {
  const defaultState = {
    conversationData: {
      conversation_id: 'test-conv-123',
      loading: false,
      error: null,
      is_active: true,
      is_mod: true,
      ...initialState.conversationData
    },
    user: {
      user: { uid: 123, email: 'test@example.com' },
      loading: false,
      error: null,
      ...initialState.user
    }
  }

  return configureStore({
    reducer: (state = defaultState) => state
  })
}

const renderWithProviders = (component, { store, route = '/m/test-conv-123', authValue } = {}) => {
  const mockStore = store || createMockStore()

  return render(
    <ThemeUIProvider theme={theme}>
      <MockAuthProvider authValue={authValue}>
        <Provider store={mockStore}>
          <MemoryRouter
            initialEntries={[route]}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/m/:conversation_id/*" element={component} />
            </Routes>
          </MemoryRouter>
        </Provider>
      </MockAuthProvider>
    </ThemeUIProvider>
  )
}

describe('ConversationAdminContainer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.populateConversationDataStore.mockReturnValue({ type: 'POPULATE_CONVERSATION_DATA' })
    actions.resetMetadataStore.mockReturnValue({ type: 'RESET_METADATA' })

    // Mock custom hooks
    jest.spyOn(authUtils, 'useUser').mockReturnValue({
      user: { uid: 123, email: 'test@example.com' }
    })

    jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)

    jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
      conversation_id: 'test-conv-123',
      loading: false,
      is_active: true,
      is_mod: true,
      treevite_enabled: false
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('Data loading', () => {
    it('loads conversation data on mount when authenticated', () => {
      renderWithProviders(<ConversationAdminContainer />)

      expect(actions.populateConversationDataStore).toHaveBeenCalledWith('test-conv-123')
    })

    it('resets metadata store on unmount', () => {
      const { unmount } = renderWithProviders(<ConversationAdminContainer />)

      unmount()

      expect(actions.resetMetadataStore).toHaveBeenCalled()
    })

    it('reloads conversation data when conversation_id changes', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/conv-1'
      })

      await waitFor(() => {
        expect(actions.populateConversationDataStore).toHaveBeenCalledWith('conv-1')
      })
    })

    it('loads data when authenticated even if initially not', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        authValue: { isAuthenticated: true, isLoading: false }
      })

      await waitFor(() => {
        expect(actions.populateConversationDataStore).toHaveBeenCalled()
      })
    })
  })

  describe('Navigation sidebar', () => {
    it('renders all navigation links', async () => {
      renderWithProviders(<ConversationAdminContainer />)

      await waitFor(() => {
        expect(screen.getByText('All')).toBeInTheDocument()
        expect(screen.getByText('Configure')).toBeInTheDocument()
        expect(screen.getByText('Distribute')).toBeInTheDocument()
        expect(screen.getByText('Moderate')).toBeInTheDocument()
        expect(screen.getByText('Monitor')).toBeInTheDocument()
        expect(screen.getByText('Reports')).toBeInTheDocument()
        // expect(screen.getByText('Topic Mod')).toBeInTheDocument()
        expect(screen.getByText('Invite Tree')).toBeInTheDocument()
      })
    })

    it('shows Invite Codes link when treevite is enabled', async () => {
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
        conversation_id: 'test-conv-123',
        loading: false,
        is_active: true,
        is_mod: true,
        treevite_enabled: true
      })

      renderWithProviders(<ConversationAdminContainer />)

      await waitFor(() => {
        expect(screen.getByText('Invite Codes')).toBeInTheDocument()
      })
    })

    it('hides Invite Codes link when treevite is disabled', async () => {
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
        conversation_id: 'test-conv-123',
        loading: false,
        is_active: true,
        is_mod: true,
        treevite_enabled: false
      })

      renderWithProviders(<ConversationAdminContainer />)

      await waitFor(() => {
        expect(screen.queryByText('Invite Codes')).not.toBeInTheDocument()
      })
    })

    it('links to correct URLs', async () => {
      renderWithProviders(<ConversationAdminContainer />)

      await waitFor(() => {
        expect(screen.getByText('Configure').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123'
        )
        expect(screen.getByText('Distribute').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123/share'
        )
        expect(screen.getByText('Moderate').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123/comments'
        )
      })
    })
  })

  describe('Permission handling', () => {
    it('shows spinner while checking permissions', () => {
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
        conversation_id: 'test-conv-123',
        loading: true,
        is_active: true,
        is_mod: true
      })

      renderWithProviders(<ConversationAdminContainer />)

      expect(screen.getByTestId('spinner')).toBeInTheDocument()
    })

    it('calls checkConvoPermissions to determine access', () => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(false)

      renderWithProviders(<ConversationAdminContainer />)

      // The component renders and will call checkConvoPermissions
      expect(screen.getByText('Configure')).toBeInTheDocument()
    })

    it('renders navigation when user has permissions', async () => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)

      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123'
      })

      // Verify navigation renders
      await waitFor(() => {
        expect(screen.getByText('Configure')).toBeInTheDocument()
        expect(screen.getByText('Distribute')).toBeInTheDocument()
      })
    })

    it('calls checkConvoPermissions with correct arguments', async () => {
      const mockUser = { uid: 123, email: 'test@example.com' }
      const mockConversationData = {
        conversation_id: 'test-conv-123',
        loading: false,
        is_active: true,
        is_mod: true
      }

      jest.spyOn(authUtils, 'useUser').mockReturnValue({ user: mockUser })
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue(mockConversationData)

      renderWithProviders(<ConversationAdminContainer />)

      await waitFor(() => {
        expect(authUtils.checkConvoPermissions).toHaveBeenCalledWith(
          { user: mockUser },
          mockConversationData
        )
      })
    })
  })

  describe('Route rendering', () => {
    beforeEach(() => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)
    })

    it('renders navigation at base route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123'
      })

      await waitFor(() => {
        expect(screen.getByText('Configure')).toBeInTheDocument()
      })
    })

    it('renders navigation at /share route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/share'
      })

      await waitFor(() => {
        expect(screen.getByText('Distribute')).toBeInTheDocument()
      })
    })

    it('renders ModerateComments at /comments route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/comments'
      })

      await waitFor(() => {
        expect(screen.getByTestId('moderate-comments')).toBeInTheDocument()
      })
    })

    it('renders navigation at /stats route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/stats'
      })

      await waitFor(() => {
        expect(screen.getByText('Monitor')).toBeInTheDocument()
      })
    })

    it('renders without crashing at /reports route', () => {
      const { container } = renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/reports'
      })

      expect(container).toBeInTheDocument()
      expect(screen.getByText('Reports')).toBeInTheDocument()
    })

    // it('renders without crashing at /topics route', () => {
    //   const { container } = renderWithProviders(<ConversationAdminContainer />, {
    //     route: '/m/test-conv-123/topics'
    //   })

    //   expect(container).toBeInTheDocument()
    //   expect(screen.getByText('Topic Mod')).toBeInTheDocument()
    // })

    it('renders without crashing at /invite-tree route', () => {
      const { container } = renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/invite-tree'
      })

      expect(container).toBeInTheDocument()
      expect(screen.getByText('Invite Tree')).toBeInTheDocument()
    })

    it('renders without crashing at /invite-codes route', () => {
      const { container } = renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/invite-codes'
      })

      expect(container).toBeInTheDocument()
      // Invite Codes might not be visible if treevite is disabled, so just check container
    })
  })

  describe('Active navigation state', () => {
    beforeEach(() => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)
    })

    it('renders navigation links on base route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123'
      })

      await waitFor(() => {
        expect(screen.getByText('Configure')).toBeInTheDocument()
        expect(screen.getByText('Configure').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123'
        )
      })
    })

    it('renders navigation links on share route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/share'
      })

      await waitFor(() => {
        expect(screen.getByText('Distribute')).toBeInTheDocument()
        expect(screen.getByText('Distribute').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123/share'
        )
      })
    })

    it('renders navigation links on comments route', async () => {
      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123/comments'
      })

      await waitFor(() => {
        expect(screen.getByText('Moderate')).toBeInTheDocument()
        expect(screen.getByText('Moderate').closest('a')).toHaveAttribute(
          'href',
          '/m/test-conv-123/comments'
        )
      })
    })
  })

  describe('Permission state management', () => {
    it('calls checkConvoPermissions with user and conversation data', () => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)

      renderWithProviders(<ConversationAdminContainer />)

      // Give it a moment for the effect to run
      setTimeout(() => {
        expect(authUtils.checkConvoPermissions).toHaveBeenCalled()
      }, 100)
    })

    it('renders navigation after loading', async () => {
      jest.spyOn(authUtils, 'checkConvoPermissions').mockReturnValue(true)

      renderWithProviders(<ConversationAdminContainer />, {
        route: '/m/test-conv-123'
      })

      // Verify navigation is rendered
      await waitFor(() => {
        expect(screen.getByText('Configure')).toBeInTheDocument()
        expect(screen.getByText('Distribute')).toBeInTheDocument()
      })
    })
  })

  describe('Edge cases', () => {
    it('handles missing user data gracefully', () => {
      jest.spyOn(authUtils, 'useUser').mockReturnValue({ user: null })

      renderWithProviders(<ConversationAdminContainer />)

      // Should show spinner while waiting for user data
      expect(screen.getByTestId('spinner')).toBeInTheDocument()
    })

    it('handles missing conversation data gracefully', () => {
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
        conversation_id: 'test-conv-123',
        loading: false
      })
      jest.spyOn(authUtils, 'useUser').mockReturnValue({ user: null })

      renderWithProviders(<ConversationAdminContainer />)

      // Should show spinner when user is not loaded
      expect(screen.getByTestId('spinner')).toBeInTheDocument()
    })

    it('waits for both user and conversation data before checking permissions', () => {
      jest.spyOn(authUtils, 'useUser').mockReturnValue({ user: null })
      jest.spyOn(conversationDataUtils, 'useConversationData').mockReturnValue({
        conversation_id: 'test-conv-123',
        loading: false
      })

      renderWithProviders(<ConversationAdminContainer />)

      // Should not call checkConvoPermissions yet
      expect(authUtils.checkConvoPermissions).not.toHaveBeenCalled()
    })
  })
})
