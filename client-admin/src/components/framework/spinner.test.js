import { render } from '@testing-library/react'
import Spinner from './spinner'

describe('Spinner', () => {
  it('renders without crashing', () => {
    const { container } = render(<Spinner />)
    expect(container).toBeInTheDocument()
  })

  it('renders an SVG element', () => {
    const { container } = render(<Spinner />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('has correct SVG dimensions', () => {
    const { container } = render(<Spinner />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '30px')
    expect(svg).toHaveAttribute('height', '30px')
  })

  it('contains animated rect elements', () => {
    const { container } = render(<Spinner />)
    const rects = container.querySelectorAll('rect')
    // Should have 13 rects total (1 background + 12 animated)
    expect(rects).toHaveLength(13)

    // Check that animation elements exist
    const animateElements = container.querySelectorAll('animate')
    expect(animateElements).toHaveLength(12)
  })
})
