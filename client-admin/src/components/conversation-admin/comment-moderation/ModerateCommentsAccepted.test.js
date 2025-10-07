import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import * as actions from '../../../actions'
import ModerateCommentsAccepted from './ModerateCommentsAccepted'
import theme from '../../../theme'

// Mock the Comment component
jest.mock('./Comment', () => {
  return function MockComment({ comment, rejectButton, acceptButton }) {
    return (
      <div data-testid="comment">
        <span>{comment.txt}</span>
        {rejectButton && <button>Reject</button>}
        {acceptButton && <button>Accept</button>}
      </div>
    )
  }
})

// Mock actions
jest.mock('../../../actions', () => ({
  changeCommentStatusToRejected: jest.fn(),
  changeCommentCommentIsMeta: jest.fn()
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
    mod_comments_accepted: {
      accepted_comments: [],
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

describe('ModerateCommentsAccepted', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.changeCommentStatusToRejected.mockReturnValue({ type: 'REJECT_COMMENT' })
    actions.changeCommentCommentIsMeta.mockReturnValue({ type: 'UPDATE_META' })
  })

  it('renders loading state when comments are null', () => {
    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: null
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })
    expect(screen.getByText('Loading accepted comments...')).toBeInTheDocument()
  })

  it('renders loading state when comments are not an array', () => {
    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: 'invalid'
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })
    expect(screen.getByText('Loading accepted comments...')).toBeInTheDocument()
  })

  it('renders list of accepted comments', () => {
    const mockComments = [
      { tid: 1, txt: 'Accepted comment 1', created: 123 },
      { tid: 2, txt: 'Accepted comment 2', created: 124 },
      { tid: 3, txt: 'Accepted comment 3', created: 125 }
    ]

    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })

    expect(screen.getByText('Accepted comment 1')).toBeInTheDocument()
    expect(screen.getByText('Accepted comment 2')).toBeInTheDocument()
    expect(screen.getByText('Accepted comment 3')).toBeInTheDocument()
  })

  it('renders all accepted comments without limit', () => {
    // Create 150 mock comments to verify no limit
    const mockComments = Array.from({ length: 150 }, (_, i) => ({
      tid: i,
      txt: `Accepted ${i}`,
      created: 1000 + i
    }))

    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })

    // Should render all 150 comments (no 100 comment limit like in Todo)
    const comments = screen.getAllByTestId('comment')
    expect(comments).toHaveLength(150)
  })

  it('renders empty list when there are no accepted comments', () => {
    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: []
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })

    // Should show the container but no comments
    expect(screen.getByTestId('approved-comments')).toBeInTheDocument()
    expect(screen.queryByTestId('comment')).not.toBeInTheDocument()
  })

  it('passes correct props to Comment component', () => {
    const mockComments = [{ tid: 1, txt: 'Test comment', created: 123 }]

    const store = createMockStore({
      mod_comments_accepted: {
        accepted_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsAccepted />, { store })

    // Comment component should receive reject button but NOT accept button
    const commentEl = screen.getByTestId('comment')
    expect(commentEl).toBeInTheDocument()
    expect(screen.getByText('Reject')).toBeInTheDocument()
    expect(screen.queryByText('Accept')).not.toBeInTheDocument()
  })

  it('renders with correct test id', () => {
    const store = createMockStore()
    renderWithProviders(<ModerateCommentsAccepted />, { store })
    expect(screen.getByTestId('approved-comments')).toBeInTheDocument()
  })
})
