import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Conversation from './conversation'

// Wrapper to provide theme context
const renderWithTheme = (component) => {
  return render(<ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>)
}

describe('Conversation', () => {
  const mockProps = {
    c: {
      topic: 'Test Conversation Topic',
      description: 'This is a test conversation description',
      parent_url: 'https://example.com/embed',
      participant_count: 42
    },
    i: 0,
    goToConversation: jest.fn()
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders without crashing', () => {
    renderWithTheme(<Conversation {...mockProps} />)
    expect(screen.getByText('Test Conversation Topic')).toBeInTheDocument()
  })

  it('displays all conversation information', () => {
    renderWithTheme(<Conversation {...mockProps} />)
    expect(screen.getByText('Test Conversation Topic')).toBeInTheDocument()
    expect(screen.getByText('This is a test conversation description')).toBeInTheDocument()
    expect(screen.getByText('Embedded on https://example.com/embed')).toBeInTheDocument()
    expect(screen.getByText('42 participants')).toBeInTheDocument()
  })

  it('handles click events', () => {
    renderWithTheme(<Conversation {...mockProps} />)
    const card = screen.getByText('Test Conversation Topic').closest('div')
    fireEvent.click(card)
    expect(mockProps.goToConversation).toHaveBeenCalledTimes(1)
  })

  it('does not display parent_url when not provided', () => {
    const propsWithoutUrl = {
      ...mockProps,
      c: { ...mockProps.c, parent_url: null }
    }
    renderWithTheme(<Conversation {...propsWithoutUrl} />)
    expect(screen.queryByText(/Embedded on/)).not.toBeInTheDocument()
  })

  it('handles zero participants correctly', () => {
    const propsWithZeroParticipants = {
      ...mockProps,
      c: { ...mockProps.c, participant_count: 0 }
    }
    renderWithTheme(<Conversation {...propsWithZeroParticipants} />)
    expect(screen.getByText('0 participants')).toBeInTheDocument()
  })
})
