import React from 'react'
import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import KnowledgeBase from './knowledgeBase'

// Wrapper to provide theme context
const renderWithTheme = (component) => {
  return render(<ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>)
}

describe('KnowledgeBase', () => {
  const mockProps = {
    e: '📖',
    url: 'https://example.com/test',
    txt: 'Test Knowledge Base'
  }

  it('renders without crashing', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} />)
    expect(screen.getByText('Test Knowledge Base')).toBeInTheDocument()
  })

  it('renders the emoji', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} />)
    // react-easy-emoji converts emojis to images, so check for alt text
    const emojiImg = screen.getByAltText('📖')
    expect(emojiImg).toBeInTheDocument()
  })

  it('renders a link with correct href', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.com/test')
  })

  it('opens link in new tab', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('displays the correct text', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} />)
    expect(screen.getByText('Test Knowledge Base')).toBeInTheDocument()
  })

  it('renders with different emoji', () => {
    renderWithTheme(<KnowledgeBase {...mockProps} e="🚀" />)
    const emojiImg = screen.getByAltText('🚀')
    expect(emojiImg).toBeInTheDocument()
  })
})
