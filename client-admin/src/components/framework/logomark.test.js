import { render } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Logomark from './logomark'

// Wrapper to provide theme context
const renderWithTheme = (component) => {
  return render(<ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>)
}

describe('Logomark', () => {
  it('renders without crashing', () => {
    const { container } = renderWithTheme(<Logomark />)
    expect(container).toBeInTheDocument()
  })

  it('renders an SVG element', () => {
    const { container } = renderWithTheme(<Logomark />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('has correct default width', () => {
    const { container } = renderWithTheme(<Logomark />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '20')
  })

  it('applies custom fill color', () => {
    const { container } = renderWithTheme(<Logomark fill="#ff0000" />)
    const path = container.querySelector('path')
    expect(path).toHaveAttribute('fill', '#ff0000')
  })

  it('applies custom style prop', () => {
    const customStyle = { marginTop: '10px', position: 'absolute' }
    const { container } = renderWithTheme(<Logomark style={customStyle} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveStyle('margin-top: 10px')
    expect(svg).toHaveStyle('position: absolute')
  })
})
