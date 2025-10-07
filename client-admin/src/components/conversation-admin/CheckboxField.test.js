import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import { CheckboxField } from './CheckboxField'
import { ConversationDataProvider } from '../../util/conversation_data'
import * as actions from '../../actions'
import theme from '../../theme'

// Mock the actions
jest.mock('../../actions', () => ({
  handleConversationDataUpdate: jest.fn()
}))

// Create a mock store
const createMockStore = (initialState = {}) => {
  return configureStore({
    reducer: () => ({
      conversationData: {
        is_active: true,
        vis_type: 1,
        write_type: 1,
        help_type: 0,
        ...initialState
      }
    })
  })
}

// Wrapper to provide theme and store context
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

describe('CheckboxField', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders without crashing', () => {
    renderWithProviders(
      <CheckboxField field="is_active" label="Active">
        This is a test checkbox
      </CheckboxField>
    )
    expect(screen.getByText('This is a test checkbox')).toBeInTheDocument()
  })

  it('displays checkbox with correct initial state', () => {
    const store = createMockStore({ is_active: true })
    renderWithProviders(
      <CheckboxField field="is_active" label="Active">
        Test content
      </CheckboxField>,
      { store }
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('handles boolean field changes', () => {
    actions.handleConversationDataUpdate.mockReturnValue({ type: 'TEST' })

    renderWithProviders(
      <CheckboxField field="is_active" label="Active">
        Test content
      </CheckboxField>
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    expect(actions.handleConversationDataUpdate).toHaveBeenCalled()
  })

  it('handles integer boolean field changes', () => {
    actions.handleConversationDataUpdate.mockReturnValue({ type: 'TEST' })

    renderWithProviders(
      <CheckboxField field="vis_type" label="Visualization" isIntegerBool>
        Show visualization
      </CheckboxField>
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    expect(actions.handleConversationDataUpdate).toHaveBeenCalled()
  })

  it('renders unchecked for false boolean value', () => {
    const store = createMockStore({ is_active: false })
    renderWithProviders(
      <CheckboxField field="is_active" label="Active">
        Test content
      </CheckboxField>,
      { store }
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
  })

  it('renders unchecked for 0 integer boolean value', () => {
    const store = createMockStore({ vis_type: 0 })
    renderWithProviders(
      <CheckboxField field="vis_type" label="Visualization" isIntegerBool>
        Test content
      </CheckboxField>,
      { store }
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).not.toBeChecked()
  })

  it('renders checked for 1 integer boolean value', () => {
    const store = createMockStore({ vis_type: 1 })
    renderWithProviders(
      <CheckboxField field="vis_type" label="Visualization" isIntegerBool>
        Test content
      </CheckboxField>,
      { store }
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('has correct data-testid attribute', () => {
    renderWithProviders(
      <CheckboxField field="test_field" label="Test">
        Test content
      </CheckboxField>
    )
    const checkbox = screen.getByTestId('test_field')
    expect(checkbox).toBeInTheDocument()
  })
})
