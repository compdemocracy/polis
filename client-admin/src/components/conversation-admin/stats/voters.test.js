import { render, screen } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../../theme'
import Voters from './voters'

// Wrapper to provide theme context
const renderWithTheme = (component) => {
  return render(<ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>)
}

describe('Voters', () => {
  it('does not render with empty data', () => {
    const { container } = renderWithTheme(
      <Voters
        firstVoteTimes={[]}
        size={500}
        margin={{ top: 20, right: 20, bottom: 50, left: 70 }}
      />
    )

    // Should not render anything
    expect(container.firstChild).toBeNull()
  })

  it('does not render with single data point', () => {
    const { container } = renderWithTheme(
      <Voters
        firstVoteTimes={[1234567890]}
        size={500}
        margin={{ top: 20, right: 20, bottom: 50, left: 70 }}
      />
    )

    // Should not render anything with only 1 data point
    expect(container.firstChild).toBeNull()
  })

  it('renders chart with multiple data points', () => {
    const { container } = renderWithTheme(
      <Voters
        firstVoteTimes={[1234567890, 1234567900, 1234567910]}
        size={500}
        margin={{ top: 20, right: 20, bottom: 50, left: 70 }}
      />
    )

    // Should render the chart
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByText('Voters over time, by time of first vote')).toBeInTheDocument()

    // Check for Victory chart elements
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('width', '500')
    expect(svg).toHaveAttribute('height', '500')
  })

  it('renders with correct heading', () => {
    renderWithTheme(
      <Voters
        firstVoteTimes={[1234567890, 1234567900]}
        size={500}
        margin={{ top: 20, right: 20, bottom: 50, left: 70 }}
      />
    )

    const heading = screen.getByRole('heading', { level: 6 })
    expect(heading).toHaveTextContent('Voters over time, by time of first vote')
  })

  it('renders chart with correct data transformation', () => {
    const timestamps = [
      new Date('2023-01-01').getTime(),
      new Date('2023-01-02').getTime(),
      new Date('2023-01-03').getTime()
    ]

    const { container } = renderWithTheme(
      <Voters
        firstVoteTimes={timestamps}
        size={500}
        margin={{ top: 20, right: 20, bottom: 50, left: 70 }}
      />
    )

    // Victory renders path elements for the area chart
    const path = container.querySelector('path[role="presentation"]')
    expect(path).toBeInTheDocument()
  })
})
