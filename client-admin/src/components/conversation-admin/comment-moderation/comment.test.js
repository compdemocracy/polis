import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../../theme'
import Comment from './comment'

// Create a mock store
const createMockStore = (conversationData = {}) => {
  return configureStore({
    reducer: () => ({
      zid_metadata: {
        zid_metadata: {
          conversation_id: 'test123',
          ...conversationData
        }
      }
    })
  })
}

// Wrapper to provide theme and store context
const renderWithProviders = (component, { store } = {}) => {
  const mockStore = store || createMockStore()
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={mockStore}>{component}</Provider>
    </ThemeUIProvider>
  )
}

describe('Comment', () => {
  const mockComment = {
    txt: 'This is a test comment',
    tid: 1,
    created: 1234567890,
    pid: 5,
    is_meta: false,
    active: true
  }

  const defaultProps = {
    comment: mockComment,
    acceptClickHandler: jest.fn(),
    rejectClickHandler: jest.fn(),
    toggleIsMetaHandler: jest.fn(),
    acceptButton: true,
    acceptButtonText: 'Accept',
    rejectButton: true,
    rejectButtonText: 'Reject',
    isMetaCheckbox: true
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders without crashing', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    expect(screen.getByText('This is a test comment')).toBeInTheDocument()
  })

  it('displays comment text', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    expect(screen.getByText('This is a test comment')).toBeInTheDocument()
  })

  it('shows accept button when acceptButton is true', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    expect(screen.getByText('Accept')).toBeInTheDocument()
  })

  it('shows reject button when rejectButton is true', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    expect(screen.getByText('Reject')).toBeInTheDocument()
  })

  it('hides accept button when acceptButton is false', () => {
    renderWithProviders(<Comment {...defaultProps} acceptButton={false} />)
    expect(screen.queryByText('Accept')).not.toBeInTheDocument()
  })

  it('hides reject button when rejectButton is false', () => {
    renderWithProviders(<Comment {...defaultProps} rejectButton={false} />)
    expect(screen.queryByText('Reject')).not.toBeInTheDocument()
  })

  it('calls acceptClickHandler when accept button is clicked', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    const acceptButton = screen.getByText('Accept')
    fireEvent.click(acceptButton)
    expect(defaultProps.acceptClickHandler).toHaveBeenCalledWith(mockComment)
  })

  it('calls rejectClickHandler when reject button is clicked', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    const rejectButton = screen.getByText('Reject')
    fireEvent.click(rejectButton)
    expect(defaultProps.rejectClickHandler).toHaveBeenCalledWith(mockComment)
  })

  it('shows metadata checkbox when isMetaCheckbox is true', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeInTheDocument()
    expect(screen.getByText('metadata')).toBeInTheDocument()
  })

  it('hides metadata checkbox when isMetaCheckbox is false', () => {
    renderWithProviders(<Comment {...defaultProps} isMetaCheckbox={false} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText('metadata')).not.toBeInTheDocument()
  })

  it('displays metadata checkbox as checked when comment is_meta is true', () => {
    const metaComment = { ...mockComment, is_meta: true }
    renderWithProviders(<Comment {...defaultProps} comment={metaComment} />)
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeChecked()
  })

  it('calls toggleIsMetaHandler when metadata checkbox is clicked', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(defaultProps.toggleIsMetaHandler).toHaveBeenCalledWith(mockComment, true)
  })

  it('shows warning message for flagged comments', () => {
    const flaggedComment = { ...mockComment, active: false }
    renderWithProviders(<Comment {...defaultProps} comment={flaggedComment} />)
    expect(screen.getByText(/Comment flagged by Polis Auto Moderator API/)).toBeInTheDocument()
  })

  it('does not show warning message for active comments', () => {
    renderWithProviders(<Comment {...defaultProps} />)
    expect(
      screen.queryByText(/Comment flagged by Polis Auto Moderator API/)
    ).not.toBeInTheDocument()
  })

  it('has correct test id for pending comments', () => {
    const { container } = renderWithProviders(<Comment {...defaultProps} />)
    const card = container.querySelector('[data-testid="pending-comment"]')
    expect(card).toBeInTheDocument()
  })
})
