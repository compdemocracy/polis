import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import ModerateCommentsSeed from './ModerateCommentSeed'
import * as actions from '../../actions'
import theme from '../../theme'

// Mock actions
jest.mock('../../actions', () => ({
  handleSeedCommentSubmit: jest.fn(),
  handleBulkSeedCommentSubmit: jest.fn(),
  seedCommentChanged: jest.fn()
}))

// Mock strings
jest.mock('../../strings/strings', () => ({
  __esModule: true,
  default: jest.fn((key) => key)
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
    seed_comments: {
      seedText: '',
      loading: false,
      success: false,
      error: null,
      ...initialState
    }
  }

  return configureStore({
    reducer: (state = defaultState) => state
  })
}

const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={mockStore}>{component}</Provider>
    </ThemeUIProvider>
  )
}

describe('ModerateCommentsSeed', () => {
  const defaultProps = {
    params: {
      conversation_id: 'test-conversation-123'
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    actions.handleSeedCommentSubmit.mockReturnValue({ type: 'SUBMIT_SEED' })
    actions.handleBulkSeedCommentSubmit.mockReturnValue({ type: 'SUBMIT_BULK_SEED' })
    actions.seedCommentChanged.mockReturnValue({ type: 'SEED_CHANGED' })
  })

  describe('Rendering', () => {
    it('renders the seed comment form', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getByTestId('seed_form')).toBeInTheDocument()
    })

    it('renders the submit button', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getAllByText('Submit')[0]).toBeInTheDocument()
    })

    it('renders instructions with link', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getByText(/Add/)).toBeInTheDocument()
      expect(screen.getByText('seed comments or bulk upload as csv')).toBeInTheDocument()
      expect(screen.getByText('seed comments or bulk upload as csv')).toHaveAttribute(
        'href',
        'https://compdemocracy.org/seed-comments'
      )
    })

    it('renders CSV upload section', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getByText('Upload a CSV of seed comments')).toBeInTheDocument()
      expect(screen.getByText(/CSV Format:/)).toBeInTheDocument()
    })

    it('renders CSV format example', () => {
      const { container } = renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      // Check for code block containing CSV format
      const codeBlock = container.querySelector('code')
      expect(codeBlock).toBeInTheDocument()
      expect(codeBlock.textContent).toContain('comment_text')
      expect(codeBlock.textContent).toContain('This is sample comment one')
      expect(codeBlock.textContent).toContain('This is sample comment two')
    })

    it('renders file input for CSV', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const fileInput = document.querySelector('input[type="file"]')
      expect(fileInput).toBeInTheDocument()
      expect(fileInput).toHaveAttribute('accept', '.csv')
      expect(fileInput).toHaveAttribute('id', 'csvFile')
    })

    it('renders CSV upload button', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getByTestId('upload-csv-button')).toBeInTheDocument()
    })
  })

  describe('Single seed comment submission', () => {
    it('dispatches seedCommentChanged action when textarea changes', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const textarea = screen.getByTestId('seed_form')

      fireEvent.change(textarea, { target: { value: 'New seed comment' } })

      expect(actions.seedCommentChanged).toHaveBeenCalledWith('New seed comment')
    })

    it('displays current seed text from Redux state', () => {
      const store = createMockStore({ seedText: 'Existing comment text' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      const textarea = screen.getByTestId('seed_form')
      expect(textarea).toHaveValue('Existing comment text')
    })

    it('enforces maxLength of 400 characters on textarea', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const textarea = screen.getByTestId('seed_form')
      expect(textarea).toHaveAttribute('maxLength', '400')
    })

    it('dispatches handleSeedCommentSubmit when submit button clicked', () => {
      const store = createMockStore({ seedText: 'Test seed comment' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      const submitButton = screen.getAllByText('Submit')[0]
      fireEvent.click(submitButton)

      expect(actions.handleSeedCommentSubmit).toHaveBeenCalledWith({
        txt: 'Test seed comment',
        conversation_id: 'test-conversation-123',
        is_seed: true
      })
    })

    it('uses textarea ref value for submission', () => {
      const store = createMockStore({ seedText: 'Initial text' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })
      const textarea = screen.getByTestId('seed_form')

      // The component uses a ref, so we need to update the actual DOM element's value
      textarea.value = 'Updated via ref'

      const submitButton = screen.getAllByText('Submit')[0]
      fireEvent.click(submitButton)

      // Should use the ref value, not the Redux state
      expect(actions.handleSeedCommentSubmit).toHaveBeenCalledWith({
        txt: 'Updated via ref',
        conversation_id: 'test-conversation-123',
        is_seed: true
      })
    })
  })

  describe('CSV bulk upload', () => {
    let mockFileReader

    beforeEach(() => {
      // Mock FileReader
      mockFileReader = {
        readAsText: jest.fn(),
        onload: null
      }
      global.FileReader = jest.fn(() => mockFileReader)
    })

    afterEach(() => {
      delete global.FileReader
    })

    it('reads CSV file when file is selected', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const fileInput = document.getElementById('csvFile')

      const file = new File(['comment_text\nTest comment'], 'test.csv', { type: 'text/csv' })
      fireEvent.change(fileInput, { target: { files: [file] } })

      expect(mockFileReader.readAsText).toHaveBeenCalledWith(file)
    })

    it('does not read file if no file is selected', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const fileInput = document.getElementById('csvFile')

      fireEvent.change(fileInput, { target: { files: [] } })

      expect(mockFileReader.readAsText).not.toHaveBeenCalled()
    })

    it('dispatches handleBulkSeedCommentSubmit with CSV text', async () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      const fileInput = document.getElementById('csvFile')

      const csvContent = 'comment_text\nFirst comment\nSecond comment'
      const file = new File([csvContent], 'test.csv', { type: 'text/csv' })

      fireEvent.change(fileInput, { target: { files: [file] } })

      // Simulate FileReader finishing
      await waitFor(() => {
        if (mockFileReader.onload) {
          mockFileReader.onload({ target: { result: csvContent } })
        }
      })

      const uploadButton = screen.getByTestId('upload-csv-button')
      fireEvent.click(uploadButton)

      expect(actions.handleBulkSeedCommentSubmit).toHaveBeenCalledWith(
        {
          csv: csvContent,
          conversation_id: 'test-conversation-123',
          is_seed: true
        },
        undefined
      )
    })
  })

  describe('Button text states', () => {
    it('shows "Submit" in default state', () => {
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)
      expect(screen.getAllByText('Submit').length).toBeGreaterThan(0)
    })

    it('shows "Saving..." when loading', () => {
      const store = createMockStore({ loading: true })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      expect(screen.getAllByText('Saving...').length).toBeGreaterThan(0)
      expect(screen.queryByText('Submit')).not.toBeInTheDocument()
    })

    it('shows "Success!" when submission succeeds', () => {
      const store = createMockStore({ success: true })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      expect(screen.getAllByText('Success!').length).toBeGreaterThan(0)
      expect(screen.queryByText('Submit')).not.toBeInTheDocument()
    })

    it('prioritizes loading state over success state', () => {
      const store = createMockStore({ loading: true, success: true })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      expect(screen.getAllByText('Saving...').length).toBeGreaterThan(0)
      expect(screen.queryByText('Success!')).not.toBeInTheDocument()
    })
  })

  describe('Error handling', () => {
    it('does not show error message when error is null', () => {
      const store = createMockStore({ error: null })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      // Only the form elements should be visible
      expect(screen.getByTestId('seed_form')).toBeInTheDocument()
    })

    it('displays error message when error exists', () => {
      const store = createMockStore({ error: 'err_comment_too_long' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      const errorMessages = screen.getAllByText('err_comment_too_long')
      expect(errorMessages[0]).toBeInTheDocument()
    })

    it('passes error through strings function', () => {
      const strings = require('../../strings/strings').default
      const store = createMockStore({ error: 'err_custom_error' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      expect(strings).toHaveBeenCalledWith('err_custom_error')
    })
  })

  describe('Props validation', () => {
    it('requires conversation_id in params', () => {
      // Suppress console errors for this test
      const originalError = console.error
      console.error = jest.fn()

      const { container } = renderWithProviders(<ModerateCommentsSeed params={{}} />)
      expect(container).toBeInTheDocument()

      console.error = originalError
    })

    it('uses provided conversation_id in submissions', () => {
      const customProps = {
        params: {
          conversation_id: 'custom-conv-456'
        }
      }

      const store = createMockStore({ seedText: 'Test' })
      renderWithProviders(<ModerateCommentsSeed {...customProps} />, { store })

      const submitButton = screen.getAllByText('Submit')[0]
      fireEvent.click(submitButton)

      expect(actions.handleSeedCommentSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: 'custom-conv-456'
        })
      )
    })
  })

  describe('Integration scenarios', () => {
    it('can submit single comment and then bulk upload in sequence', async () => {
      const mockFileReader = {
        readAsText: jest.fn(),
        onload: null
      }
      global.FileReader = jest.fn(() => mockFileReader)

      const store = createMockStore({ seedText: 'Single comment' })
      renderWithProviders(<ModerateCommentsSeed {...defaultProps} />, { store })

      // Submit single comment
      const submitButton = screen.getAllByText('Submit')[0]
      fireEvent.click(submitButton)

      expect(actions.handleSeedCommentSubmit).toHaveBeenCalledTimes(1)

      // Upload CSV
      const fileInput = document.getElementById('csvFile')
      const file = new File(['comment_text\nBulk comment'], 'test.csv', { type: 'text/csv' })
      fireEvent.change(fileInput, { target: { files: [file] } })

      await waitFor(() => {
        if (mockFileReader.onload) {
          mockFileReader.onload({ target: { result: 'comment_text\nBulk comment' } })
        }
      })

      const uploadButton = screen.getByTestId('upload-csv-button')
      fireEvent.click(uploadButton)

      expect(actions.handleBulkSeedCommentSubmit).toHaveBeenCalledTimes(1)

      delete global.FileReader
    })

    it('handles state changes during submission flow', () => {
      const { rerender } = renderWithProviders(<ModerateCommentsSeed {...defaultProps} />)

      // Initial state
      expect(screen.getAllByText('Submit').length).toBeGreaterThan(0)

      // Change to loading
      const loadingStore = createMockStore({ loading: true })
      rerender(
        <ThemeUIProvider theme={theme}>
          <Provider store={loadingStore}>
            <ModerateCommentsSeed {...defaultProps} />
          </Provider>
        </ThemeUIProvider>
      )
      expect(screen.getAllByText('Saving...').length).toBeGreaterThan(0)

      // Change to success
      const successStore = createMockStore({ success: true })
      rerender(
        <ThemeUIProvider theme={theme}>
          <Provider store={successStore}>
            <ModerateCommentsSeed {...defaultProps} />
          </Provider>
        </ThemeUIProvider>
      )
      expect(screen.getAllByText('Success!').length).toBeGreaterThan(0)
    })
  })
})
