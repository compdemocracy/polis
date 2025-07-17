import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../../theme'
import NumberCard from './conversation-stats-number-card'

// Wrapper to provide theme context
const renderWithTheme = (component) => {
  return render(<ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>)
}

describe('NumberCard', () => {
  it('renders without crashing', () => {
    renderWithTheme(<NumberCard datum={100} subheading="Total Votes" />)
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByText('Total Votes')).toBeInTheDocument()
  })

  it('displays the correct datum value', () => {
    renderWithTheme(<NumberCard datum={42} subheading="Test" />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('displays the correct subheading', () => {
    renderWithTheme(<NumberCard datum={0} subheading="Active Users" />)
    expect(screen.getByText('Active Users')).toBeInTheDocument()
  })

  it('handles zero values', () => {
    renderWithTheme(<NumberCard datum={0} subheading="Zero Test" />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('handles large numbers', () => {
    renderWithTheme(<NumberCard datum={1000000} subheading="Million" />)
    expect(screen.getByText('1000000')).toBeInTheDocument()
  })

  it('renders datum with bold font weight', () => {
    renderWithTheme(<NumberCard datum={123} subheading="Test" />)
    const datumElement = screen.getByText('123')
    expect(datumElement).toHaveStyle('font-weight: 700')
  })
})
