import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import * as actions from '../../../actions'
import ModerateCommentsRejected from './ModerateCommentsRejected'
import theme from '../../../theme'

// Mock the Comment component
jest.mock('./Comment', () => {
  return function MockComment({ comment, acceptButton, rejectButton }) {
    return (
      <div data-testid="comment">
        <span>{comment.txt}</span>
        {acceptButton && <button>Accept</button>}
        {rejectButton && <button>Reject</button>}
      </div>
    )
  }
})

// Mock actions
jest.mock('../../../actions', () => ({
  changeCommentStatusToAccepted: jest.fn(),
  changeCommentCommentIsMeta: jest.fn()
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
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
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={mockStore}>{component}</Provider>
    </ThemeUIProvider>
  )
}

describe('ModerateCommentsRejected', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.changeCommentStatusToAccepted.mockReturnValue({ type: 'ACCEPT_COMMENT' })
    actions.changeCommentCommentIsMeta.mockReturnValue({ type: 'UPDATE_META' })
  })

  it('renders loading state when comments are null', () => {
    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: null
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })
    expect(screen.getByText('Loading rejected comments...')).toBeInTheDocument()
  })

  it('renders loading state when comments are not an array', () => {
    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: 'invalid'
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })
    expect(screen.getByText('Loading rejected comments...')).toBeInTheDocument()
  })

  it('renders list of rejected comments', () => {
    const mockComments = [
      { tid: 1, txt: 'Rejected comment 1', created: 123 },
      { tid: 2, txt: 'Rejected comment 2', created: 124 },
      { tid: 3, txt: 'Rejected comment 3', created: 125 }
    ]

    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })

    expect(screen.getByText('Rejected comment 1')).toBeInTheDocument()
    expect(screen.getByText('Rejected comment 2')).toBeInTheDocument()
    expect(screen.getByText('Rejected comment 3')).toBeInTheDocument()
  })

  it('renders all rejected comments without limit', () => {
    // Create 150 mock comments to verify no limit
    const mockComments = Array.from({ length: 150 }, (_, i) => ({
      tid: i,
      txt: `Rejected ${i}`,
      created: 1000 + i
    }))

    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })

    // Should render all 150 comments (no 100 comment limit like in Todo)
    const comments = screen.getAllByTestId('comment')
    expect(comments).toHaveLength(150)
  })

  it('renders empty list when there are no rejected comments', () => {
    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: []
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })

    // Should show the container but no comments
    expect(screen.getByTestId('rejected-comments')).toBeInTheDocument()
    expect(screen.queryByTestId('comment')).not.toBeInTheDocument()
  })

  it('passes correct props to Comment component', () => {
    const mockComments = [{ tid: 1, txt: 'Test comment', created: 123 }]

    const store = createMockStore({
      mod_comments_rejected: {
        rejected_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsRejected />, { store })

    // Comment component should receive accept button but NOT reject button
    const commentEl = screen.getByTestId('comment')
    expect(commentEl).toBeInTheDocument()
    expect(screen.getByText('Accept')).toBeInTheDocument()
    expect(screen.queryByText('Reject')).not.toBeInTheDocument()
  })

  it('renders with correct test id', () => {
    const store = createMockStore()
    renderWithProviders(<ModerateCommentsRejected />, { store })
    expect(screen.getByTestId('rejected-comments')).toBeInTheDocument()
  })
})
