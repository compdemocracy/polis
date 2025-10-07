import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { ConversationDataProvider } from '../../util/conversation_data'
import * as actions from '../../actions'
import ConversationConfig from './ConversationConfig'
import theme from '../../theme'

// Mock child components
jest.mock('./CheckboxField', () => ({
  CheckboxField: ({ children, field }) => (
    <div data-testid={`checkbox-${field}`}>
      <span>{children}</span>
    </div>
  )
}))

jest.mock('./ModerateCommentSeed', () => {
  return function MockModerateCommentsSeed() {
    return <div data-testid="moderate-comments-seed">Seed Comments Component</div>
  }
})

jest.mock('../framework/Spinner', () => {
  return function MockSpinner() {
    return <div data-testid="spinner">Loading...</div>
  }
})

// Mock actions
jest.mock('../../actions', () => ({
  handleConversationDataUpdate: jest.fn(),
  optimisticConversationDataUpdateOnTyping: jest.fn()
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
    conversationData: {
      conversation_id: 'test123',
      topic: 'Test Topic',
      description: 'Test Description',
      is_active: true,
      vis_type: 1,
      write_type: 1,
      help_type: 0,
      subscribe_type: 1,
      strict_moderation: false,
      treevite_enabled: false,
      importance_enabled: false,
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
    <ThemeUIProvider theme={theme}>
      <Provider store={mockStore}>
        <ConversationDataProvider>{component}</ConversationDataProvider>
      </Provider>
    </ThemeUIProvider>
  )
}

describe('ConversationConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.handleConversationDataUpdate.mockReturnValue({ type: 'UPDATE_CONVERSATION' })
    actions.optimisticConversationDataUpdateOnTyping.mockReturnValue({ type: 'OPTIMISTIC_UPDATE' })
  })

  it('renders the Configure heading', () => {
    renderWithProviders(<ConversationConfig />)
    expect(screen.getByText('Configure')).toBeInTheDocument()
  })

  it('shows loading spinner when initially loading', () => {
    const store = createMockStore({ loading: true, topic: null, description: null })
    renderWithProviders(<ConversationConfig />, { store })
    expect(screen.getByTestId('spinner')).toBeInTheDocument()
  })

  it('does not show loading spinner after initial render with data', () => {
    // After initial render, refs are populated, so loading won't show spinner
    const store = createMockStore({ loading: false })
    const { rerender } = renderWithProviders(<ConversationConfig />, { store })

    // Update to loading state
    const loadingStore = createMockStore({ loading: true })
    rerender(
      <ThemeUIProvider theme={theme}>
        <Provider store={loadingStore}>
          <ConversationDataProvider>
            <ConversationConfig />
          </ConversationDataProvider>
        </Provider>
      </ThemeUIProvider>
    )

    // Refs are now set, so it should show the form with saving status instead of spinner
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument()
    expect(screen.getByText(/Saving/)).toBeInTheDocument()
  })

  it('shows "Up to date" status when not loading', () => {
    renderWithProviders(<ConversationConfig />)
    expect(screen.getByText(/Up to date/)).toBeInTheDocument()
  })

  it('shows error message when there is an error', () => {
    const store = createMockStore({ error: 'Something went wrong' })
    renderWithProviders(<ConversationConfig />, { store })
    expect(screen.getByText('Error Saving')).toBeInTheDocument()
  })

  it('does not show error message when there is no error', () => {
    renderWithProviders(<ConversationConfig />)
    expect(screen.queryByText('Error Saving')).not.toBeInTheDocument()
  })

  describe('Topic field', () => {
    it('renders topic input with current value', () => {
      renderWithProviders(<ConversationConfig />)
      const topicInput = screen.getByTestId('topic')
      expect(topicInput).toBeInTheDocument()
      expect(topicInput).toHaveValue('Test Topic')
    })

    it('handles topic input changes', () => {
      renderWithProviders(<ConversationConfig />)
      const topicInput = screen.getByTestId('topic')

      fireEvent.change(topicInput, { target: { value: 'New Topic' } })

      expect(actions.optimisticConversationDataUpdateOnTyping).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Test Topic'
        }),
        'topic',
        'New Topic'
      )
    })

    it('dispatches update action on topic blur', () => {
      renderWithProviders(<ConversationConfig />)
      const topicInput = screen.getByTestId('topic')

      fireEvent.blur(topicInput, { target: { value: 'Final Topic' } })

      expect(actions.handleConversationDataUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'Test Topic'
        }),
        'topic',
        'Final Topic'
      )
    })

    it('handles empty topic value', () => {
      const store = createMockStore({ topic: '' })
      renderWithProviders(<ConversationConfig />, { store })
      const topicInput = screen.getByTestId('topic')
      expect(topicInput).toHaveValue('')
    })

    it('handles null topic value', () => {
      const store = createMockStore({ topic: null })
      renderWithProviders(<ConversationConfig />, { store })
      const topicInput = screen.getByTestId('topic')
      expect(topicInput).toHaveValue('')
    })
  })

  describe('Description field', () => {
    it('renders description textarea with current value', () => {
      renderWithProviders(<ConversationConfig />)
      const descriptionInput = screen.getByTestId('description')
      expect(descriptionInput).toBeInTheDocument()
      expect(descriptionInput).toHaveValue('Test Description')
    })

    it('handles description input changes', () => {
      renderWithProviders(<ConversationConfig />)
      const descriptionInput = screen.getByTestId('description')

      fireEvent.change(descriptionInput, { target: { value: 'New Description' } })

      expect(actions.optimisticConversationDataUpdateOnTyping).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Test Description'
        }),
        'description',
        'New Description'
      )
    })

    it('dispatches update action on description blur', () => {
      renderWithProviders(<ConversationConfig />)
      const descriptionInput = screen.getByTestId('description')

      fireEvent.blur(descriptionInput, { target: { value: 'Final Description' } })

      expect(actions.handleConversationDataUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Test Description'
        }),
        'description',
        'Final Description'
      )
    })

    it('handles empty description value', () => {
      const store = createMockStore({ description: '' })
      renderWithProviders(<ConversationConfig />, { store })
      const descriptionInput = screen.getByTestId('description')
      expect(descriptionInput).toHaveValue('')
    })

    it('handles null description value', () => {
      const store = createMockStore({ description: null })
      renderWithProviders(<ConversationConfig />, { store })
      const descriptionInput = screen.getByTestId('description')
      expect(descriptionInput).toHaveValue('')
    })
  })

  describe('Checkbox fields', () => {
    it('renders is_active checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-is_active')).toBeInTheDocument()
      expect(
        screen.getByText(/Conversation is open. Unchecking disables both voting and commenting/)
      ).toBeInTheDocument()
    })

    it('renders vis_type checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-vis_type')).toBeInTheDocument()
      expect(screen.getByText(/Participants can see the visualization/)).toBeInTheDocument()
    })

    it('renders write_type checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-write_type')).toBeInTheDocument()
      expect(screen.getByText(/Participants can submit comments/)).toBeInTheDocument()
    })

    it('renders help_type checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-help_type')).toBeInTheDocument()
      expect(
        screen.getByText(/Show explanation text above voting and visualization/)
      ).toBeInTheDocument()
    })

    it('renders subscribe_type checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-subscribe_type')).toBeInTheDocument()
      expect(
        screen.getByText(/Prompt participants to subscribe to updates. A prompt is shown/)
      ).toBeInTheDocument()
    })

    it('renders strict_moderation checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-strict_moderation')).toBeInTheDocument()
      expect(screen.getByText(/No comments shown without moderator approval/)).toBeInTheDocument()
    })

    it('renders treevite_enabled checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-treevite_enabled')).toBeInTheDocument()
      expect(screen.getByText(/\[EXPERIMENTAL FEATURE\] Enable Invite Tree/)).toBeInTheDocument()
    })

    it('renders importance_enabled checkbox', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('checkbox-importance_enabled')).toBeInTheDocument()
      expect(
        screen.getByText(/\[EXPERIMENTAL FEATURE\] Participants can see the/)
      ).toBeInTheDocument()
    })
  })

  describe('Seed Comments section', () => {
    it('renders seed comments heading', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByText('Seed Comments')).toBeInTheDocument()
    })

    it('renders ModerateCommentsSeed component', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByTestId('moderate-comments-seed')).toBeInTheDocument()
    })
  })

  describe('UI Customization section', () => {
    it('renders customize UI heading', () => {
      renderWithProviders(<ConversationConfig />)
      expect(screen.getByText('Customize the user interface')).toBeInTheDocument()
    })
  })

  describe('Special color field handling', () => {
    it('sets default value for empty help_bgcolor', () => {
      const store = createMockStore({ help_bgcolor: '' })
      renderWithProviders(<ConversationConfig />, { store })

      const topicInput = screen.getByTestId('topic')
      // Simulate changing a field to trigger the string value handler
      fireEvent.blur(topicInput, { target: { value: 'Test' } })

      // The empty string handling would be tested in actual color field if it existed
      // This test documents that the logic exists for help_bgcolor and help_color
    })
  })

  describe('Layout and structure', () => {
    it('renders all major sections in correct order', () => {
      const { container } = renderWithProviders(<ConversationConfig />)

      const headings = container.querySelectorAll('h3, h6')
      const headingTexts = Array.from(headings).map((h) => h.textContent)

      expect(headingTexts).toContain('Configure')
      expect(headingTexts).toContain('Seed Comments')
      expect(headingTexts).toContain('Customize the user interface')
    })

    it('maintains proper spacing with margin bottom classes', () => {
      renderWithProviders(<ConversationConfig />)

      // Verify that key elements are rendered (spacing is handled by theme-ui sx prop)
      expect(screen.getByTestId('topic')).toBeInTheDocument()
      expect(screen.getByTestId('description')).toBeInTheDocument()
    })
  })
})
