import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import * as actions from '../../../actions'
import ModerateCommentsTodo from './ModerateCommentsTodo'
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
  changeCommentStatusToRejected: jest.fn(),
  changeCommentCommentIsMeta: jest.fn()
}))

const createMockStore = (initialState = {}) => {
  const defaultState = {
    mod_comments_unmoderated: {
      unmoderated_comments: [],
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

describe('ModerateCommentsTodo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    actions.changeCommentStatusToAccepted.mockReturnValue({ type: 'ACCEPT_COMMENT' })
    actions.changeCommentStatusToRejected.mockReturnValue({ type: 'REJECT_COMMENT' })
    actions.changeCommentCommentIsMeta.mockReturnValue({ type: 'UPDATE_META' })
  })

  it('renders loading state when comments are null', () => {
    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: null
      }
    })

    renderWithProviders(<ModerateCommentsTodo />, { store })
    expect(screen.getByText('Loading unmoderated comments...')).toBeInTheDocument()
  })

  it('renders loading state when comments are not an array', () => {
    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: 'invalid'
      }
    })

    renderWithProviders(<ModerateCommentsTodo />, { store })
    expect(screen.getByText('Loading unmoderated comments...')).toBeInTheDocument()
  })

  it('renders list of unmoderated comments', () => {
    const mockComments = [
      { tid: 1, txt: 'First comment', created: 123 },
      { tid: 2, txt: 'Second comment', created: 124 },
      { tid: 3, txt: 'Third comment', created: 125 }
    ]

    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsTodo />, { store })

    expect(screen.getByText('First comment')).toBeInTheDocument()
    expect(screen.getByText('Second comment')).toBeInTheDocument()
    expect(screen.getByText('Third comment')).toBeInTheDocument()
  })

  it('renders empty list when there are no unmoderated comments', () => {
    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: []
      }
    })

    renderWithProviders(<ModerateCommentsTodo />, { store })

    // Should show the container but no comments
    expect(screen.getByTestId('pending-comment')).toBeInTheDocument()
    expect(screen.queryByTestId('comment')).not.toBeInTheDocument()
  })

  it('passes correct props to Comment component', () => {
    const mockComments = [{ tid: 1, txt: 'Test comment', created: 123 }]

    const store = createMockStore({
      mod_comments_unmoderated: {
        unmoderated_comments: mockComments
      }
    })

    renderWithProviders(<ModerateCommentsTodo />, { store })

    // Comment component should receive both accept and reject buttons
    const commentEl = screen.getByTestId('comment')
    expect(commentEl).toBeInTheDocument()
    expect(screen.getByText('Accept')).toBeInTheDocument()
    expect(screen.getByText('Reject')).toBeInTheDocument()
  })
})
