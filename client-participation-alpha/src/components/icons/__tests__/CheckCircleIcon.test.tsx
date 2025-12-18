import { render } from '@testing-library/react'
import CheckCircleIcon from '../CheckCircleIcon'

describe('CheckCircleIcon', () => {
  it('should render with default props', () => {
    const { container } = render(<CheckCircleIcon />)
    const svg = container.querySelector('svg')

    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('height', '22')
    expect(svg).toHaveAttribute('width', '22')
    expect(svg).toHaveAttribute('viewBox', '0 0 1792 1792')
  })

  it('should render with custom size', () => {
    const { container } = render(<CheckCircleIcon size={48} />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveAttribute('height', '48')
    expect(svg).toHaveAttribute('width', '48')
  })

  it('should apply custom className', () => {
    const { container } = render(<CheckCircleIcon className="custom-icon" />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveClass('custom-icon')
  })

  it('should use custom fill color', () => {
    const { container } = render(<CheckCircleIcon fill="#ff0000" />)
    const path = container.querySelector('path')

    expect(path).toHaveAttribute('fill', '#ff0000')
  })

  it('should use currentColor as default fill', () => {
    const { container } = render(<CheckCircleIcon />)
    const path = container.querySelector('path')

    expect(path).toHaveAttribute('fill', 'currentColor')
  })

  it('should have accessibility attributes', () => {
    const { container } = render(<CheckCircleIcon />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
  })

  it('should have display block style', () => {
    const { container } = render(<CheckCircleIcon />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveStyle({ display: 'block' })
  })

  it('should contain path element with correct d attribute', () => {
    const { container } = render(<CheckCircleIcon />)
    const path = container.querySelector('path')

    expect(path).toBeInTheDocument()
    expect(path).toHaveAttribute('d')
    expect(path?.getAttribute('d')).toContain('M1299 813')
  })

  it('should render with all custom props', () => {
    const { container } = render(
      <CheckCircleIcon size={32} className="test-class" fill="#00ff00" />
    )
    const svg = container.querySelector('svg')
    const path = container.querySelector('path')

    expect(svg).toHaveAttribute('height', '32')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveClass('test-class')
    expect(path).toHaveAttribute('fill', '#00ff00')
  })
})
