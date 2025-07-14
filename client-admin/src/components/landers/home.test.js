import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { BrowserRouter as Router } from 'react-router-dom'
import { ThemeProvider } from 'theme-ui'
import theme from '../../theme'
import Home from './home'

// Mock child components for isolation
jest.mock('./exploreKnowledgeBase', () => {
  const MockComponent = () => <div data-testid="explore-kb-mock">ExploreKnowledgeBase</div>
  MockComponent.displayName = 'MockExploreKnowledgeBase'
  return MockComponent
})

jest.mock('./press', () => {
  const MockComponent = () => <div data-testid="press-mock">Press</div>
  MockComponent.displayName = 'MockPress'
  return MockComponent
})

const AllTheProviders = ({ children }) => {
  return (
    <Router>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </Router>
  )
}

const customRender = (ui, options) => render(ui, { wrapper: AllTheProviders, ...options })

describe('Home component', () => {
  it('renders the main heading', () => {
    customRender(<Home />)
    expect(
      screen.getByRole('heading', { level: 1, name: /Input Crowd, Output Meaning/i })
    ).toBeInTheDocument()
  })

  it('renders the "Get Started" section', () => {
    customRender(<Home />)
    const getStartedSection = screen.getByRole('heading', { name: /Get Started/i }).parentElement
    expect(within(getStartedSection).getByRole('link', { name: /Sign in/i })).toBeInTheDocument()
  })

  it('renders the mocked child components', () => {
    customRender(<Home />)
    expect(screen.getByTestId('explore-kb-mock')).toBeInTheDocument()
    expect(screen.getByTestId('press-mock')).toBeInTheDocument()
  })
})
